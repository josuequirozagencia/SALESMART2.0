import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Database, metaEvents } from '../../db';
import { ContactsService, type ContactScope } from '../contacts';
import { SystemTagsService } from '../tags';
import { phoneHash } from './attribution.service';

export interface LeadMarkResult {
  lead: boolean;
  /** `queued`: salió a la cola hacia Meta; `skipped`: se marcó pero no hay a quién atribuirlo (no llegó por un anuncio); `none`: sin cambio de evento (ya estaba, o se quitó). */
  event: 'queued' | 'skipped' | 'none';
}

const NO_AD = 'El contacto no llegó por un anuncio de Meta: no hay a quién atribuir el Lead';

/**
 * «Lead» a mano (decisión del responsable, 2026-11-23): el Lead hacia Meta sale SOLO cuando una persona (asesor o administrador) coloca la etiqueta del sistema `Lead` a un contacto. Una vez por
 * contacto (`lead-tag:<contacto>`): quitarla y volverla a poner no manda otro; si se quita mientras el evento sigue en cola, se cancela. Sin clic de anuncio el evento queda omitido con su motivo.
 * El contacto se busca con el alcance de la persona (404 uniforme si no lo ve), todo en UNA transacción con el cambio de la etiqueta.
 */
@Injectable()
export class LeadMarkService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(SystemTagsService) private readonly tags: SystemTagsService,
  ) {}

  async set(scope: ContactScope, contactId: string, on: boolean, now = new Date()): Promise<LeadMarkResult> {
    return this.db.withTenant(async (tx) => {
      await this.contacts.visibleContactIn(tx, scope, contactId);
      const changed = await this.tags.setLeadByUser(tx, contactId, on);
      const eventId = `lead-tag:${contactId}`;
      if (!on) {
        if (changed) await tx.update(metaEvents).set({ status: 'cancelled', updatedAt: now }).where(and(eq(metaEvents.eventId, eventId), eq(metaEvents.status, 'pending')));
        return { lead: false, event: 'none' };
      }
      if (!changed) return { lead: true, event: 'none' };
      // Si el evento se canceló antes de salir, al volver a colocarla se reactiva (todavía no llegó a Meta)
      const revived = await tx.update(metaEvents).set({ status: 'pending', sendAfter: now, attempts: 0, lastError: null, updatedAt: now }).where(and(eq(metaEvents.eventId, eventId), eq(metaEvents.status, 'cancelled'))).returning({ id: metaEvents.id });
      if (revived.length > 0) return { lead: true, event: 'queued' };
      const who = await this.contacts.channelIdentity(tx, contactId);
      const attributable = !!who?.ctwaClId;
      const inserted = await tx
        .insert(metaEvents)
        .values({
          eventId,
          type: 'Lead',
          contactId,
          status: attributable ? 'pending' : 'skipped',
          sendAfter: now, // el Lead se envía sin ventana de gracia
          lastError: attributable ? null : NO_AD,
          payload: {
            event_name: 'Lead',
            event_time: Math.floor(now.getTime() / 1000),
            event_id: eventId,
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: who?.ctwaClId ? { ...(who.primaryPhone ? { ph: [phoneHash(who.primaryPhone)] } : {}), ctwa_clid: who.ctwaClId } : {},
            custom_data: {},
          },
        })
        .onConflictDoNothing()
        .returning({ id: metaEvents.id });
      if (inserted.length === 0) return { lead: true, event: 'none' };
      return { lead: true, event: attributable ? 'queued' : 'skipped' };
    });
  }
}
