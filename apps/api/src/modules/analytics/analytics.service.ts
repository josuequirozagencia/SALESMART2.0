import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { analyticsExports, analyticsSettings, Database, type TenantTx } from '../../db';
import { ForbiddenError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { csvFile } from '../contacts';
import { OrgDirectoryService, OrgMembersService, pendingPerson } from '../organizations';
import { MAX_RANGE_DAYS, MAX_REPORT_ROWS, type ExportDto, type ExportsQuery, type RangeQuery, type ReportName, type SettingsDto } from './analytics.dto';

/** Quién consulta: con `analytics.view_all` ve a toda la empresa; sin él, solo lo suyo (lo que es de la persona como responsable o vendedora). */
export interface AnalyticsScope {
  readonly userId: string;
  readonly viewAll: boolean;
  /** Tiene el permiso `analytics.export` (para el asesor, además, el administrador no debe haberlo desactivado). */
  readonly canExport: boolean;
  /** Tiene `analytics.manage`: ve el registro de descargas y decide si el asesor puede descargar. */
  readonly canManage: boolean;
}

/** Lo que la interfaz necesita para mostrar el botón de descarga, la pestaña «Descargas» y el interruptor. */
export interface AnalyticsAccess {
  export: boolean;
  manage: boolean;
}

export interface ExportRecord {
  id: string;
  by: { id: string; name: string } | null;
  report: ReportName;
  from: string;
  to: string;
  rows: number;
  scope: 'all' | 'own';
  at: string;
}

export interface Period {
  from: Date;
  to: Date;
}
export interface SummaryView {
  period: { from: string; to: string };
  timezone: string;
  currency: string;
  /** El alcance con que se calculó: `all` (toda la empresa) o `own` (solo lo de la persona). */
  scope: 'all' | 'own';
  leads: number;
  appointments: { total: number; scheduled: number; completed: number; cancelled: number };
  sales: { count: number; cancelled: number; revenue: string; paid: string; balance: string };
  funnel: Array<{ pipeline_id: string; pipeline: string; stage_id: string; stage: string; kind: 'open' | 'won' | 'lost'; count: number; amount: string }>;
  response: { count: number; avg_seconds: number; median_seconds: number };
  /** Por día (en la zona de la empresa): leads nuevos e ingresos de las ventas vigentes. */
  series: Array<{ day: string; leads: number; sales: number; revenue: string }>;
}

export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'person' | 'status';
}
export interface ReportView {
  report: ReportName;
  title: string;
  period: { from: string; to: string };
  timezone: string;
  currency: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  /** Totales de las columnas numéricas o de dinero (texto con 2 decimales), cuando tienen sentido. */
  totals: Record<string, string | number> | null;
  /** Había más filas que el máximo: el resultado está recortado. */
  truncated: boolean;
}

const DAY = 24 * 60 * 60_000;
const num = (v: unknown): number => Number(v ?? 0);
const money = (v: unknown): string => Number(v ?? 0).toFixed(2);
const own = (scope: AnalyticsScope, column: SQL): SQL => (scope.viewAll ? sql`TRUE` : sql`${column} = ${scope.userId}`);

