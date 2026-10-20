import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { createQuickReplySchema, updateQuickReplySchema, type CreateQuickReplyDto, type UpdateQuickReplyDto } from './quick-replies.dto';
import { QuickRepliesService } from './quick-replies.service';
import { BUILT_IN_LABELS, BUILT_IN_VARIABLES } from './quick-reply-model';

const idParam = new ZodValidationPipe(z.uuid());
/** Compartir y cambiar las compartidas depende de `quick_replies.manage`, verificado en el servidor (nunca viene de la petición). */
const manage = (req: AuthedRequest): boolean => req.principal?.permissions?.has('quick_replies.manage') === true;

/**
 * Respuestas rápidas (M5.6b, ADR-50). Ver el listado va con `inbox.read`; crear y cambiar, con `inbox.reply` (una agencia en solo lectura o una empresa con la prueba
 * vencida no cambia nada). Personales por defecto; compartir y cambiar las compartidas exige `quick_replies.manage`. `no-store`: es contenido de la empresa.
 * Las respuestas ya resueltas para una conversación salen de `GET /conversations/:id/quick-replies` (Inbox).
 */
@Controller('quick-replies')
export class QuickRepliesController {
  constructor(@Inject(QuickRepliesService) private readonly replies: QuickRepliesService) {}

  @RequirePermission('inbox.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest) {
    const out = await this.replies.list(manage(req));
    // `access.share`: ¿puede compartir con toda la empresa? (la pantalla muestra u oculta esa opción; el servidor lo vuelve a exigir)
    return { ...out, access: { share: manage(req) }, built_in_variables: BUILT_IN_VARIABLES.map((key) => ({ key, label: BUILT_IN_LABELS[key] })) };
  }

  @RequirePermission('inbox.reply')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createQuickReplySchema)) b: CreateQuickReplyDto) {
    return this.replies.create(manage(req), b);
  }

  @RequirePermission('inbox.reply')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateQuickReplySchema)) b: UpdateQuickReplyDto) {
    return this.replies.update(manage(req), id, b);
  }

  @RequirePermission('inbox.reply')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.replies.remove(manage(req), id);
  }
}
