import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { campaignRecipients, contacts, Database } from '../../db';
import { ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { csvFile } from '../contacts';
import { OrgDirectoryService } from '../organizations';
import type { ResultsQuery, SummaryQuery } from './campaigns.dto';
import { MAX_SUMMARY_DAYS } from './campaigns.dto';
import { CampaignsService, type CampaignAccess, type CampaignView } from './campaigns.service';

const DAY = 86_400_000;

/** Cuántos destinatarios cabían como máximo en una campaña (el tope de la audiencia): el CSV las trae todas de una vez. */
const EXPORT_MAX = 5000;

export interface RecipientView {
  id: string;
  contact: { id: string; name: string };
  phone: string | null;
  status: string;
  skip_reason: string | null;
  error: string | null;
  queued_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  failed_at: string | null;
  opted_out_at: string | null;
}

export interface ResultsSummary {
  /** Cuántos destinatarios tiene la campaña (los omitidos incluidos). */
  recipients: number;
  /** Acumulados: un mensaje leído también fue entregado y enviado. */
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  /** Lo que aún no salió (pendientes y en cola). */
  waiting: number;
  skipped_by_reason: Record<string, number>;
  /** Cuántos pidieron la baja respondiendo a esta campaña. */
  opted_out: number;
  /** Entregados ÷ enviados, de 0 a 1; null mientras no haya enviados. */
  delivery_rate: number | null;
  /** Respondieron ÷ enviados, de 0 a 1; null mientras no haya enviados. */
  reply_rate: number | null;
}

export interface ResultsView {
  campaign: CampaignView;
  summary: ResultsSummary;
  items: RecipientView[];
  next_cursor: string | null;
}

export interface CampaignsSummaryView {
  period: { from: string; to: string };
  campaigns: number;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  opted_out: number;
  delivery_rate: number | null;
  reply_rate: number | null;
  /** Solo lo propio, o toda la empresa (quien tiene `campaigns.view_all`). */
  scope: 'own' | 'all';
}

const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', queued: 'En cola', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', replied: 'Respondió', failed: 'Fallido', skipped: 'Omitido' };
const SKIP_LABEL: Record<string, string> = {
  revoked: 'No contactar',
  no_consent: 'Sin consentimiento',
  no_phone: 'Sin teléfono',
  duplicate: 'Teléfono repetido',
  out_of_scope: 'Fuera de tu alcance',
  excluded: 'Excluido a mano',
  missing_variable: 'Falta un dato del contacto',
  cancelled: 'Campaña cancelada',
};

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
const encode = (id: string): string => Buffer.from(id).toString('base64url');
function decode(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = Buffer.from(raw, 'base64url').toString('utf8');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  return id;
}

/**
 * El informe de las campañas (v17 · 17.5, ADR-72): resultados por campaña y por destinatario, el CSV y el resumen del periodo para Analítica. Todo se DERIVA de los destinatarios y de sus
 * mensajes (no hay contadores guardados) y respeta quién ve qué: el asesor solo las campañas que creó; quien tiene `campaigns.view_all`, todas. Para campañas de otra empresa o ajenas, 404 uniforme.
 */
