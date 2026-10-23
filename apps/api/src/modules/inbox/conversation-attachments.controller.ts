import { Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { ZodValidationPipe } from '../../http';
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
 * Lee el cuerpo de la petición hasta `limit` bytes. Se lee AQUÍ —después de la autenticación y los permisos— y no en un middleware, para que quien no tiene sesión no pueda
 * hacer que el servidor reciba decenas de megas. Si pasa del tope responde 413 sin guardar el resto.
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const tooLarge = (): AppError => new AppError(413, 'ATTACHMENT_TOO_LARGE', `El archivo pesa demasiado: el máximo es ${Math.floor(limit / (1024 * 1024))} MB`);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        req.res?.setHeader('Connection', 'close');
        req.resume();
        return reject(tooLarge());
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!over) reject(new AppError(400, 'ATTACHMENT_UPLOAD_FAILED', 'La subida del archivo se interrumpió'));
    });
  });
}

/** El nombre que manda el navegador en `X-Filename` (codificado con `encodeURIComponent`). */
function filenameOf(req: Request): string | null {
  const raw = req.headers['x-filename'];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 600 ? raw : null;
}

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
