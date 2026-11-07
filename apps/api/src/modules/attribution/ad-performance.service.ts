import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { contacts, Database } from '../../db';
import { ValidationError } from '../../errors';
import { CONTACT_CHANNELS } from '../contacts';

const DAY_MS = 86_400_000;
/** Más allá de esto el reporte se vuelve lento y deja de ser un panel de seguimiento. */
const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 500;

/**
 * Parámetros de `GET /v1/attribution/ad-performance` (M3.3 §12; los nombres son los del plan aprobado el 2026-11-07). `touchModel` elige qué toque agrupa:
 * `last` (el último anuncio que vio el contacto, por omisión) o `first` (el que lo trajo).
 */
export const adPerformanceQuerySchema = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  channel: z.enum(CONTACT_CHANNELS).optional(),
  touchModel: z.enum(['last', 'first']).default('last'),
});
export type AdPerformanceQuery = z.infer<typeof adPerformanceQuerySchema>;

export interface AdPerformanceRow {
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
  channel: string;
  leads: number;
  sales: number;
  /** 0–100, con un decimal. */
  convRate: number;
  /** Solo el primero y solo si tiene al menos una venta. */
  isTopAd: boolean;
}

export interface AdPerformanceView {
  rows: AdPerformanceRow[];
  period: { from: string; to: string };
  touchModel: 'last' | 'first';
}

/**
 * Rendimiento de anuncios (M3.3 §12): de cada anuncio, cuántos contactos trajo (leads) y cuántos de ellos tienen la etiqueta del sistema «Venta» (ventas). Lee solo los contactos de la empresa
 * del contexto (la RLS lo garantiza) que siguen vigentes. La interfaz solo muestra; el permiso `attribution.view` lo exige el controlador.
 */
@Injectable()
export class AdPerformanceService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async report(q: AdPerformanceQuery, now = new Date()): Promise<AdPerformanceView> {
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (from.getTime() > to.getTime()) throw new ValidationError([{ path: 'from', code: 'invalid_period', message: 'La fecha inicial no puede ser posterior a la final' }]);
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new ValidationError([{ path: 'from', code: 'period_too_long', message: `El periodo no puede pasar de ${MAX_RANGE_DAYS} días` }]);
    // Las columnas salen de dos juegos fijos del esquema (nunca del cliente): sin SQL armado a mano
    const c = q.touchModel === 'first'
      ? { at: contacts.firstTouchAt, ad: contacts.firstTouchAd, adId: contacts.firstTouchAdId, adset: contacts.firstTouchAdset, campaign: contacts.firstTouchCampaign }
      : { at: contacts.lastTouchAt, ad: contacts.lastTouchAd, adId: contacts.lastTouchAdId, adset: contacts.lastTouchAdset, campaign: contacts.lastTouchCampaign };
    const channel = q.channel ? sql`AND ${contacts.channel} = ${q.channel}` : sql``;
    const rows = await this.db.withTenant(async (tx) => {
      const res = await tx.execute(sql`
        SELECT ${c.ad} AS ad_name, ${c.adset} AS adset_name, ${c.campaign} AS campaign_name, ${contacts.channel} AS channel,
               count(*)::int AS leads,
               (count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM contact_tags ct JOIN tags g ON g.organization_id = ct.organization_id AND g.id = ct.tag_id
                   WHERE ct.organization_id = ${contacts.organizationId} AND ct.contact_id = ${contacts.id} AND g.system_key = 'sale')))::int AS sales
          FROM contacts
         WHERE ${contacts.deletedAt} IS NULL
           AND ${c.ad} IS NOT NULL
           AND ${c.at} >= ${from} AND ${c.at} <= ${to}
           ${channel}
         GROUP BY ${c.adId}, ${c.ad}, ${c.adset}, ${c.campaign}, ${contacts.channel}
         ORDER BY sales DESC, leads DESC, ${c.ad} ASC, ${contacts.channel} ASC
         LIMIT ${MAX_ROWS}`);
      return res.rows as Array<{ ad_name: string | null; adset_name: string | null; campaign_name: string | null; channel: string; leads: number; sales: number }>;
    });
    return {
      rows: rows.map((r, i) => ({
        adName: r.ad_name,
        adsetName: r.adset_name,
        campaignName: r.campaign_name,
        channel: r.channel,
        leads: Number(r.leads),
        sales: Number(r.sales),
        convRate: r.leads > 0 ? Math.round((Number(r.sales) / Number(r.leads)) * 1000) / 10 : 0,
        isTopAd: i === 0 && Number(r.sales) >= 1,
      })),
      period: { from: from.toISOString(), to: to.toISOString() },
      touchModel: q.touchModel,
    };
  }
}