@Injectable()
export class CampaignResultsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CampaignsService) private readonly campaigns: CampaignsService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async results(a: CampaignAccess, id: string, q: ResultsQuery): Promise<ResultsView> {
    const campaign = await this.campaigns.get(a, id); // 404 si no es suya o no existe; 403 si el plan no la incluye
    const cursor = decode(q.cursor);
    return this.db.withTenant(async (tx) => {
      const optedOut = sql<boolean>`(${campaignRecipients.optedOutAt} IS NOT NULL)`;
      const by = await tx
        .select({ status: campaignRecipients.status, reason: campaignRecipients.skipReason, optedOut, n: count() })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, id))
        .groupBy(campaignRecipients.status, campaignRecipients.skipReason, optedOut);
      const rows = await tx
        .select({ r: campaignRecipients, name: contacts.name })
        .from(campaignRecipients)
        .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
        .where(and(eq(campaignRecipients.campaignId, id), q.status ? eq(campaignRecipients.status, q.status) : undefined, cursor ? gt(campaignRecipients.id, cursor) : undefined))
        .orderBy(asc(campaignRecipients.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { campaign, summary: summarize(by), items: page.map((x) => view(x.r, x.name)), next_cursor: rows.length > q.limit && page.length > 0 ? encode(page[page.length - 1]!.r.id) : null };
    });
  }

  /** El CSV de los destinatarios (BOM, anti-fórmulas). Se lee y se AUDITA en la misma transacción: no hay descarga sin rastro. */
  async exportCsv(a: CampaignAccess, id: string): Promise<{ filename: string; csv: string; count: number }> {
    const campaign = await this.campaigns.get(a, id);
    const tz = (await this.directory.current()).timeZone;
    const rows = await this.db.withTenant(async (tx) => {
      const found = await tx
        .select({ r: campaignRecipients, name: contacts.name })
        .from(campaignRecipients)
        .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
        .where(eq(campaignRecipients.campaignId, id))
        .orderBy(asc(campaignRecipients.id))
        .limit(EXPORT_MAX);
      // En la auditoría solo van la campaña, cuántas filas y quién: nunca nombres, teléfonos ni textos
      await writeAudit(tx, { entityType: 'campaign', entityId: id, field: 'exported', newValue: { count: found.length, by: TenantContext.current().userId ?? null }, source: 'manual' });
      return found;
    });
    const when = (d: Date | null): string => (d ? fmt(d, tz) : '');
    const csv = csvFile([
      ['Contacto', 'Teléfono', 'Estado', 'Motivo de omisión', 'En cola', 'Enviado', 'Entregado', 'Leído', 'Respondió', 'Falló', 'Error', 'Pidió la baja'],
      ...rows.map(({ r, name }) => [name, r.phone ?? '', STATUS_LABEL[r.status] ?? r.status, r.skipReason ? (SKIP_LABEL[r.skipReason] ?? r.skipReason) : '', when(r.queuedAt), when(r.sentAt), when(r.deliveredAt), when(r.readAt), when(r.repliedAt), when(r.failedAt), r.error ?? '', r.optedOutAt ? 'Sí' : '']),
    ]);
    const slug = campaign.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campana';
    return { filename: `campana-${slug}-${new Date().toISOString().slice(0, 10)}.csv`, csv, count: rows.length };
  }

  /** El resumen del periodo para la tarjeta de Analítica: campañas lanzadas en el periodo y lo que dieron. Solo las propias, o todas con `campaigns.view_all`. */
  async summary(a: CampaignAccess, q: SummaryQuery, now = new Date()): Promise<CampaignsSummaryView> {
    await this.campaigns.assertPlan();
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_SUMMARY_DAYS * DAY) {
      throw new ValidationError([{ path: 'to', code: 'invalid_range', message: `El periodo debe ser positivo y de máximo ${MAX_SUMMARY_DAYS} días` }]);
    }
    const mineOnly = a.viewAll ? sql`TRUE` : sql`c.created_by = ${a.userId}::uuid`;
    const row = await this.db.withTenant(async (tx) => {
      const res = await tx.execute<{ campaigns: number; recipients: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number; opted_out: number }>(sql`
        SELECT count(DISTINCT c.id)::int AS campaigns,
               count(r.id)::int AS recipients,
               count(r.id) FILTER (WHERE r.status IN ('sent', 'delivered', 'read', 'replied'))::int AS sent,
               count(r.id) FILTER (WHERE r.status IN ('delivered', 'read', 'replied'))::int AS delivered,
               count(r.id) FILTER (WHERE r.status IN ('read', 'replied'))::int AS read,
               count(r.id) FILTER (WHERE r.status = 'replied')::int AS replied,
               count(r.id) FILTER (WHERE r.status = 'failed')::int AS failed,
               count(r.id) FILTER (WHERE r.status = 'skipped')::int AS skipped,
               count(r.id) FILTER (WHERE r.opted_out_at IS NOT NULL)::int AS opted_out
          FROM campaigns c
          LEFT JOIN campaign_recipients r ON r.organization_id = c.organization_id AND r.campaign_id = c.id
         WHERE c.deleted_at IS NULL AND c.launched_at IS NOT NULL
           AND c.launched_at >= ${from.toISOString()}::timestamptz AND c.launched_at < ${to.toISOString()}::timestamptz
           AND ${mineOnly}`);
      return res.rows[0]!;
    });
    return { period: { from: from.toISOString(), to: to.toISOString() }, ...row, delivery_rate: rate(row.delivered, row.sent), reply_rate: rate(row.replied, row.sent), scope: a.viewAll ? 'all' : 'own' };
  }
}

function summarize(by: Array<{ status: string; reason: string | null; optedOut: boolean; n: number }>): ResultsSummary {
  const n = (statuses: string[]): number => by.filter((x) => statuses.includes(x.status)).reduce((s, x) => s + Number(x.n), 0);
  const skippedByReason: Record<string, number> = {};
  for (const x of by) if (x.status === 'skipped' && x.reason) skippedByReason[x.reason] = (skippedByReason[x.reason] ?? 0) + Number(x.n);
  const sent = n(['sent', 'delivered', 'read', 'replied']);
  const delivered = n(['delivered', 'read', 'replied']);
  const replied = n(['replied']);
  return {
    recipients: by.reduce((s, x) => s + Number(x.n), 0),
    sent,
    delivered,
    read: n(['read', 'replied']),
    replied,
    failed: n(['failed']),
    skipped: n(['skipped']),
    waiting: n(['pending', 'queued']),
    skipped_by_reason: skippedByReason,
    opted_out: by.filter((x) => x.optedOut).reduce((s, x) => s + Number(x.n), 0),
    delivery_rate: rate(delivered, sent),
    reply_rate: rate(replied, sent),
  };
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;
function view(r: typeof campaignRecipients.$inferSelect, name: string): RecipientView {
  return {
    id: r.id,
    contact: { id: r.contactId, name },
    phone: r.phone,
    status: r.status,
    skip_reason: r.skipReason,
    error: r.error,
    queued_at: iso(r.queuedAt),
    sent_at: iso(r.sentAt),
    delivered_at: iso(r.deliveredAt),
    read_at: iso(r.readAt),
    replied_at: iso(r.repliedAt),
    failed_at: iso(r.failedAt),
    opted_out_at: iso(r.optedOutAt),
  };
}

/** `2026-11-17 14:03:09` en la zona horaria de la empresa. */
function fmt(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}
