import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { TooManyAttemptsError } from '../../errors';
import { Public, WindowLimiter, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { AttributionEndpointsService } from '../organizations';
import { ctwaWebhookSchema, type CtwaWebhookDto } from './attribution.dto';
import { AttributionService } from './attribution.service';

const idParam = new ZodValidationPipe(z.uuid());
const WEBHOOK_LIMIT = 120; // peticiones por minuto y por (IP, punto de entrada)
const WINDOW_MS = 60_000;

/**
 * Entrada de clics de Click-to-WhatsApp (M3.3, ADR-45). PÚBLICA: no hay sesión. La credencial es el par (identificador opaco de la URL + secreto en la cabecera
 * `X-Webhook-Secret`); la empresa sale de ahí, nunca del cuerpo. Un identificador desconocido y un secreto equivocado responden lo mismo (404). Límite de
 * peticiones, esquema estricto e idempotencia por `ctwa_cl_id`.
 */
@Public()
@Controller('attribution')
export class AttributionWebhookController {
  private readonly limiter = new WindowLimiter(WEBHOOK_LIMIT, WINDOW_MS);

  constructor(
    @Inject(AttributionService) private readonly attribution: AttributionService,
  ) {}

  @Post('ctwa/:endpointId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async ctwa(
    @Param('endpointId', idParam) endpointId: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body(new ZodValidationPipe(ctwaWebhookSchema)) body: CtwaWebhookDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const gate = this.limiter.take(`${req.ip ?? '?'}|${endpointId}`);
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    await this.attribution.ingest(endpointId, secret, body); // la empresa sale del punto de entrada, dentro del servicio
    return { ok: true };
  }
}

/** Gestión del punto de entrada por el administrador de la empresa (`integrations.manage`). El secreto solo se muestra al generarlo. */
@Controller('attribution')
export class AttributionEndpointController {
  constructor(@Inject(AttributionEndpointsService) private readonly endpoints: AttributionEndpointsService) {}

  @RequirePermission('integrations.manage')
  @Get('endpoint')
  @Header('Cache-Control', 'no-store')
  async status() {
    const s = await this.endpoints.status();
    return { ...s, path: s.id ? `/v1/attribution/ctwa/${s.id}` : null };
  }

  /** Crea el punto de entrada o regenera su secreto (el anterior deja de servir). */
  @RequirePermission('integrations.manage')
  @Post('endpoint')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async issue() {
    const r = await this.endpoints.issue();
    return { id: r.id, secret: r.secret, rotated: r.rotated, path: `/v1/attribution/ctwa/${r.id}` };
  }
}