/**
 * Tablero y analítica (M6.5, ADR-51): sólo LEE y agrega lo que ya existe (contactos, citas, ventas, oportunidades, cronómetros de respuesta); no guarda nada. El alcance por persona se
 * aplica AQUÍ en cada consulta (el asesor solo ve lo suyo) y la RLS impide ver otra empresa. Los días se agrupan en la zona horaria de la empresa. Las consultas son parametrizadas.
 * Un reporte sirve igual en pantalla y en CSV: se arma una sola vez y se exporta tal cual.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  /** El periodo pedido o los últimos 30 días; `to` exclusivo; positivo y de un año como máximo. */
  period(q: RangeQuery, now = new Date()): Period {
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) {
      throw new ValidationError([{ path: 'to', code: 'invalid_range', message: `El periodo debe ser positivo y de máximo ${MAX_RANGE_DAYS} días` }]);
    }
    return { from, to };
  }

  // ------------------------------------------------------------------ tablero

  async summary(scope: AnalyticsScope, q: RangeQuery): Promise<SummaryView> {
    const p = this.period(q);
    const [dir, currency] = [await this.directory.current(), await this.directory.currency()];
    const tz = dir.timeZone;
    return this.db.withTenant(async (tx) => {
      const rows = <R,>(r: { rows: R[] }): R[] => r.rows;
      const [leads] = rows(await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts c WHERE c.deleted_at IS NULL AND c.created_at >= ${p.from.toISOString()}::timestamptz AND c.created_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`c.owner_id`)}`));
      const appts = rows(await tx.execute<{ status: string; n: number }>(sql`SELECT a.status, count(*)::int AS n FROM appointments a WHERE a.starts_at >= ${p.from.toISOString()}::timestamptz AND a.starts_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`a.owner_id`)} GROUP BY a.status`));
      const [sales] = rows(await tx.execute<{ active: number; cancelled: number; revenue: string; paid: string }>(sql`
        SELECT count(*) FILTER (WHERE s.status = 'active')::int AS active,
               count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
               COALESCE(sum(s.amount) FILTER (WHERE s.status = 'active'), 0)::text AS revenue,
               COALESCE(sum(pay.paid) FILTER (WHERE s.status = 'active'), 0)::text AS paid
          FROM sales s
          LEFT JOIN LATERAL (SELECT COALESCE(SUM(CASE WHEN x.kind = 'payment' THEN x.amount ELSE -x.amount END), 0) AS paid FROM sale_payments x WHERE x.organization_id = s.organization_id AND x.sale_id = s.id) pay ON TRUE
         WHERE s.created_at >= ${p.from.toISOString()}::timestamptz AND s.created_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`s.seller_id`)}`));
      const funnel = await this.funnelRows(tx, scope, p);
      const [resp] = rows(await tx.execute<{ n: number; avg: string; p50: string }>(sql`
        SELECT count(*)::int AS n, COALESCE(avg(t.response_seconds), 0)::text AS avg, COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.response_seconds), 0)::text AS p50
          FROM response_timers t
         WHERE t.kind = 'first' AND t.stop_reason = 'human_reply' AND t.stopped_at >= ${p.from.toISOString()}::timestamptz AND t.stopped_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`t.owner_id`)}`));
      const leadDays = rows(await tx.execute<{ day: string; n: number }>(sql`SELECT to_char(date_trunc('day', c.created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM contacts c WHERE c.deleted_at IS NULL AND c.created_at >= ${p.from.toISOString()}::timestamptz AND c.created_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`c.owner_id`)} GROUP BY 1`));
      const saleDays = rows(await tx.execute<{ day: string; n: number; revenue: string }>(sql`SELECT to_char(date_trunc('day', s.created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day, count(*)::int AS n, sum(s.amount)::text AS revenue FROM sales s WHERE s.status = 'active' AND s.created_at >= ${p.from.toISOString()}::timestamptz AND s.created_at < ${p.to.toISOString()}::timestamptz AND ${own(scope, sql`s.seller_id`)} GROUP BY 1`));

      const byStatus = new Map(appts.map((a) => [a.status, a.n]));
      const revenue = num(sales?.revenue);
      const paid = num(sales?.paid);
      const days = new Map<string, { leads: number; sales: number; revenue: number }>();
      for (const d of leadDays) days.set(d.day, { leads: d.n, sales: 0, revenue: 0 });
      for (const d of saleDays) days.set(d.day, { ...(days.get(d.day) ?? { leads: 0 }), sales: d.n, revenue: num(d.revenue) });
      return {
        period: { from: p.from.toISOString(), to: p.to.toISOString() },
        timezone: tz,
        currency,
        scope: scope.viewAll ? 'all' : 'own',
        leads: leads?.n ?? 0,
        appointments: { total: [...byStatus.values()].reduce((a, b) => a + b, 0), scheduled: byStatus.get('scheduled') ?? 0, completed: byStatus.get('completed') ?? 0, cancelled: byStatus.get('cancelled') ?? 0 },
        sales: { count: sales?.active ?? 0, cancelled: sales?.cancelled ?? 0, revenue: money(revenue), paid: money(paid), balance: money(Math.max(revenue - paid, 0)) },
        funnel: funnel.map((f) => ({ pipeline_id: f.pipeline_id, pipeline: f.pipeline, stage_id: f.stage_id, stage: f.stage, kind: f.kind, count: f.n, amount: money(f.amount) })),
        response: { count: resp?.n ?? 0, avg_seconds: Math.round(num(resp?.avg)), median_seconds: Math.round(num(resp?.p50)) },
        series: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, leads: v.leads, sales: v.sales, revenue: money(v.revenue) })),
      };
    });
  }

  /** Oportunidades por etapa: las abiertas, las que hay AHORA; las ganadas y perdidas, las que se cerraron dentro del periodo. */
  private async funnelRows(tx: TenantTx, scope: AnalyticsScope, p: Period) {
    const res = await tx.execute<{ pipeline_id: string; pipeline: string; stage_id: string; stage: string; kind: 'open' | 'won' | 'lost'; n: number; amount: string }>(sql`
      SELECT pl.id AS pipeline_id, pl.name AS pipeline, st.id AS stage_id, st.name AS stage, st.kind, count(o.id)::int AS n, COALESCE(sum(o.amount), 0)::text AS amount
        FROM pipeline_stages st
        JOIN pipelines pl ON pl.organization_id = st.organization_id AND pl.id = st.pipeline_id AND pl.deleted_at IS NULL
        LEFT JOIN opportunities o ON o.organization_id = st.organization_id AND o.stage_id = st.id AND o.deleted_at IS NULL
             AND (st.kind = 'open' OR (o.closed_at >= ${p.from.toISOString()}::timestamptz AND o.closed_at < ${p.to.toISOString()}::timestamptz))
             AND ${own(scope, sql`o.owner_id`)}
       WHERE st.deleted_at IS NULL
       GROUP BY pl.id, pl.name, pl.position, st.id, st.name, st.kind, st.position
       ORDER BY pl.position, st.position`);
    return res.rows;
  }

  // ------------------------------------------------------------------ reportes

  async report(scope: AnalyticsScope, name: ReportName, q: RangeQuery): Promise<ReportView> {
    const p = this.period(q);
    const [dir, currency] = [await this.directory.current(), await this.directory.currency()];
    const view = await this.db.withTenant((tx) => this.build(tx, scope, name, p, dir.timeZone, currency));
    return this.members.hydrate(view);
  }

  /** CSV del mismo reporte que se ve en pantalla (BOM, anti-fórmulas). Se lee y se AUDITA en una sola transacción: no hay descarga sin rastro. */
  async export(scope: AnalyticsScope, q: ExportDto): Promise<{ filename: string; csv: string; count: number }> {
    const p = this.period(q);
    const [dir, currency] = [await this.directory.current(), await this.directory.currency()];
    const view = await this.db.withTenant(async (tx) => {
      if (!(await this.canExport(tx, scope))) throw new ForbiddenError('EXPORT_DISABLED', 'La descarga de reportes no está habilitada para tu usuario. Pídele al administrador que la active');
      const v = await this.build(tx, scope, q.report, p, dir.timeZone, currency);
      const id = uuidv7();
      const sc = scope.viewAll ? 'all' : 'own';
      await tx.insert(analyticsExports).values({ id, userId: scope.userId, report: q.report, fromAt: p.from, toAt: p.to, rowCount: v.rows.length, scope: sc });
      await writeAudit(tx, {
        entityType: 'analytics_export',
        entityId: id,
        newValue: { report: q.report, from: p.from.toISOString(), to: p.to.toISOString(), count: v.rows.length, scope: sc, by: TenantContext.current().userId ?? null },
        source: 'manual',
      });
      return v;
    });
    const full = await this.members.hydrate(view);
    const cell = (v: unknown): unknown => (v && typeof v === 'object' && 'name' in v ? (v as { name: string }).name : v);
    const csv = csvFile([full.columns.map((c) => c.label), ...full.rows.map((r) => full.columns.map((c) => cell(r[c.key])))]);
    const day = new Date().toISOString().slice(0, 10);
    return { filename: `${q.report}-${day}.csv`, csv, count: full.rows.length };
  }

  // ------------------------------------------------------------------ descargas: permiso, interruptor y registro

  /** ¿El asesor puede descargar? Sin fila de ajustes rige el valor por omisión: sí. */
  private async advisorExport(tx: TenantTx): Promise<boolean> {
    const [row] = await tx.select({ on: analyticsSettings.advisorExport }).from(analyticsSettings).limit(1);
    return row?.on ?? true;
  }

  /** Con el permiso; quien ve toda la empresa (el administrador) siempre, y quien ve solo lo suyo (el asesor) mientras el administrador no lo desactive. */
  private async canExport(tx: TenantTx, scope: AnalyticsScope): Promise<boolean> {
    if (!scope.canExport) return false;
    return scope.viewAll || (await this.advisorExport(tx));
  }

  async access(scope: AnalyticsScope): Promise<AnalyticsAccess> {
    if (!scope.canExport) return { export: false, manage: scope.canManage };
    if (scope.viewAll) return { export: true, manage: scope.canManage };
    return this.db.withTenant(async (tx) => ({ export: await this.advisorExport(tx), manage: scope.canManage }));
  }

  async settings(): Promise<{ advisor_export: boolean }> {
    return this.db.withTenant(async (tx) => ({ advisor_export: await this.advisorExport(tx) }));
  }

  /** Activa o desactiva la descarga para el asesor. Queda en la auditoría con quién lo cambió. */
  async updateSettings(dto: SettingsDto): Promise<{ advisor_export: boolean }> {
    const userId = TenantContext.current().userId ?? null;
    return this.db.withTenant(async (tx) => {
      const [row] = await tx.select({ id: analyticsSettings.id, on: analyticsSettings.advisorExport }).from(analyticsSettings).limit(1);
      const before = row?.on ?? true;
      if (row) await tx.update(analyticsSettings).set({ advisorExport: dto.advisor_export, updatedBy: userId, updatedAt: new Date() }).where(eq(analyticsSettings.id, row.id));
      else await tx.insert(analyticsSettings).values({ advisorExport: dto.advisor_export, updatedBy: userId });
      if (before !== dto.advisor_export) {
        await writeAudit(tx, { entityType: 'analytics_settings', entityId: row?.id ?? uuidv7(), field: 'advisor_export', oldValue: before, newValue: dto.advisor_export, source: 'manual' });
      }
      return { advisor_export: dto.advisor_export };
    });
  }

  /** Registro de descargas, de la más reciente a la más antigua (cursor). Solo lo lee quien tiene `analytics.manage`. */
  async exportsLog(q: ExportsQuery): Promise<{ items: ExportRecord[]; next_cursor: string | null }> {
    const limit = q.limit ?? 30;
    const cur = this.decodeCursor(q.cursor);
    const rows = await this.db.withTenant((tx) =>
      tx
        .select({ id: analyticsExports.id, userId: analyticsExports.userId, report: analyticsExports.report, fromAt: analyticsExports.fromAt, toAt: analyticsExports.toAt, rowCount: analyticsExports.rowCount, scope: analyticsExports.scope, createdAt: analyticsExports.createdAt })
        .from(analyticsExports)
        .where(cur ? or(lt(analyticsExports.createdAt, cur.at), and(eq(analyticsExports.createdAt, cur.at), lt(analyticsExports.id, cur.id))) : undefined)
        .orderBy(desc(analyticsExports.createdAt), desc(analyticsExports.id))
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    const items = page.map((r) => ({ id: r.id, by: pendingPerson(r.userId), report: r.report as ReportName, from: r.fromAt.toISOString(), to: r.toAt.toISOString(), rows: r.rowCount, scope: r.scope as 'all' | 'own', at: r.createdAt.toISOString() }));
    const last = rows.length > limit ? page.at(-1) : undefined;
    return { items: await this.members.hydrate(items), next_cursor: last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null };
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }

  private async build(tx: TenantTx, scope: AnalyticsScope, name: ReportName, p: Period, tz: string, currency: string): Promise<ReportView> {
    const base = { report: name, period: { from: p.from.toISOString(), to: p.to.toISOString() }, timezone: tz, currency };
    const from = p.from.toISOString();
    const to = p.to.toISOString();
    const cap = MAX_REPORT_ROWS + 1;
    switch (name) {
      case 'sales': {
        const res = await tx.execute<{ created: string; contact: string; seller_id: string; product: string; quantity: number; amount: string; paid: string; status: string }>(sql`
          SELECT to_char(s.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS created, c.name AS contact, s.seller_id, s.product_name AS product, s.quantity, s.amount::text AS amount,
                 COALESCE(pay.paid, 0)::text AS paid, s.status
            FROM sales s
            JOIN contacts c ON c.organization_id = s.organization_id AND c.id = s.contact_id
            LEFT JOIN LATERAL (SELECT SUM(CASE WHEN x.kind = 'payment' THEN x.amount ELSE -x.amount END) AS paid FROM sale_payments x WHERE x.organization_id = s.organization_id AND x.sale_id = s.id) pay ON TRUE
           WHERE s.created_at >= ${from}::timestamptz AND s.created_at < ${to}::timestamptz AND ${own(scope, sql`s.seller_id`)}
           ORDER BY s.created_at DESC, s.id DESC LIMIT ${cap}`);
        const truncated = res.rows.length > MAX_REPORT_ROWS;
        const rows = res.rows.slice(0, MAX_REPORT_ROWS).map((r) => {
          const active = r.status === 'active';
          return { created: r.created, contact: r.contact, seller: pendingPerson(r.seller_id), product: r.product, quantity: r.quantity, amount: money(r.amount), paid: money(r.paid), balance: active ? money(Math.max(num(r.amount) - num(r.paid), 0)) : '0.00', status: active ? 'Vigente' : 'Anulada' };
        });
        const act = res.rows.slice(0, MAX_REPORT_ROWS).filter((r) => r.status === 'active');
        return {
          ...base,
          title: 'Ventas',
          columns: [
            { key: 'created', label: 'Fecha', type: 'date' }, { key: 'contact', label: 'Cliente', type: 'text' }, { key: 'seller', label: 'Vendedor', type: 'person' }, { key: 'product', label: 'Producto', type: 'text' },
            { key: 'quantity', label: 'Cantidad', type: 'number' }, { key: 'amount', label: 'Total', type: 'money' }, { key: 'paid', label: 'Cobrado', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'money' }, { key: 'status', label: 'Estado', type: 'status' },
          ],
          rows,
          totals: { amount: money(act.reduce((a, r) => a + num(r.amount), 0)), paid: money(act.reduce((a, r) => a + num(r.paid), 0)), balance: money(act.reduce((a, r) => a + Math.max(num(r.amount) - num(r.paid), 0), 0)), quantity: act.reduce((a, r) => a + r.quantity, 0) },
          truncated,
        };
      }
      case 'appointments': {
        const res = await tx.execute<{ starts: string; contact: string; owner_id: string; kind: string; duration: number; status: string; sent: number; total: number }>(sql`
          SELECT to_char(a.starts_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS starts, c.name AS contact, a.owner_id, a.kind, a.duration_minutes AS duration, a.status,
                 (SELECT count(*)::int FROM appointment_reminders r WHERE r.organization_id = a.organization_id AND r.appointment_id = a.id AND r.status = 'sent') AS sent,
                 (SELECT count(*)::int FROM appointment_reminders r WHERE r.organization_id = a.organization_id AND r.appointment_id = a.id AND r.status <> 'cancelled') AS total
            FROM appointments a
            JOIN contacts c ON c.organization_id = a.organization_id AND c.id = a.contact_id
           WHERE a.starts_at >= ${from}::timestamptz AND a.starts_at < ${to}::timestamptz AND ${own(scope, sql`a.owner_id`)}
           ORDER BY a.starts_at, a.id LIMIT ${cap}`);
        const labels: Record<string, string> = { scheduled: 'Agendada', completed: 'Completada', cancelled: 'Cancelada' };
        const truncated = res.rows.length > MAX_REPORT_ROWS;
        const rows = res.rows.slice(0, MAX_REPORT_ROWS).map((r) => ({ starts: r.starts, contact: r.contact, owner: pendingPerson(r.owner_id), kind: r.kind, duration: r.duration, status: labels[r.status] ?? r.status, reminders: `${r.sent}/${r.total}` }));
        return {
          ...base,
          title: 'Citas',
          columns: [
            { key: 'starts', label: 'Fecha y hora', type: 'date' }, { key: 'contact', label: 'Cliente', type: 'text' }, { key: 'owner', label: 'Responsable', type: 'person' }, { key: 'kind', label: 'Tipo', type: 'text' },
            { key: 'duration', label: 'Duración (min)', type: 'number' }, { key: 'status', label: 'Estado', type: 'status' }, { key: 'reminders', label: 'Recordatorios enviados', type: 'text' },
          ],
          rows,
          totals: { duration: res.rows.slice(0, MAX_REPORT_ROWS).reduce((a, r) => a + r.duration, 0) },
          truncated,
        };
      }
      case 'funnel': {
        const f = await this.funnelRows(tx, scope, p);
        const kindLabel = { open: 'Abierta', won: 'Ganada', lost: 'Perdida' } as const;
        return {
          ...base,
          title: 'Embudo',
          columns: [
            { key: 'pipeline', label: 'Pipeline', type: 'text' }, { key: 'stage', label: 'Etapa', type: 'text' }, { key: 'kind', label: 'Tipo de etapa', type: 'status' },
            { key: 'count', label: 'Oportunidades', type: 'number' }, { key: 'amount', label: 'Valor', type: 'money' },
          ],
          rows: f.map((r) => ({ pipeline: r.pipeline, stage: r.stage, kind: kindLabel[r.kind], count: r.n, amount: money(r.amount) })),
          totals: { count: f.reduce((a, r) => a + r.n, 0), amount: money(f.reduce((a, r) => a + num(r.amount), 0)) },
          truncated: false,
        };
      }
      case 'advisors': {
        const res = await tx.execute<{ user_id: string; leads: number; appointments: number; sales: number; revenue: string; avg_response: string }>(sql`
          WITH people AS (
            SELECT owner_id AS user_id FROM contacts WHERE owner_id IS NOT NULL AND deleted_at IS NULL AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz
            UNION SELECT owner_id FROM appointments WHERE starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
            UNION SELECT seller_id FROM sales WHERE created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz
            UNION SELECT owner_id FROM response_timers WHERE kind = 'first' AND stop_reason = 'human_reply' AND stopped_at >= ${from}::timestamptz AND stopped_at < ${to}::timestamptz AND owner_id IS NOT NULL
          )
          SELECT * FROM (
          SELECT p.user_id,
                 (SELECT count(*)::int FROM contacts c WHERE c.owner_id = p.user_id AND c.deleted_at IS NULL AND c.created_at >= ${from}::timestamptz AND c.created_at < ${to}::timestamptz) AS leads,
                 (SELECT count(*)::int FROM appointments a WHERE a.owner_id = p.user_id AND a.status <> 'cancelled' AND a.starts_at >= ${from}::timestamptz AND a.starts_at < ${to}::timestamptz) AS appointments,
                 (SELECT count(*)::int FROM sales s WHERE s.seller_id = p.user_id AND s.status = 'active' AND s.created_at >= ${from}::timestamptz AND s.created_at < ${to}::timestamptz) AS sales,
                 (SELECT COALESCE(sum(s.amount), 0)::text FROM sales s WHERE s.seller_id = p.user_id AND s.status = 'active' AND s.created_at >= ${from}::timestamptz AND s.created_at < ${to}::timestamptz) AS revenue,
                 (SELECT COALESCE(avg(t.response_seconds), 0)::text FROM response_timers t WHERE t.owner_id = p.user_id AND t.kind = 'first' AND t.stop_reason = 'human_reply' AND t.stopped_at >= ${from}::timestamptz AND t.stopped_at < ${to}::timestamptz) AS avg_response
            FROM people p
           WHERE ${own(scope, sql`p.user_id`)}
          ) q ORDER BY q.revenue::numeric DESC, q.user_id`);
        const rows = res.rows.map((r) => ({ advisor: pendingPerson(r.user_id), leads: r.leads, appointments: r.appointments, sales: r.sales, revenue: money(r.revenue), avg_response: Math.round(num(r.avg_response)) }));
        return {
          ...base,
          title: 'Asesores',
          columns: [
            { key: 'advisor', label: 'Asesor', type: 'person' }, { key: 'leads', label: 'Contactos nuevos', type: 'number' }, { key: 'appointments', label: 'Citas', type: 'number' },
            { key: 'sales', label: 'Ventas', type: 'number' }, { key: 'revenue', label: 'Ingresos', type: 'money' }, { key: 'avg_response', label: 'Primera respuesta promedio (s)', type: 'number' },
          ],
          rows,
          totals: { leads: rows.reduce((a, r) => a + r.leads, 0), appointments: rows.reduce((a, r) => a + r.appointments, 0), sales: rows.reduce((a, r) => a + r.sales, 0), revenue: money(rows.reduce((a, r) => a + num(r.revenue), 0)) },
          truncated: false,
        };
      }
    }
  }
}
