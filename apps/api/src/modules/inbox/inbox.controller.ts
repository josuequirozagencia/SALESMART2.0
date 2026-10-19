import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import type { InboxAccess } from './inbox.access';
import { listConversationsQuerySchema, messagesQuerySchema, noteSchema, replySchema, type ListConversationsQuery, type MessagesQuery, type NoteDto, type ReplyDto } from './inbox.dto';
import { InboxService } from './inbox.service';
import { OutboundService } from './outbound.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Lo que la persona puede ver y hacer, sacado de sus permisos VERIFICADOS (nunca de la petición). */
const accessOf = (req: AuthedRequest): InboxAccess => ({ viewAll: req.principal?.permissions?.has('inbox.view_all') === true, canReply: req.principal?.permissions?.has('inbox.reply') === true });

/**
 * Inbox (M5.4, ADR-16/50). Tenant: la empresa sale del contexto verificado. `no-store`: son conversaciones con datos personales.
 * Ver exige `inbox.read` (con `inbox.view_all`, todas las de la empresa; sin él, solo las asignadas a la persona); aceptar, responder, escribir notas y finalizar,
 * `inbox.reply`. Lo que la persona no puede ver responde 404 igual que lo inexistente.
 */
@Controller('conversations')
export class InboxController {
  constructor(
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
  ) {}

  @RequirePermission('inbox.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listConversationsQuerySchema)) q: ListConversationsQuery) {
    return this.inbox.list(accessOf(req), q);
  }

  /** Lo que la pantalla necesita para sus filtros. Declarada ANTES de `:id`. */
  @RequirePermission('inbox.read')
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Req() req: AuthedRequest) {
    return this.inbox.options(accessOf(req));
  }

  @RequirePermission('inbox.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.inbox.get(accessOf(req), id);
  }

  @RequirePermission('inbox.read')
  @Get(':id/messages')
  @Header('Cache-Control', 'no-store')
  messages(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Query(new ZodValidationPipe(messagesQuerySchema)) q: MessagesQuery) {
    return this.inbox.messages(accessOf(req), id, q);
  }

  /** Escribe al cliente. 409 `WINDOW_CLOSED` si pasaron las 24 h; el mensaje devuelto trae su estado (`queued`, `sent` o `failed`). */
  @RequirePermission('inbox.reply')
  @Post(':id/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  reply(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(replySchema)) b: ReplyDto) {
    return this.outbound.reply(accessOf(req), id, b);
  }

  /** Nota interna: nunca sale al cliente. */
  @RequirePermission('inbox.reply')
  @Post(':id/notes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  note(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(noteSchema)) b: NoteDto) {
    return this.outbound.note(accessOf(req), id, b);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  accept(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.inbox.accept(accessOf(req), id);
  }

  /** Quien ve todo toma una conversación sin asignar. */
  @RequirePermission('inbox.reply')
  @Post(':id/take')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  take(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.inbox.take(accessOf(req), id);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  close(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.inbox.close(accessOf(req), id);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  read(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.inbox.markRead(accessOf(req), id);
  }
}

/** Acciones sobre un mensaje concreto. */
@Controller('messages')
export class MessagesController {
  constructor(@Inject(OutboundService) private readonly outbound: OutboundService) {}

  /** Vuelve a intentar un mensaje que falló. */
  @RequirePermission('inbox.reply')
  @Post(':id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retry(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.outbound.retry(accessOf(req), id);
  }
}
