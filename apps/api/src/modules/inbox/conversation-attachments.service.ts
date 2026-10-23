import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { Database, messageAttachments } from '../../db';
import { AppError, ForbiddenError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AttachmentsService } from '../attachments';
import { assertCanReply, loadConversation, scopeOf, type InboxAccess } from './inbox.access';
import { attachmentInfo, type AttachmentInfo } from './inbox.views';

export interface AttachmentUrl {
  url: string;
  expires_at: string;
  kind: string;
  mime_type: string;
  filename: string | null;
}

/**
 * Archivos adjuntos de una conversación (M5.6d, ADR-50): subir lo que la persona quiere enviar y entregar (con una URL firmada de pocos minutos) lo que ya está guardado.
 *  - SUBIR: quien puede responder esa conversación (mismas reglas que responder). El archivo se revisa (tipo declarado, tamaño y contenido real), el audio grabado se convierte a
 *    OGG/Opus, pasa por el antivirus y se guarda bajo `org/<organización>/…`. Queda un adjunto `ready` sin mensaje: se envía con `POST …/messages { attachment_id }`; si nadie lo
 *    envía en 24 h vence y se borra.
 *  - ENTREGAR: quien puede VER la conversación (404 si no). Solo se entrega lo `ready`: lo que se está descargando, falló, venció o tenía un virus responde 409 con el motivo.
 * Nunca se devuelve la clave del almacenamiento. El nombre y el contenido son datos del cliente: no van a logs ni a la auditoría.
 */
@Injectable()
export class ConversationAttachmentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
  ) {}

  async upload(access: InboxAccess, conversationId: string, file: { bytes: Buffer; contentType: string | undefined; filename: string | null }): Promise<AttachmentInfo> {
    const scope = scopeOf(access);
    if (!scope.canReply) throw new ForbiddenError();
    // Primero se comprueba que la persona puede escribir en la conversación: no se gasta almacenamiento ni antivirus en algo que no podrá enviar
    await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId);
      assertCanReply(scope, c, channel.state, collab);
    });
    const prepared = await this.files.prepareUpload(file.bytes, file.contentType, file.filename);
    const id = uuidv7();
    const organizationId = TenantContext.current().organizationId;
    const stored = await this.files.scanAndStore(organizationId, id, prepared);
    try {
      const [row] = await this.db.withTenant((tx) =>
        tx
          .insert(messageAttachments)
          .values({
            id,
            conversationId,
            direction: 'out',
            kind: prepared.kind,
            mimeType: prepared.mime,
            filename: prepared.filename,
            sizeBytes: prepared.bytes.length,
            storageKey: stored.key,
            checksum: prepared.checksum,
            state: 'ready',
            scanStatus: stored.scanStatus,
            createdBy: scope.userId,
          })
          .returning(),
      );
      return attachmentInfo(row!);
    } catch (e) {
      // Si no se pudo anotar, el archivo no debe quedar suelto en el almacenamiento
      await this.files.remove(stored.key);
      throw e;
    }
  }

  async url(access: InboxAccess, attachmentId: string): Promise<AttachmentUrl> {
    const scope = scopeOf(access);
    const row = await this.db.withTenant(async (tx) => {
      const [a] = await tx.select().from(messageAttachments).where(eq(messageAttachments.id, attachmentId)).limit(1);
      if (!a) throw new NotFoundError();
      await loadConversation(tx, scope, a.conversationId); // 404 si la persona no puede ver la conversación
      return a;
    });
    if (row.state !== 'ready' || !row.storageKey) throw this.notReady(row.state, row.error);
    const signed = await this.files.signedUrl(row.storageKey, row.kind as 'image', row.mimeType, row.filename);
    return { url: signed.url, expires_at: signed.expiresAt.toISOString(), kind: row.kind, mime_type: row.mimeType, filename: row.filename };
  }

  private notReady(state: string, error: string | null): AppError {
    if (state === 'pending') return new AppError(409, 'ATTACHMENT_NOT_READY', 'El archivo todavía se está descargando');
    if (state === 'infected') return new AppError(409, 'ATTACHMENT_INFECTED', error ?? 'El antivirus bloqueó este archivo');
    if (state === 'expired') return new AppError(409, 'ATTACHMENT_EXPIRED', 'El archivo venció porque no se envió');
    return new AppError(409, 'ATTACHMENT_FAILED', error ?? 'El archivo no está disponible');
  }
}
