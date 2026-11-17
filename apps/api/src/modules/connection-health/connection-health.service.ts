import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { channelAccounts, Database, notifications, qrAccounts, webhookEvents, whatsappAccounts, type TenantTx } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { businessSecondsBetween, SlaService } from '../sla';
import { ALERT_LAG_WINDOW_MS, alertReasons, BACKLOG_S, describeError, HEALTH_WINDOW_MS, judge, type AlertReason, type HealthFacts, type HealthLevel, type HealthReason } from './health-model';

const DAY_MS = 86_400_000;
const FAILED_LIST_LIMIT = 10;

export type ConnectionKind = 'whatsapp_official' | 'whatsapp_qr' | 'ghl';

export interface FailedEventView {
  id: string;
  received_at: string;
  attempts: number;
  /** Lo que falló, en palabras de la persona. */
  reason: string;
  /** ¿Se puede reintentar? No si el contenido ya se borró (privacidad, a los 30 días). */
  retryable: boolean;
}

export interface ConnectionHealthView {
  id: string;
  name: string;
  kind: ConnectionKind;
  /** `active` o `inactive`. */
  status: string;
  /** Solo por QR: el estado de la sesión y desde cuándo está caída. */
  session: { state: string; down_since: string | null } | null;
  /** Último aviso recibido de esta conexión (del proveedor). */
  last_event_at: string | null;
  /** Mensajes entrantes de las últimas 24 h y cuánto tardaron en entrar frente a la hora que informó el proveedor. */
  inbound_24h: { count: number; lag_median_s: number | null; lag_p95_s: number | null; lag_max_s: number | null; last_at: string | null };
  /** El retraso mediano de los últimos 30 minutos (con al menos 3 mensajes): lo que decide el nivel. */
  recent_lag_median_s: number | null;
  events: { pending: number; overdue: number; failed: number };
  /** Avisos ignorados en las últimas 24 h, por motivo. */
  ignored_24h: Record<string, number>;
  failed_events: FailedEventView[];
  level: HealthLevel;
  reasons: HealthReason[];
}

export interface HealthList {
  generated_at: string;
  connections: ConnectionHealthView[];
}

interface Computed {
  view: ConnectionHealthView;
  facts: HealthFacts;
}

type LagRow = { channel: string; n: number; p50: number | null; p95: number | null; max: number | null; last_at: Date | null; recent_n: number; recent_p50: number | null };
type EventRow = { channel: string; pending: number; overdue: number; failed: number; last_event: Date | null };
type IgnoredRow = { channel: string; reason: string; n: number };

