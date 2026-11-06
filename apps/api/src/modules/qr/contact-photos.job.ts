import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { contacts, Database } from '../../db';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { sniff, StorageError, StorageGateway } from '../attachments';
import { QrRoutesService } from '../organizations';
import { PHOTO_DOWNLOADER, type PhotoDownloader } from './photo-downloader';
import { QrConnectionsService } from './qr-connections.service';
import { QR_SESSION, QrSessionError, type QrSessionProvider } from './qr-session.port';

/** Contactos que se atienden por vuelta (cada empresa, cada minuto): la foto es un adorno, no debe cargar a Evolution. */
export const CONTACT_PHOTOS_BATCH = 5;
/** Si no se pudo o no tiene foto, se vuelve a preguntar a los 7 días. */
export const CONTACT_PHOTOS_RECHECK_MS = 7 * 24 * 60 * 60_000;
const TYPES: Readonly<Record<string, { mime: string; ext: string }>> = { jpeg: { mime: 'image/jpeg', ext: 'jpg' }, png: { mime: 'image/png', ext: 'png' }, webp: { mime: 'image/webp', ext: 'webp' } };

/**
 * Fotos de perfil de los contactos que escriben por WhatsApp por QR (v5). WhatsApp oficial (Meta) y GoHighLevel NO entregan la foto, así que esos contactos siguen con siglas. Cada minuto, por empresa
 * con conexión QR, toma hasta 5 contactos sin foto cuyo teléfono nunca se consultó (o se consultó hace más de 7 días) y que tienen una conversación en una sesión ABIERTA, pide la dirección a
 * Evolution, baja la imagen (solo servidores de WhatsApp, tope 2 MB, formato reconocido por contenido) y la guarda en `org/<empresa>/contacts/<contacto>/…`. Sin foto, con la privacidad cerrada o con
 * una imagen no admisible solo se anota la consulta. Si la sesión cae o el almacenamiento falla, se detiene la vuelta de esa empresa SIN anotar nada (se reintenta en la siguiente).
 * Corre bajo el contexto de cada empresa; nunca registra teléfonos ni direcciones.
 */
@Injectable()
export class ContactPhotosJob implements ScheduledJob {
  readonly name = 'contact-photos';
  readonly intervalMs = 60_000;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(QR_SESSION) private readonly provider: QrSessionProvider,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(PHOTO_DOWNLOADER) private readonly downloader: PhotoDownloader,
  ) {}

  async run(now: Date): Promise<number> {
    let done = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      done += await TenantContext.run({ organizationId }, () => this.org(organizationId, now));
    }
    return done;
  }

  private async org(organizationId: string, now: Date): Promise<number> {
    const creds = await this.connections.credentials();
    if (!creds) return 0;
    const before = new Date(now.getTime() - CONTACT_PHOTOS_RECHECK_MS);
    const rows = await this.db.withTenant(async (tx) => {
      const res = await tx.execute(sql`
        SELECT DISTINCT ON (c.id) c.id AS contact_id, p.e164 AS phone, q.instance_name AS instance
          FROM contacts c
          JOIN conversations v ON v.contact_id = c.id AND v.organization_id = c.organization_id
          JOIN qr_accounts q ON q.channel_account_id = v.channel_account_id AND q.organization_id = v.organization_id AND q.state = 'open'
          JOIN channel_accounts ch ON ch.id = q.channel_account_id AND ch.organization_id = q.organization_id AND ch.deleted_at IS NULL AND ch.status = 'active'
          JOIN contact_phones p ON p.contact_id = c.id AND p.organization_id = c.organization_id AND p.deleted_at IS NULL
         WHERE c.deleted_at IS NULL AND c.photo_key IS NULL AND (c.photo_checked_at IS NULL OR c.photo_checked_at < ${before})
         ORDER BY c.id, p.is_primary DESC
         LIMIT ${CONTACT_PHOTOS_BATCH}`);
      return res.rows as Array<{ contact_id: string; phone: string; instance: string }>;
    });
    let n = 0;
    for (const r of rows) {
      let url: string | null;
      try {
        url = await this.provider.fetchProfilePicture(creds, r.instance, r.phone.replace(/^\+/, ''));
      } catch (e) {
        if (e instanceof QrSessionError) {
          if (e.code === 'not_found') {
            await this.mark(r.contact_id, null, now); // la instancia ya no existe: no se insiste con este contacto
            n += 1;
            continue;
          }
          return n; // sesión caída, servidor sin respuesta, límite o clave: se intenta en la siguiente vuelta
        }
        throw e;
      }
      let key: string | null = null;
      if (url) {
        const bytes = await this.downloader.download(url);
        const type = bytes ? TYPES[sniff(bytes) ?? ''] : undefined;
        if (bytes && type) {
          key = `org/${organizationId}/contacts/${r.contact_id}/${randomUUID()}.${type.ext}`;
          try {
            await this.storage.put(key, bytes, type.mime);
          } catch (e) {
            if (e instanceof StorageError) return n; // sin almacenamiento: no se anota la consulta
            throw e;
          }
        }
      }
      await this.mark(r.contact_id, key, now);
      n += 1;
    }
    return n;
  }

  private mark(contactId: string, key: string | null, now: Date): Promise<unknown> {
    return this.db.withTenant((tx) => tx.update(contacts).set({ photoKey: key, photoCheckedAt: now }).where(eq(contacts.id, contactId)));
  }
}
