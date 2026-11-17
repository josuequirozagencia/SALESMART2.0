import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { TenantContext } from '../../tenant';
import { advisorLimitSchema, createCampaignSchema, idempotencyKeySchema, listCampaignsQuerySchema, updateCampaignSchema, type AdvisorLimitDto, type CreateCampaignDto, type ListCampaignsQuery, type UpdateCampaignDto } from './campaigns.dto';
import { CampaignsService, type CampaignAccess } from './campaigns.service';

const idParam = new ZodValidationPipe(z.uuid());
/** Quién consulta: la persona sale de TenantContext y lo que ve, de los permisos VERIFICADOS por el guard (nunca de la petición). */
const accessOf = (req: AuthedRequest): CampaignAccess => ({
  userId: TenantContext.current().userId ?? '',
  viewAll: req.principal?.permissions?.has('campaigns.view_all') === true,
  contactsViewAll: req.principal?.permissions?.has('contacts.view_all') === true,
});

/** La llave de idempotencia es obligatoria al crear: sin ella, un doble clic o un reintento de red crearía dos campañas. */
function keyOf(raw: string | undefined): string {
  const r = idempotencyKeySchema.safeParse(raw);
  if (!r.success) throw new ValidationError([{ path: 'Idempotency-Key', code: raw ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por operación (8 a 100 caracteres: letras, números y _ . : -)' }]);
  return r.data;
}

/**
 * Campañas masivas (v17, ADR-72), rebanada 17.1: borradores y vista previa de la audiencia; todavía no envía. Ver va con `campaigns.read` (solo las propias; con `campaigns.view_all`, todas) y
 * crear o editar con `campaigns.send`. El tope diario por asesor lo fija quien administra al equipo (`users.manage`). Todo `no-store`: son datos de clientes. Las rutas fijas van antes de `:id`.
 */
@Controller('campaigns')
export class CampaignsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  @RequirePermission('campaigns.send')
  @Get('options')
  options(@Req() req: AuthedRequest) {
    return this.campaigns.options(accessOf(req));
  }

  @RequirePermission('users.manage')
  @Get('advisor-limits')
  advisorLimits() {
    return this.campaigns.advisorLimits();
  }

  @RequirePermission('users.manage')
  @Put('advisor-limits/:userId')
  setAdvisorLimit(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(advisorLimitSchema)) b: AdvisorLimitDto) {
    return this.campaigns.setAdvisorLimit(userId, b);
  }

  @RequirePermission('campaigns.send')
  @Post()
  async create(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(createCampaignSchema)) b: CreateCampaignDto) {
    const r = await this.campaigns.create(accessOf(req), keyOf(key), b);
    res.status(r.created ? 201 : 200);
    return r.campaign;
  }

  @RequirePermission('campaigns.read')
  @Get()
  list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listCampaignsQuerySchema)) q: ListCampaignsQuery) {
    return this.campaigns.list(accessOf(req), q);
  }

  @RequirePermission('campaigns.read')
  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.get(accessOf(req), id);
  }

  @RequirePermission('campaigns.send')
  @Patch(':id')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateCampaignSchema)) b: UpdateCampaignDto) {
    return this.campaigns.update(accessOf(req), id, b);
  }

  @RequirePermission('campaigns.send')
  @Post(':id/duplicate')
  @HttpCode(201)
  async duplicate(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Param('id', idParam) id: string, @Headers('idempotency-key') key: string | undefined) {
    const r = await this.campaigns.duplicate(accessOf(req), id, keyOf(key));
    res.status(r.created ? 201 : 200);
    return r.campaign;
  }

  /** Vista previa de la audiencia y del mensaje: cuántos recibirían, a quiénes se omite y por qué, y el mensaje con un contacto real. No envía ni guarda nada. */
  @RequirePermission('campaigns.send')
  @Get(':id/preview')
  preview(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.preview(accessOf(req), id);
  }
}
