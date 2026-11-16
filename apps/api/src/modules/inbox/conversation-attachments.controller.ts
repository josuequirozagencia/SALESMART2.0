import { Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { readUploadBody as readBody, uploadFilenameOf as filenameOf, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { MAX_UPLOAD_BYTES } from '../attachments';
import type { InboxAccess } from './inbox.access';
import { ConversationAttachmentsService } from './conversation-attachments.service';

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
  constructor(@Inject(ConversationAttachmentsService) private readonly attachments: ConversationAttachmentsService) {}

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
