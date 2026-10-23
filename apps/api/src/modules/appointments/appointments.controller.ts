import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { TenantContext } from '../../tenant';
import type { InboxAccess } from '../inbox';
import {
  cancelAppointmentSchema,
  createAppointmentSchema,
  idempotencyKeySchema,
  listAppointmentsQuerySchema,
  optionsQuerySchema,
  updateAppointmentSchema,
  type CancelAppointmentDto,
  type CreateAppointmentDto,
  type ListAppointmentsQuery,
  type OptionsQuery,
  type UpdateAppointmentDto,
} from './appointments.dto';
import { AppointmentsService, type AppointmentScope } from './appointments.service';

const idParam = new ZodValidationPipe(z.uuid());

const inboxAccessOf = (req: AuthedRequest): InboxAccess => ({
  viewAll: req.principal?.permissions?.has('inbox.view_all') === true,
  canReply: req.principal?.permissions?.has('inbox.reply') === true,
  canTransfer: req.principal?.permissions?.has('inbox.transfer') === true,
  canShare: req.principal?.permissions?.has('inbox.share') === true,
});
/** Quién consulta: la persona sale de TenantContext; ver y gestionar las de toda la empresa depende de `appointments.view_all` (verificado por el guard). */
const scopeOf = (req: AuthedRequest): AppointmentScope => ({ userId: TenantContext.current().userId ?? '', viewAll: req.principal?.permissions?.has('appointments.view_all') === true });

function keyOf(raw: string | undefined): string {
  const r = idempotencyKeySchema.safeParse(raw);
  if (!r.success) throw new ValidationError([{ path: 'Idempotency-Key', code: raw ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por operación (8 a 100 caracteres: letras, números y _ . : -)' }]);
  return r.data;
}

/** Citas y recordatorios (M6.3, ADR-13/51; F13). Todo `no-store`: son datos de clientes. */
@Controller('appointments')
export class AppointmentsController {
  constructor(@Inject(AppointmentsService) private readonly appointments: AppointmentsService) {}

  /** Lo que necesita el formulario «Agendar» de una conversación (zona horaria, tope de recordatorios, ventana de 24 h y plantillas). */
  @RequirePermission('appointments.write')
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(optionsQuerySchema)) q: OptionsQuery) {
    return this.appointments.options(inboxAccessOf(req), q.conversation_id);
  }

  @RequirePermission('appointments.write')
  @Post()
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(createAppointmentSchema)) b: CreateAppointmentDto) {
    const r = await this.appointments.create(inboxAccessOf(req), keyOf(key), b);
    res.status(r.created ? 201 : 200);
    return r.appointment;
  }

  @RequirePermission('appointments.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listAppointmentsQuerySchema)) q: ListAppointmentsQuery) {
    return this.appointments.list(scopeOf(req), q);
  }

  @RequirePermission('appointments.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.appointments.get(scopeOf(req), id);
  }

  @RequirePermission('appointments.write')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateAppointmentSchema)) b: UpdateAppointmentDto) {
    return this.appointments.update(scopeOf(req), id, b);
  }

  @RequirePermission('appointments.write')
  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(cancelAppointmentSchema)) b: CancelAppointmentDto) {
    return this.appointments.cancel(scopeOf(req), id, b);
  }

  @RequirePermission('appointments.write')
  @Post(':id/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  complete(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.appointments.complete(scopeOf(req), id);
  }
}
