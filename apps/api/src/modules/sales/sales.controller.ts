import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { TenantContext } from '../../tenant';
import type { InboxAccess } from '../inbox';
import {
  cancelSchema,
  changeRequestSchema,
  correctionSchema,
  createSaleSchema,
  idempotencyKeySchema,
  listSalesQuerySchema,
  optionsQuerySchema,
  paymentSchema,
  requestsQuerySchema,
  resolveRequestSchema,
  settingsSchema,
  type CancelDto,
  type ChangeRequestDto,
  type CorrectionDto,
  type CreateSaleDto,
  type ListSalesQuery,
  type OptionsQuery,
  type PaymentDto,
  type RequestsQuery,
  type ResolveRequestDto,
  type SettingsDto,
} from './sales.dto';
import { SalesService, type SalesScope } from './sales.service';

const idParam = new ZodValidationPipe(z.uuid());

const inboxAccessOf = (req: AuthedRequest): InboxAccess => ({
  viewAll: req.principal?.permissions?.has('inbox.view_all') === true,
  canReply: req.principal?.permissions?.has('inbox.reply') === true,
  canTransfer: req.principal?.permissions?.has('inbox.transfer') === true,
  canShare: req.principal?.permissions?.has('inbox.share') === true,
});
/** Quién consulta: la persona sale de TenantContext; ver todas las ventas depende de `sales.view_all` (verificado por el guard). */
const scopeOf = (req: AuthedRequest): SalesScope => ({ userId: TenantContext.current().userId ?? '', viewAll: req.principal?.permissions?.has('sales.view_all') === true });

/** La llave de idempotencia es obligatoria en lo que mueve dinero: sin ella, un doble clic o un reintento de red podría duplicar la operación. */
function keyOf(raw: string | undefined): string {
  const r = idempotencyKeySchema.safeParse(raw);
  if (!r.success) throw new ValidationError([{ path: 'Idempotency-Key', code: raw ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por operación (8 a 100 caracteres: letras, números y _ . : -)' }]);
  return r.data;
}

/** Ventas, abonos y saldo (M6.2, ADR-08/51; F14). Todo `no-store`: son datos de dinero y de clientes. */
@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  /** Lo que necesita el formulario «Registrar venta» de una conversación (cola, catálogo, moneda y si se puede vender). */
  @RequirePermission('sales.create')
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(optionsQuerySchema)) q: OptionsQuery) {
    return this.sales.options(inboxAccessOf(req), q.conversation_id);
  }

  @RequirePermission('sales.read')
  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings() {
    return this.sales.settings();
  }

  @RequirePermission('sales.manage')
  @Put('settings')
  @Header('Cache-Control', 'no-store')
  setSettings(@Body(new ZodValidationPipe(settingsSchema)) b: SettingsDto) {
    return this.sales.setCurrency(b.currency);
  }

  /** Solicitudes de corrección de la empresa (administrador). */
  @RequirePermission('sales.view_all')
  @Get('change-requests')
  @Header('Cache-Control', 'no-store')
  requests(@Query(new ZodValidationPipe(requestsQuerySchema)) q: RequestsQuery) {
    return this.sales.listRequests(q);
  }

  @RequirePermission('sales.cancel')
  @Post('change-requests/:id/resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resolve(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(resolveRequestSchema)) b: ResolveRequestDto) {
    return this.sales.resolveRequest(scopeOf(req), id, b);
  }

  @RequirePermission('sales.create')
  @Post()
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(createSaleSchema)) b: CreateSaleDto) {
    const r = await this.sales.create(inboxAccessOf(req), keyOf(key), b);
    res.status(r.created ? 201 : 200);
    return r.sale;
  }

  @RequirePermission('sales.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listSalesQuerySchema)) q: ListSalesQuery) {
    return this.sales.list(scopeOf(req), q);
  }

  @RequirePermission('sales.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.sales.get(scopeOf(req), id);
  }

  @RequirePermission('sales.register_payment')
  @Post(':id/payments')
  @Header('Cache-Control', 'no-store')
  async pay(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Param('id', idParam) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(paymentSchema)) b: PaymentDto) {
    const r = await this.sales.addPayment(scopeOf(req), id, keyOf(key), b);
    res.status(r.created ? 201 : 200);
    return r.sale;
  }

  @RequirePermission('sales.cancel')
  @Post(':id/corrections')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  correct(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(correctionSchema)) b: CorrectionDto) {
    return this.sales.addCorrection(scopeOf(req), id, b);
  }

  @RequirePermission('sales.cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(cancelSchema)) b: CancelDto) {
    return this.sales.cancel(scopeOf(req), id, b);
  }

  /** El asesor pide que un administrador corrija la venta (no puede modificarla: ADR-32). */
  @RequirePermission('sales.create')
  @Post(':id/change-requests')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  requestChange(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(changeRequestSchema)) b: ChangeRequestDto) {
    return this.sales.requestChange(scopeOf(req), id, b);
  }
}
