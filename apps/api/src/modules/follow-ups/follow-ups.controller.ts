import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { readUploadBody, uploadFilenameOf, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { MAX_UPLOAD_BYTES } from '../attachments';
import { setFollowUpsSchema, type SetFollowUpsDto } from './follow-ups.dto';
import { FollowUpsService } from './follow-ups.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Seguimientos automáticos de un agente (v11 S5, ADR-68): ver y guardar la secuencia del escenario «El contacto dejó de responder». Solo el administrador (`agents.manage`). Un agente que no existe
 * o es de otra empresa responde 404 igual que lo inexistente. `no-store`.
 *
 * v15: archivos de los pasos manuales. `POST …/files` recibe el archivo como cuerpo (con su `Content-Type` y `X-Filename`; el cuerpo se lee DESPUÉS de autenticar, con tope de tamaño) y responde 201;
 * `DELETE …/files/:fileId` lo quita; `GET …/files/:fileId/url` da una URL firmada de pocos minutos para previsualizarlo.
 */
@RequirePermission('agents.manage')
@Controller('agents')
export class FollowUpsController {
  constructor(@Inject(FollowUpsService) private readonly followUps: FollowUpsService) {}

  @Get(':id/follow-ups')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string) {
    return this.followUps.get(id);
  }

  @Put(':id/follow-ups')
  @Header('Cache-Control', 'no-store')
  set(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setFollowUpsSchema)) body: SetFollowUpsDto) {
    return this.followUps.set(id, body);
  }

  @Post(':id/follow-ups/files')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    const bytes = await readUploadBody(req, MAX_UPLOAD_BYTES);
    return this.followUps.uploadFile(id, { bytes, contentType: req.headers['content-type'], filename: uploadFilenameOf(req) });
  }

  @Delete(':id/follow-ups/files/:fileId')
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string, @Param('fileId', idParam) fileId: string) {
    return this.followUps.removeFile(id, fileId);
  }

  @Get(':id/follow-ups/files/:fileId/url')
  @Header('Cache-Control', 'no-store')
  url(@Param('id', idParam) id: string, @Param('fileId', idParam) fileId: string) {
    return this.followUps.fileUrl(id, fileId);
  }
}
