import { Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../http';
import type { AuthedRequest } from '../../../http/access.guard';
import { RequirePermission } from '../../../rbac';
import type { InboxAccess } from '../../inbox';
import { AgentRuntimeService } from './agent-runtime.service';
import { ReplySuggestionService } from './reply-suggestion.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Lo que la persona puede ver y hacer en la bandeja, sacado de sus permisos VERIFICADOS (igual que el Inbox). */
const accessOf = (req: AuthedRequest): InboxAccess => ({
  viewAll: req.principal?.permissions?.has('inbox.view_all') === true,
  canReply: req.principal?.permissions?.has('inbox.reply') === true,
  canTransfer: req.principal?.permissions?.has('inbox.transfer') === true,
  canShare: req.principal?.permissions?.has('inbox.share') === true,
});

/**
 * El agente de IA dentro de una conversación (M8.5, ADR-53; F17): ver qué hace y tomar el control o reanudarlo. Ver exige `inbox.read`; pausar y reanudar, `inbox.reply`. Lo que la persona
 * no puede ver responde 404 igual que lo inexistente. `no-store`.
 */
@Controller('conversations')
export class ConversationAiController {
  constructor(
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(ReplySuggestionService) private readonly suggestions: ReplySuggestionService,
  ) {}

  @RequirePermission('inbox.read')
  @Get(':id/ai')
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.runtime.status(accessOf(req), id);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/ai/pause')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  pause(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.runtime.pauseByPerson(accessOf(req), id);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/ai/resume')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resume(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.runtime.resumeByPerson(accessOf(req), id);
  }

  /** Un borrador de respuesta para quien atiende (v11 S4, ADR-61): NO envía nada ni toca al agente; la persona lo edita y lo envía. `inbox.reply`; gasta créditos de IA. */
  @RequirePermission('inbox.reply')
  @Post(':id/ai/suggest')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  suggest(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.suggestions.suggest(accessOf(req), id);
  }
}
