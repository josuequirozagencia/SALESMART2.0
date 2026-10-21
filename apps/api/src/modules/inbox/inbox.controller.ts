import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import type { InboxAccess } from './inbox.access';
import { createScheduledSchema, listConversationsQuerySchema, messagesQuerySchema, noteSchema, replySchema, sendTemplateSchema, type CreateScheduledDto, type ListConversationsQuery, type MessagesQuery, type NoteDto, type ReplyDto, type SendTemplateDto } from './inbox.dto';
import { InboxService } from './inbox.service';
import { OutboundService } from './outbound.service';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { shareSchema, transferSchema, type ShareDto, type TransferDto } from './sharing.dto';
import { SharingService } from './sharing.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Lo que la persona puede ver y hacer, sacado de sus permisos VERIFICADOS (nunca de la petición). */
const accessOf = (req: AuthedRequest): InboxAccess => ({
  viewAll: req.principal?.permissions?.has('inbox.view_all') === true,
  canReply: req.principal?.permissions?.has('inbox.reply') === true,
  canTransfer: req.principal?.permissions?.has('inbox.transfer') === true,
  canShare: req.principal?.permissions?.has('inbox.share') === true,
});

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
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(ScheduledMessagesService) private readonly scheduledMessages: ScheduledMessagesService,
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

  /** A quién se puede transferir o compartir, con su carga y si está en la cola. Solo para quien puede hacer alguna de las dos cosas con esa conversación. */
  @RequirePermission('inbox.read')
  @Get(':id/transfer-options')
  @Header('Cache-Control', 'no-store')
  transferOptions(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.sharing.options(accessOf(req), id);
  }

  /** Pasa la conversación (y el lead) a otra persona, que debe aceptarla; puede dejar a quien la tenía como colaborador. */
  @RequirePermission('inbox.transfer')
  @Post(':id/transfer')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  transfer(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(transferSchema)) b: TransferDto) {
    return this.sharing.transfer(accessOf(req), id, b);
  }

  /** Da acceso a otra persona sin cambiar el dueño (con permiso de responder o solo de ver y dejar notas). */
  @RequirePermission('inbox.share')
  @Post(':id/share')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  share(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(shareSchema)) b: ShareDto) {
    return this.sharing.share(accessOf(req), id, b);
  }

  /** Quita el acceso de un colaborador (su dueño, quien ve todo o la propia persona). */
  @RequirePermission('inbox.share')
  @Delete(':id/participants/:userId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Param('userId', idParam) userId: string) {
    return this.sharing.revoke(accessOf(req), id, userId);
  }

  /** Escribe al cliente. 409 `WINDOW_CLOSED` si pasaron las 24 h; el mensaje devuelto trae su estado (`queued`, `sent` o `failed`). */
  @RequirePermission('inbox.reply')
  @Post(':id/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  reply(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(replySchema)) b: ReplyDto) {
    return this.outbound.reply(accessOf(req), id, b);
  }

  /** Las plantillas que se pueden enviar en esta conversación (las de su conexión; las que no se pueden enviar vienen con el motivo). */
  @RequirePermission('inbox.reply')
  @Get(':id/templates')
  @Header('Cache-Control', 'no-store')
  templates(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.outbound.listTemplates(accessOf(req), id);
  }

  /** Los mensajes programados de la conversación (pendientes, y por 24 h los que no salieron con su motivo). */
  @RequirePermission('inbox.read')
  @Get(':id/scheduled')
  @Header('Cache-Control', 'no-store')
  scheduled(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.scheduledMessages.list(accessOf(req), id);
  }

  /** Programa un texto para que salga solo a una hora, dentro de la ventana de 24 h. 409 `SCHEDULE_OUTSIDE_WINDOW` / `SCHEDULE_LIMIT`, 400 si la hora no es futura. */
  @RequirePermission('inbox.reply')
  @Post(':id/scheduled')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  schedule(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(createScheduledSchema)) b: CreateScheduledDto) {
    return this.scheduledMessages.create(accessOf(req), id, b);
  }

  /** Cancela un mensaje programado pendiente: quien lo programó, o quien ve todas las conversaciones. */
  @RequirePermission('inbox.reply')
  @Delete(':id/scheduled/:scheduledId')
  @Header('Cache-Control', 'no-store')
  cancelScheduled(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Param('scheduledId', idParam) scheduledId: string) {
    return this.scheduledMessages.cancel(accessOf(req), id, scheduledId);
  }

  /** Las respuestas rápidas que puede usar quien escribe, ya resueltas con los datos del contacto de esta conversación (M5.6b). */
  @RequirePermission('inbox.reply')
  @Get(':id/quick-replies')
  @Header('Cache-Control', 'no-store')
  quickReplies(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.outbound.listQuickReplies(accessOf(req), id);
  }

  /** Envía una plantilla aprobada, dentro o fuera de las 24 h. 400 si una variable no vale, 409 `TEMPLATE_NOT_AVAILABLE` si ya no se puede enviar. */
  @RequirePermission('inbox.reply')
  @Post(':id/template')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  sendTemplate(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(sendTemplateSchema)) b: SendTemplateDto) {
    return this.outbound.sendTemplate(accessOf(req), id, b);
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
