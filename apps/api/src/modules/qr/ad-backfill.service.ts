import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Database, webhookEvents } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { adThumbnailOf, errorLabel, redactEvolutionPayload, WebhookEventsService } from '../channels';
import { ConversationsService, type NormalizedMessage } from '../conversations';
import { TenantContext } from '../../tenant';
import { adInfoOf, AdCreativesService } from './ad-creatives.service';

export interface AdBackfillResult {
  /** Avisos con anuncio revisados en esta pasada. */
  scanned: number;
  /** Clics aplicados a un contacto (el mismo clic repetido cuenta: no cambia nada). */
  applied: number;
  /** Clics sin mensaje guardado (no hay a quién atribuir). */
  withoutMessage: number;
  /** Anuncios distintos recordados. */
  ads: number;
}

/** Avisos por pasada y empresa: acota el tiempo de una pasada; la tarea sigue en la siguiente. */
export const AD_BACKFILL_BATCH = 100;

/**
 * Recuperación de anuncios (v20, ADR-55): los avisos de WhatsApp por QR guardados (se vacían a los 30 días) que traen `externalAdReply` pero nunca se leyeron. Por cada aviso: aplica el clic al contacto del
 * mensaje (con su hora real; el Lead hacia Meta solo si es de menos de 7 días), recuerda el anuncio con su miniatura UNA vez y quita los bytes de la miniatura del aviso. Idempotente y reanudable: marca cada aviso
 * con `ad_scanned_at`. Corre bajo el contexto de UNA empresa; nunca registra teléfonos ni textos.
 */
@Injectable()
export class AdBackfillService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WebhookEventsService) private readonly events: WebhookEventsService,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(AdCreativesService) private readonly creatives: AdCreativesService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async run(now = new Date(), batch = AD_BACKFILL_BATCH): Promise<AdBackfillResult> {
    const organizationId = TenantContext.current().organizationId;
    const rows = await this.db.withTenant((tx) =>
      tx
        .select()
        .from(webhookEvents)
        .where(and(isNull(webhookEvents.adScannedAt), sql`${webhookEvents.payload} @> '{"data":{"contextInfo":{"externalAdReply":{}}}}'::jsonb`))
        .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.id))
        .limit(batch),
    );
    const out: AdBackfillResult = { scanned: 0, applied: 0, withoutMessage: 0, ads: 0 };
    const seen = new Set<string>();

    // 1) los anuncios y su miniatura (almacenamiento: fuera de la transacción de los clics)
    const planned: Array<{ id: string; channelAccountId: string; messages: NormalizedMessage[] }> = [];
    for (const row of rows) {
      const messages = (() => {
        try {
          return this.events.parsedEvents(row).flatMap((e) => e.event.messages);
        } catch {
          return [];
        }
      })();
      const thumb = row.payload && typeof row.payload['data'] === 'object' && row.payload['data'] !== null ? adThumbnailOf(row.payload['data'] as Record<string, unknown>) : null;
      for (const m of messages) {
        const ad = adInfoOf(m.referral);
        if (!ad) continue;
        await this.creatives.remember(ad, thumb && thumb.sourceId === ad.sourceId ? { bytes: thumb.bytes, mime: thumb.mime } : null, organizationId);
        seen.add(ad.sourceId);
      }
      planned.push({ id: row.id, channelAccountId: row.channelAccountId, messages });
    }

    // 2) los clics, y quitar los bytes del aviso (un fallo de UN aviso no frena a los demás: se anota y se sigue)
    await this.db.withTenant(async (tx) => {
      for (const p of planned) {
        await tx.execute(sql`SAVEPOINT ad_backfill`);
        try {
          for (const m of p.messages) {
            const r = await this.conversations.applyBackfillClick(tx, p.channelAccountId, m);
            if (r === 'applied') out.applied += 1;
            else if (r === 'no_message') out.withoutMessage += 1;
          }
          await tx.execute(sql`RELEASE SAVEPOINT ad_backfill`);
        } catch (e) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT ad_backfill`);
          this.log.warn({ organization_id: organizationId, event_id: p.id, err: errorLabel(e) }, 'recuperación de anuncios: no se pudo aplicar el clic de un aviso');
        }
        const row = rows.find((r) => r.id === p.id)!;
        await tx
          .update(webhookEvents)
          .set({ adScannedAt: now, payload: row.payload ? redactEvolutionPayload(row.payload) : row.payload })
          .where(and(eq(webhookEvents.id, p.id), isNull(webhookEvents.adScannedAt)));
        out.scanned += 1;
      }
    });
    out.ads = seen.size;
    if (out.scanned > 0) this.log.info({ organization_id: organizationId, scanned: out.scanned, applied: out.applied, ads: out.ads }, 'recuperación de anuncios: avisos revisados');
    return out;
  }
}
