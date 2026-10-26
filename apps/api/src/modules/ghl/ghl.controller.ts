import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { GhlConnectionService } from './ghl-connection.service';
import { GhlChannelService } from './ghl-channel.service';
import { GhlEventsService } from './ghl-events.service';
import { GhlOutboxService } from './ghl-outbox.service';
import { GhlWorkflowsService } from './ghl-workflows.service';
import { channelConfigSchema, enrollSchema, eventsQuerySchema, outboxQuerySchema, saveConnectionSchema, workflowsQuerySchema, type ChannelConfigDto, type EnrollDto, type EventsQuery, type OutboxQuery, type SaveConnectionDto, type WorkflowsQuery } from './ghl.dto';

/**
 * Conexión de la empresa con GoHighLevel (M7.1, ADR-52). Solo quien administra integraciones (`integrations.manage`); `no-store`: son credenciales. El token jamás se devuelve (solo sus
 * últimos 4) y el secreto del webhook solo viaja al generarlo o rotarlo.
 */
@Controller('ghl')
export class GhlController {
  constructor(
    @Inject(GhlConnectionService) private readonly ghl: GhlConnectionService,
    @Inject(GhlEventsService) private readonly events: GhlEventsService,
    @Inject(GhlOutboxService) private readonly outbox: GhlOutboxService,
    @Inject(GhlChannelService) private readonly channel: GhlChannelService,
    @Inject(GhlWorkflowsService) private readonly workflows: GhlWorkflowsService,
  ) {}

  @RequirePermission('integrations.manage')
  @Get('connection')
  @Header('Cache-Control', 'no-store')
  connection() {
    return this.ghl.get();
  }

  @RequirePermission('integrations.manage')
  @Put('connection')
  @Header('Cache-Control', 'no-store')
  save(@Body(new ZodValidationPipe(saveConnectionSchema)) b: SaveConnectionDto) {
    return this.ghl.save(b);
  }

  /** «Probar»: vuelve a comprobar con GHL el token guardado. */
  @RequirePermission('integrations.manage')
  @Post('connection/test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test() {
    return this.ghl.test();
  }

  /** Desconecta y borra el token. */
  @RequirePermission('integrations.manage')
  @Post('connection/disconnect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  disconnect() {
    return this.ghl.disconnect();
  }

  /** Crea el punto de entrada del Workflow o rota su secreto (el anterior deja de servir). El secreto se muestra esta única vez. */
  @RequirePermission('integrations.manage')
  @Post('webhook/secret')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  secret() {
    return this.ghl.issueWebhookSecret();
  }

  /** Últimos avisos que llegaron del Workflow, con su estado y por qué se omitieron. */
  @RequirePermission('integrations.manage')
  @Get('events')
  @Header('Cache-Control', 'no-store')
  eventsList(@Query(new ZodValidationPipe(eventsQuerySchema)) q: EventsQuery) {
    return this.events.list(q);
  }

  /** Cambios de etiqueta enviados (o por enviar) a GoHighLevel, con su estado y por qué se omitieron. */
  @RequirePermission('integrations.manage')
  @Get('outbox')
  @Header('Cache-Control', 'no-store')
  outboxList(@Query(new ZodValidationPipe(outboxQuerySchema)) q: OutboxQuery) {
    return this.outbox.list(q);
  }

  /** Vuelve a poner en cola un cambio de etiqueta que falló. */
  @RequirePermission('integrations.manage')
  @Post('outbox/:id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  outboxRetry(@Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    return this.outbox.retry(id);
  }

  /** El canal «GoHighLevel» del Inbox: a qué cola van las conversaciones nuevas y por qué canal de GHL se responde por omisión. */
  @RequirePermission('integrations.manage')
  @Get('channel')
  @Header('Cache-Control', 'no-store')
  channelView() {
    return this.channel.view();
  }

  @RequirePermission('integrations.manage')
  @Put('channel')
  @Header('Cache-Control', 'no-store')
  channelSave(@Body(new ZodValidationPipe(channelConfigSchema)) b: ChannelConfigDto) {
    return this.channel.configure(b);
  }

  /** Los flujos (Workflows) de la Location de GHL, con memoria de 5 min (`?refresh=1` la salta). */
  @RequirePermission('ghl.enroll')
  @Get('workflows')
  @Header('Cache-Control', 'no-store')
  workflowsList(@Query(new ZodValidationPipe(workflowsQuerySchema)) q: WorkflowsQuery) {
    return this.workflows.list(q.refresh !== undefined);
  }

  /** Inscribe a un contacto en un flujo de GHL. El contacto debe ser uno que la persona ve (404 uniforme). */
  @RequirePermission('ghl.enroll')
  @Post('contacts/:contactId/workflows')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  enroll(@Req() req: AuthedRequest, @Param('contactId', new ZodValidationPipe(z.uuid())) contactId: string, @Body(new ZodValidationPipe(enrollSchema)) b: EnrollDto) {
    return this.workflows.enroll({ viewAll: req.principal?.permissions?.has('contacts.view_all') === true }, contactId, b.workflow_id);
  }

  /** Últimas inscripciones del contacto en flujos de GHL. */
  @RequirePermission('ghl.enroll')
  @Get('contacts/:contactId/workflows')
  @Header('Cache-Control', 'no-store')
  enrollments(@Req() req: AuthedRequest, @Param('contactId', new ZodValidationPipe(z.uuid())) contactId: string) {
    return this.workflows.history({ viewAll: req.principal?.permissions?.has('contacts.view_all') === true }, contactId);
  }
}