const kindOf = (provider: string): ConnectionKind | null => (provider === 'meta_cloud' ? 'whatsapp_official' : provider === 'evolution' ? 'whatsapp_qr' : provider === 'ghl' ? 'ghl' : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/**
 * Salud de las conexiones (v19 B1/B4). Para cada conexión de la empresa: el último aviso recibido, cuánto tardan en entrar los mensajes frente a la hora que informa el proveedor (mediana, P95 y máximo de 24 h
 * y la mediana reciente), los avisos del webhook pendientes y fallidos —con su motivo en español y «Reintentar»—, lo que se ignoró por motivo y un nivel (ok, atención, crítico) con sus razones. Todo sale de lo que
 * ya se guarda; solo cifras: ni teléfonos ni textos. {@link alertPass} avisa al administrador (centro de avisos) cuando una conexión necesita atención y retira el aviso cuando se resuelve.
 */
@Injectable()
export class ConnectionHealthService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  async list(now = new Date()): Promise<HealthList> {
    const tz = (await this.directory.current()).timeZone;
    const connections = await this.db.withTenant(async (tx) => (await this.compute(tx, tz, now)).map((c) => c.view));
    return { generated_at: now.toISOString(), connections };
  }

  /** Vuelve a poner en cola un aviso FALLIDO (agotó sus intentos). Solo si su contenido sigue guardado; queda auditado. */
  async retry(eventId: string, now = new Date()): Promise<{ id: string; status: 'pending' }> {
    return this.db.withTenant(async (tx) => {
      const [ev] = await tx.select({ id: webhookEvents.id, status: webhookEvents.status, hasPayload: sql<boolean>`${webhookEvents.payload} IS NOT NULL` }).from(webhookEvents).where(eq(webhookEvents.id, eventId)).for('update').limit(1);
      if (!ev) throw new NotFoundError();
      if (ev.status !== 'failed') throw new ConflictError('EVENT_NOT_FAILED', 'Ese aviso no está fallido: no hace falta reintentarlo');
      if (!ev.hasPayload) throw new ConflictError('EVENT_REDACTED', 'El contenido de ese aviso ya se borró por privacidad (a los 30 días): no se puede reintentar');
      await tx.update(webhookEvents).set({ status: 'pending', attempts: 0, nextAttemptAt: now, processedAt: null, lastError: null }).where(eq(webhookEvents.id, eventId));
      await writeAudit(tx, { entityType: 'webhook_event', entityId: eventId, field: 'retried', oldValue: 'failed', newValue: 'pending', source: 'manual' });
      return { id: eventId, status: 'pending' as const };
    });
  }

  /**
   * Una pasada de alertas para la empresa del contexto: a quienes administran las conexiones (`channels.manage`) les llega UNA alerta por conexión y motivo (sin leer no se acumulan), y las que
   * dejaron de aplicar se dan por leídas para que un problema nuevo vuelva a avisar. Devuelve cuántas alertas nuevas creó.
   */
  async alertPass(now: Date): Promise<number> {
    const tz = (await this.directory.current()).timeZone;
    const admins = await this.members.withPermission('channels.manage'); // identidad: se lee ANTES de la transacción de negocio
    return this.db.withTenant(async (tx) => {
      const computed = await this.compute(tx, tz, now);
      const active = new Set<string>();
      let created = 0;
      for (const c of computed) {
        if (c.view.status !== 'active') continue;
        for (const reason of alertReasons(c.facts)) {
          active.add(`${c.view.id}:${reason}`);
          if (admins.length === 0) continue;
          const inserted = await tx.insert(notifications).values(admins.map((userId) => ({ userId, type: 'connection_health', channelAccountId: c.view.id, alertReason: reason }))).onConflictDoNothing().returning({ id: notifications.id });
          created += inserted.length;
        }
      }
      // Lo que ya no aplica se da por leído (y la próxima vez que vuelva a pasar, avisará otra vez)
      const open = await tx.select({ id: notifications.id, channel: notifications.channelAccountId, reason: notifications.alertReason }).from(notifications).where(and(eq(notifications.type, 'connection_health'), isNull(notifications.readAt)));
      const stale = open.filter((o) => !active.has(`${o.channel}:${o.reason}`)).map((o) => o.id);
      if (stale.length > 0) await tx.update(notifications).set({ readAt: now }).where(inArray(notifications.id, stale));
      return created;
    });
  }

  // ------------------------------------------------------------------ cálculo

  private async compute(tx: TenantTx, timeZone: string, now: Date): Promise<Computed[]> {
    const conns = await tx
      .select({ id: channelAccounts.id, name: channelAccounts.name, provider: channelAccounts.provider, status: channelAccounts.status })
      .from(channelAccounts)
      .where(and(isNull(channelAccounts.deletedAt), inArray(channelAccounts.provider, ['meta_cloud', 'evolution', 'ghl'])))
      .orderBy(channelAccounts.name);
    if (conns.length === 0) return [];
    const nowIso = now.toISOString();
    const since24 = new Date(now.getTime() - HEALTH_WINDOW_MS).toISOString();
    const sinceRecent = new Date(now.getTime() - ALERT_LAG_WINDOW_MS).toISOString();
    const since7d = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const since30d = new Date(now.getTime() - 30 * DAY_MS).toISOString();

    const lags = (
      await tx.execute<LagRow>(sql`
        SELECT m.channel_account_id AS channel,
               count(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (m.created_at - m.sent_at))) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (m.created_at - m.sent_at))) AS p95,
               max(extract(epoch FROM (m.created_at - m.sent_at))) AS max,
               max(m.created_at) AS last_at,
               count(*) FILTER (WHERE m.created_at > ${sinceRecent}::timestamptz)::int AS recent_n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (m.created_at - m.sent_at))) FILTER (WHERE m.created_at > ${sinceRecent}::timestamptz) AS recent_p50
          FROM messages m
         WHERE m.direction = 'in' AND m.kind <> 'note' AND m.sent_at IS NOT NULL AND m.meta->>'recovered' IS NULL AND m.created_at > ${since24}::timestamptz
         GROUP BY m.channel_account_id`)
    ).rows;
    const events = (
      await tx.execute<EventRow>(sql`
        SELECT channel_account_id AS channel,
               count(*) FILTER (WHERE status = 'pending')::int AS pending,
               count(*) FILTER (WHERE status = 'pending' AND next_attempt_at < ${nowIso}::timestamptz - (${BACKLOG_S}::int * interval '1 second'))::int AS overdue,
               count(*) FILTER (WHERE status = 'failed' AND received_at > ${since7d}::timestamptz)::int AS failed,
               max(received_at) AS last_event
          FROM webhook_events WHERE received_at > ${since30d}::timestamptz GROUP BY channel_account_id`)
    ).rows;
    const ignored = (await tx.execute<IgnoredRow>(sql`SELECT channel_account_id AS channel, reason, sum(n)::int AS n FROM webhook_ignored WHERE hour > ${since24}::timestamptz GROUP BY channel_account_id, reason`)).rows;
    const failedRows = await tx
      .select({ id: webhookEvents.id, channel: webhookEvents.channelAccountId, receivedAt: webhookEvents.receivedAt, attempts: webhookEvents.attempts, lastError: webhookEvents.lastError, hasPayload: sql<boolean>`${webhookEvents.payload} IS NOT NULL` })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.status, 'failed'), gt(webhookEvents.receivedAt, new Date(since7d))))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(100);
    const qr = new Map((await tx.select({ id: qrAccounts.channelAccountId, state: qrAccounts.state, lastEventAt: qrAccounts.lastEventAt, connectedAt: qrAccounts.connectedAt, downSince: qrAccounts.downSince }).from(qrAccounts)).map((q) => [q.id, q]));
    const meta = new Map((await tx.select({ id: whatsappAccounts.channelAccountId, lastEventAt: whatsappAccounts.lastEventAt }).from(whatsappAccounts)).map((w) => [w.id, w.lastEventAt]));
    const cal = (await this.sla.calendars(tx, timeZone)).forQueue(null);

    return conns.flatMap((c): Computed[] => {
      const kind = kindOf(c.provider);
      if (!kind) return [];
      const lag = lags.find((l) => l.channel === c.id);
      const ev = events.find((e) => e.channel === c.id);
      const q = qr.get(c.id);
      const lastEvent = [ev?.last_event ?? null, q?.lastEventAt ?? null, meta.get(c.id) ?? null].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      // Horas de horario laboral sin recibir NADA, desde el último aviso (o desde que la sesión se conectó, si aún no llegó ninguno)
      const ref = lastEvent ?? q?.connectedAt ?? null;
      const silentBusinessHours = q && ref ? Math.round((businessSecondsBetween(cal, ref, now) / 3600) * 10) / 10 : null;
      const recentN = lag?.recent_n ?? 0;
      const facts: HealthFacts = {
        lagCount: recentN,
        lagMedianS: recentN > 0 && lag?.recent_p50 !== null && lag?.recent_p50 !== undefined ? Number(lag.recent_p50) : null,
        overdueEvents: ev?.overdue ?? 0,
        failedEvents: ev?.failed ?? 0,
        sessionState: (q?.state as HealthFacts['sessionState'] | undefined) ?? null,
        silentBusinessHours,
      };
      const verdict = c.status === 'active' ? judge(facts) : { level: 'ok' as const, reasons: [] as HealthReason[] };
      const ign: Record<string, number> = {};
      for (const r of ignored) if (r.channel === c.id) ign[r.reason] = Number(r.n);
      const view: ConnectionHealthView = {
        id: c.id,
        name: c.name,
        kind,
        status: c.status,
        session: q ? { state: q.state, down_since: q.downSince?.toISOString() ?? null } : null,
        last_event_at: lastEvent?.toISOString() ?? null,
        inbound_24h: { count: lag?.n ?? 0, lag_median_s: num(lag?.p50), lag_p95_s: num(lag?.p95), lag_max_s: num(lag?.max), last_at: lag?.last_at ? new Date(lag.last_at).toISOString() : null },
        recent_lag_median_s: recentN >= 3 && facts.lagMedianS !== null ? num(facts.lagMedianS) : null,
        events: { pending: ev?.pending ?? 0, overdue: ev?.overdue ?? 0, failed: ev?.failed ?? 0 },
        ignored_24h: ign,
        failed_events: failedRows
          .filter((f) => f.channel === c.id)
          .slice(0, FAILED_LIST_LIMIT)
          .map((f) => ({ id: f.id, received_at: f.receivedAt.toISOString(), attempts: f.attempts, reason: describeError(f.lastError), retryable: f.hasPayload })),
        level: verdict.level,
        reasons: [...verdict.reasons],
      };
      return [{ view, facts }];
    });
  }
}

export type { AlertReason };
