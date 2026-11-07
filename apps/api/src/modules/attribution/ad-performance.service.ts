import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Database } from '../../db';
import { ValidationError } from '../../errors';

const DAY_MS = 86_400_000;
/** Más allá de esto el reporte deja de ser un panel de seguimiento y se vuelve lento. */
const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 500;

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** Una fecha (2026-10-01) o una fecha con hora (2026-10-01T05:00:00Z). */
const when = z.union([isoDateTime, isoDate]);

/**
 * Parámetros de GET /v1/attribution/ad-performance (M3.3 §12). Sin ellos, los últimos 30 días. Una fecha sola se toma en UTC: "from" desde las 00:00 de ese día y "to" hasta el final de ese día (inclusive);
 * con hora, el instante exacto ("to" exclusivo).
 */
export const adPerformanceQuerySchema = z.strictObject({ from: when.optional(), to: when.optional() });
export type AdPerformanceQuery = z.infer<typeof adPerformanceQuerySchema>;

export interface AdPerformanceRow {
  ad_id: string;
  ad_name: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  /** Contactos cuyo primer toque fue este anuncio y que llegaron en el periodo. */
  leads: number;
  /** Citas (no canceladas) de esos contactos. */
  appointments: number;
  /** Ventas (activas, no anuladas) de esos contactos. */
  sales: number;
  /** Suma del total de esas ventas, como texto numérico con dos decimales. */
  revenue: string;
}

export interface AdPerformanceView {
  rows: AdPerformanceRow[];
  period: { from: string; to: string };
}

const parse = (v: string, end: boolean): Date => {
  if (isoDate.safeParse(v).success) return new Date(Date.parse(`${v}T00:00:00.000Z`) + (end ? DAY_MS : 0));
  return new Date(v);
};

/**
 * Rendimiento de anuncios (M3.3 §12, aprobado el 2026-11-07): por anuncio, cuántos contactos trajo (first_touch_ad_id), cuántas citas y ventas tienen y cuánto suman. Solo la empresa del contexto (la RLS lo
 * garantiza) y solo contactos vigentes. Un contacto sin id de anuncio no entra (los anteriores a M6.6 no lo tienen). El permiso attribution.view lo exige el controlador.
 */
@Injectable()
export class AdPerformanceService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async report(q: AdPerformanceQuery, now = new Date()): Promise<AdPerformanceView> {
    const to = q.to ? parse(q.to, true) : now;
    const from = q.from ? parse(q.from, false) : new Date(to.getTime() - 30 * DAY_MS);
    if (from.getTime() >= to.getTime()) throw new ValidationError([{ path: 'from', code: 'invalid_period', message: 'La fecha inicial debe ser anterior a la final' }]);
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new ValidationError([{ path: 'from', code: 'period_too_long', message: `El periodo no puede pasar de ${MAX_RANGE_DAYS} días` }]);
    const rows = await this.db.withTenant(async (tx) => {
      const res = await tx.execute(sql`
        WITH b AS (
          SELECT c.organization_id, c.id, c.first_touch_ad_id AS ad_id, c.first_touch_ad AS ad_name, c.first_touch_campaign AS campaign_name, c.first_touch_adset AS adset_name, c.first_touch_at
            FROM contacts c
           WHERE c.deleted_at IS NULL AND c.first_touch_ad_id IS NOT NULL AND c.first_touch_at >= ${from}::timestamptz AND c.first_touch_at < ${to}::timestamptz
        ),
        ch AS (
          SELECT ad_id, count(*)::int AS leads,
                 (array_agg(ad_name ORDER BY first_touch_at DESC, id DESC))[1] AS ad_name,
                 (array_agg(campaign_name ORDER BY first_touch_at DESC, id DESC))[1] AS campaign_name,
                 (array_agg(adset_name ORDER BY first_touch_at DESC, id DESC))[1] AS adset_name
            FROM b GROUP BY ad_id
        ),
        ap AS (
          SELECT b.ad_id, count(*)::int AS appointments
            FROM b JOIN appointments a ON a.organization_id = b.organization_id AND a.contact_id = b.id
           WHERE a.status <> 'cancelled' GROUP BY b.ad_id
        ),
        sl AS (
          SELECT b.ad_id, count(*)::int AS sales, COALESCE(sum(s.amount), 0)::numeric(14,2)::text AS revenue
            FROM b JOIN sales s ON s.organization_id = b.organization_id AND s.contact_id = b.id
           WHERE s.status = 'active' GROUP BY b.ad_id
        )
        SELECT ch.ad_id, ch.ad_name, ch.campaign_name, ch.adset_name, ch.leads,
               COALESCE(ap.appointments, 0) AS appointments, COALESCE(sl.sales, 0) AS sales, COALESCE(sl.revenue, '0.00') AS revenue
          FROM ch
          LEFT JOIN ap ON ap.ad_id = ch.ad_id
          LEFT JOIN sl ON sl.ad_id = ch.ad_id
         ORDER BY COALESCE(sl.sales, 0) DESC, COALESCE(sl.revenue, '0')::numeric DESC, ch.leads DESC, ch.ad_id ASC
         LIMIT ${MAX_ROWS}`);
      return res.rows as Array<{ ad_id: string; ad_name: string | null; campaign_name: string | null; adset_name: string | null; leads: number; appointments: number; sales: number; revenue: string }>;
    });
    return {
      rows: rows.map((r) => ({
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_name: r.campaign_name,
        adset_name: r.adset_name,
        leads: Number(r.leads),
        appointments: Number(r.appointments),
        sales: Number(r.sales),
        revenue: r.revenue,
      })),
      period: { from: from.toISOString(), to: to.toISOString() },
    };
  }
}
