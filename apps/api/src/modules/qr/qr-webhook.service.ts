import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, qrAccounts } from '../../db';
import { NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AttachmentsService } from '../attachments';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { parseEvolutionWebhook, WebhookEventsJob, WebhookEventsService } from '../channels';
import { QrRoutesService } from '../organizations';
import { QrConnectionsService } from './qr-connections.service';

/**
 * Entrada de los avisos de Evolution (M9.6, ADR-54/ADR-31). PÚBLICA: la credencial es el identificador opaco de la dirección + el token (que solo existe como hash). Un identificador o token
 * desconocido responde 404 uniforme. Con el aviso autenticado: (1) los cambios de la sesión se aplican de inmediato (la pantalla y los envíos dependen de ello); (2) los mensajes, estados y reacciones se
 * GUARDAN ya sin la `apikey` ni la dirección del webhook (con su token) que Evolution repite en cada evento, y se procesan después con el mismo motor de avisos que Meta; (3) el archivo que llega en base64
 * dentro del aviso se guarda aparte en el almacenamiento (clave temporal) y el aviso queda con su referencia: no se guardan megabytes en la tabla de avisos.
 */
@Injectable()
export class QrWebhookService {
  constructor(
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(Database) private readonly db: Database,
    @Inject(WebhookEventsService) private readonly events: WebhookEventsService,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(WebhookEventsJob) private readonly drainer: WebhookEventsJob,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async ingest(routeId: string, token: string | undefined, body: unknown, now = new Date()): Promise<void> {
    const route = token ? await this.routes.resolve(routeId, token, now) : null;
    if (!route) throw new NotFoundError();
    await TenantContext.run({ organizationId: route.organizationId }, () => this.handle(route.organizationId, route.channelAccountId, body, now));
  }

  private async handle(organizationId: string, channelAccountId: string, body: unknown, now: Date): Promise<void> {
    const parsed = parseEvolutionWebhook(body, now);
    if (!parsed.instance) return;
    const [q] = await this.db.withTenant((tx) => tx.select({ instance: qrAccounts.instanceName }).from(qrAccounts).where(eq(qrAccounts.channelAccountId, channelAccountId)).limit(1));
    if (!q || q.instance !== parsed.instance) return; // un aviso de otra instancia no es de esta conexión
    if (parsed.connection) {
      await this.db.withTenant((tx) => this.connections.applyState(tx, channelAccountId, parsed.connection!, now));
    } else {
      await this.db.withTenant((tx) => tx.update(qrAccounts).set({ lastEventAt: now }).where(eq(qrAccounts.channelAccountId, channelAccountId)));
    }
    if (parsed.events.length === 0) return;
    const event = String((body as Record<string, unknown>)['event']);
    // Los archivos que traía el aviso: a una clave temporal del almacenamiento (el adjunto del mensaje los toma de ahí)
    const media_keys: Record<string, string> = {};
    for (const [messageId, b64] of parsed.inlineMedia) {
      const mime = parsed.events.flatMap((e) => e.event.messages).find((m) => m.externalId === messageId)?.media?.mimeType ?? 'application/octet-stream';
      const key = await this.files.putInbound(organizationId, Buffer.from(b64, 'base64'), mime.split(';')[0] ?? 'application/octet-stream');
      if (key) media_keys[messageId] = key;
    }
    for (const { raw } of parsed.events) await this.events.store(channelAccountId, parsed.instance, { __qr: 1, instance: parsed.instance, event, data: raw, media_keys }, now);
    // Procesamiento inmediato: el mensaje aparece sin esperar a la tarea de cada 5 s. Si falla, el aviso ya está guardado y la tarea lo recoge
    try {
      await this.drainer.drain(organizationId, now);
    } catch {
      this.log.warn({ organization_id: organizationId }, 'no se pudo procesar al instante un aviso de WhatsApp por QR; lo hará la tarea periódica');
    }
  }
}
