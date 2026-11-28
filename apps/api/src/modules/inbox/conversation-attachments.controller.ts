import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { readUploadBody as readBody, uploadFilenameOf as filenameOf, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { ForbiddenError, ValidationError } from '../../errors';
import { MAX_UPLOAD_BYTES } from '../attachments';
import { LibraryService } from '../library';
import type { InboxAccess } from './inbox.access';
import { ConversationAttachmentsService } from './conversation-attachments.service';
import { sendLibrarySchema, sendQuickReplySchema, type SendLibraryDto, type SendQuickReplyDto } from './inbox.dto';
import { QuickReplySendService } from './quick-reply-send.service';
import { OutboundService } from './outbound.service';

const idParam = new ZodValidationPipe(z.uuid());

const accessOf = (req: AuthedRequest): InboxAccess => ({
  viewAll: req.principal?.permissions?.has('inbox.view_all') === true,
  canReply: req.principal?.permissions?.has('inbox.reply') === true,
  canTransfer: req.principal?.permissions?.has('inbox.transfer') === true,
  canShare: req.principal?.permissions?.has('inbox.share') === true,
});

/**
 * Subir un archivo para enviarlo en una conversación (M5.6d, ADR-50). El cuerpo es el archivo tal cual, con su `Content-Type` y, si lo tiene, `X-Filename`. Responde 201 con el
 * adjunto (`ready`), que luego se envía con `POST /conversations/:id/messages { attachment_id }`. 413 si pesa de más, 415 si el tipo no se admite, 422 si el contenido no
 * corresponde al tipo o el antivirus lo bloquea, 503 si no hay almacenamiento o antivirus disponible. `no-store`.
 */
@Controller('conversations')
export class ConversationAttachmentsController {
  constructor(
    @Inject(ConversationAttachmentsService) private readonly attachments: ConversationAttachmentsService,
    @Inject(LibraryService) private readonly library: LibraryService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
    @Inject(QuickReplySendService) private readonly quickReplySend: QuickReplySendService,
  ) {}

  /**
   * Enviar un archivo de la biblioteca (V21, ADR-75): quien puede responder esta conversación y tiene `library.read` (el asesor solo lo marcado para asesores). Copia el archivo a un adjunto
   * propio de la conversación y lo envía como un archivo normal (mismas reglas: dueño, ventana de 24 h, mensaje humano que detiene el SLA). Responde el mensaje.
   */
  @RequirePermission('inbox.reply')
  @Post(':id/library/:assetId/send')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async sendFromLibrary(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Param('assetId', idParam) assetId: string, @Body(new ZodValidationPipe(sendLibrarySchema)) b: SendLibraryDto) {
    const perms = req.principal?.permissions;
    if (perms?.has('library.read') !== true) throw new ForbiddenError();
    const libAccess = { manage: perms.has('library.manage') };
    const access = accessOf(req);
    const att = await this.attachments.fromLibrary(access, id, () => this.library.readForSend(libAccess, assetId, id));
    return this.outbound.sendMedia(access, id, { attachment_id: att.id, ...(b.caption ? { caption: b.caption } : {}) });
  }

  /**
   * Enviar una respuesta rápida con sus archivos (V25): quien puede responder y ve la biblioteca. `Idempotency-Key` obligatoria (201 la primera vez; 200 si se repite igual). Sale todo o nada:
   * si un archivo ya no está disponible responde 409 sin enviar nada. 409 `CHANNEL_NO_MEDIA` por GoHighLevel y `WINDOW_CLOSED` fuera de las 24 h.
   */
  @RequirePermission('inbox.reply')
  @Post(':id/quick-replies/:replyId/send')
  @Header('Cache-Control', 'no-store')
  async sendQuickReply(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Param('id', idParam) id: string, @Param('replyId', idParam) replyId: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(sendQuickReplySchema)) b: SendQuickReplyDto) {
    const perms = req.principal?.permissions;
    if (perms?.has('library.read') !== true) throw new ForbiddenError();
    if (!key || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new ValidationError([{ path: 'Idempotency-Key', code: key ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por envío (8 a 100 caracteres)' }]);
    const out = await this.quickReplySend.send(accessOf(req), { manage: perms.has('library.manage') }, id, replyId, key, b);
    res.status(out.created ? 201 : 200);
    return { messages: out.messages };
  }

  @RequirePermission('inbox.reply')
  @Post(':id/attachments')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    const bytes = await readBody(req, MAX_UPLOAD_BYTES);
    return this.attachments.upload(accessOf(req), id, { bytes, contentType: req.headers['content-type'], filename: filenameOf(req) });
  }
}

/** Entregar un archivo guardado: una URL firmada de pocos minutos. `no-store`: la URL da acceso al archivo. */
@Controller('attachments')
export class AttachmentsController {
  constructor(@Inject(ConversationAttachmentsService) private readonly attachments: ConversationAttachmentsService) {}

  @RequirePermission('inbox.read')
  @Get(':id/url')
  @Header('Cache-Control', 'no-store')
  url(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.attachments.url(accessOf(req), id);
  }
}
