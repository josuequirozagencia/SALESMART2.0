import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { TenantContext } from '../../tenant';
import { CampaignResultsService } from './campaign-results.service';
import { advisorLimitSchema, audienceListSchema, createCampaignSchema, idempotencyKeySchema, launchSchema, listCampaignsQuerySchema, previewSchema, resultsQuerySchema, settingsSchema, summaryQuerySchema, updateCampaignSchema, type AdvisorLimitDto, type AudienceListDto, type CreateCampaignDto, type LaunchDto, type ListCampaignsQuery, type PreviewDto, type ResultsQuery, type SettingsDto, type SummaryQuery, type UpdateCampaignDto } from './campaigns.dto';
import { CampaignsService, type CampaignAccess } from './campaigns.service';

const idParam = new ZodValidationPipe(z.uuid());
/** Quién consulta: la persona sale de TenantContext y lo que ve, de los permisos VERIFICADOS por el guard (nunca de la petición). */
const accessOf = (req: AuthedRequest): CampaignAccess => ({
  userId: TenantContext.current().userId ?? '',
  viewAll: req.principal?.permissions?.has('campaigns.view_all') === true,
  contactsViewAll: req.principal?.permissions?.has('contacts.view_all') === true,
  cancelOthers: req.principal?.permissions?.has('campaigns.cancel') === true,
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
  constructor(
    @Inject(CampaignsService) private readonly campaigns: CampaignsService,
    @Inject(CampaignResultsService) private readonly results: CampaignResultsService,
  ) {}

  /** Qué puede hacer la persona con campañas y si su plan las incluye: la pantalla y el menú se arman con esto (no devuelve datos de la empresa). */
  @RequirePermission('inbox.read')
  @Get('access')
  access(@Req() req: AuthedRequest) {
    const has = (k: 'campaigns.read' | 'campaigns.send' | 'campaigns.view_all' | 'campaigns.cancel' | 'users.manage' | 'channels.manage'): boolean => req.principal?.permissions?.has(k) === true;
    return this.campaigns.accessInfo({ read: has('campaigns.read'), send: has('campaigns.send'), viewAll: has('campaigns.view_all'), manageLimits: has('users.manage'), manageSettings: has('channels.manage'), cancelOthers: has('campaigns.cancel') });
  }

  /** El resumen del periodo para la tarjeta de Analítica (las campañas lanzadas en el periodo y lo que dieron). Solo las propias, o todas con `campaigns.view_all`. */
  @RequirePermission('campaigns.read')
  @Get('summary')
  summary(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(summaryQuerySchema)) q: SummaryQuery) {
    return this.results.summary(accessOf(req), q);
  }

  @RequirePermission('campaigns.send')
  @Get('options')
  options(@Req() req: AuthedRequest) {
    return this.campaigns.options(accessOf(req));
  }

  /** El tope diario de la empresa por WhatsApp oficial (lo administra quien administra las conexiones). */
  @RequirePermission('channels.manage')
  @Get('settings')
  settings() {
    return this.campaigns.settings();
  }

  @RequirePermission('channels.manage')
  @Put('settings')
  setSettings(@Body(new ZodValidationPipe(settingsSchema)) b: SettingsDto) {
    return this.campaigns.setSettings(b);
  }

  /** Las plantillas enviables de una conexión oficial que la persona puede usar (para elegir la del mensaje). */
  @RequirePermission('campaigns.send')
  @Get('channels/:channelId/templates')
  templates(@Req() req: AuthedRequest, @Param('channelId', idParam) channelId: string) {
    return this.campaigns.templatesFor(accessOf(req), channelId);
  }

  /** Vista previa EN VIVO (sin borrador guardado): cuántos recibirían, a quiénes se omite y por qué, límites y mensaje de ejemplo. No guarda nada. */
  @RequirePermission('campaigns.send')
  @Post('preview')
  @HttpCode(200)
  previewLive(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(previewSchema)) b: PreviewDto) {
    return this.campaigns.previewDraft(accessOf(req), b);
  }

  /** Una página de la lista de destinatarios con su estado, para marcar o desmarcar a mano. */
  @RequirePermission('campaigns.send')
  @Post('audience')
  @HttpCode(200)
  audience(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(audienceListSchema)) b: AudienceListDto) {
    return this.campaigns.audienceList(accessOf(req), b);
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

  /** El informe de la campaña: totales, tasas y los destinatarios con su estado, por páginas (17.5). */
  @RequirePermission('campaigns.read')
  @Get(':id/results')
  resultsOf(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Query(new ZodValidationPipe(resultsQuerySchema)) q: ResultsQuery) {
    return this.results.results(accessOf(req), id, q);
  }

  /** El CSV de los destinatarios (BOM UTF-8, anti-fórmulas). POST porque deja rastro en la auditoría: quién descargó y cuántas filas. */
  @RequirePermission('campaigns.read')
  @Post(':id/export')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async exportCsv(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    const r = await this.results.exportCsv(accessOf(req), id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('X-Export-Count', String(r.count));
    return r.csv;
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

  /**
   * Lanza la campaña: congela la audiencia y la deja en curso (o programada). Idempotente: repetirlo devuelve la campaña como quedó (`Idempotency-Key` obligatoria, como en todo lo que envía o mueve dinero).
   */
  @RequirePermission('campaigns.send')
  @Post(':id/launch')
  async launch(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Param('id', idParam) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(launchSchema)) b: LaunchDto) {
    keyOf(key);
    const r = await this.campaigns.launch(accessOf(req), id, b);
    res.status(r.created ? 201 : 200);
    return r.campaign;
  }

  @RequirePermission('campaigns.send')
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.pause(accessOf(req), id);
  }

  @RequirePermission('campaigns.send')
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.resume(accessOf(req), id);
  }

  @RequirePermission('campaigns.send')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.cancel(accessOf(req), id);
  }

  /** Vista previa de la audiencia y del mensaje: cuántos recibirían, a quiénes se omite y por qué, y el mensaje con un contacto real. No envía ni guarda nada. */
  @RequirePermission('campaigns.send')
  @Get(':id/preview')
  preview(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.campaigns.preview(accessOf(req), id);
  }
}
