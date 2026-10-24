import { Body, Controller, Header, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { TooManyAttemptsError } from '../../errors';
import { Public, WindowLimiter, ZodValidationPipe } from '../../http';
import { GhlWebhookService } from './ghl-webhook.service';

const WEBHOOK_LIMIT = 120; // peticiones por minuto y por (IP, ruta)
const WINDOW_MS = 60_000;

/**
 * Entrada de avisos del Workflow de GoHighLevel (M7.2, ADR-52/ADR-05). PÚBLICA: la credencial es el identificador opaco de la URL + el secreto de la cabecera `X-Webhook-Secret`.
 * Responde 200 apenas guarda el aviso (el proceso es asíncrono). El cuerpo se lee como JSON de tamaño acotado por el servidor; sin esquema estricto a propósito (GHL manda muchos campos
 * que no usamos): el contrato lo valida `normalizeGhlPayload` y lo que no se conoce nunca se guarda.
 */
@Public()
@Controller('integrations/ghl')
export class GhlWebhookController {
  private readonly limiter = new WindowLimiter(WEBHOOK_LIMIT, WINDOW_MS);

  constructor(@Inject(GhlWebhookService) private readonly webhook: GhlWebhookService) {}

  @Post('webhook/:routeId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Param('routeId', new ZodValidationPipe(z.uuid())) routeId: string, @Headers('x-webhook-secret') secret: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    const gate = this.limiter.take(`${req.ip ?? '?'}|${routeId}`);
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    await this.webhook.ingest(routeId, secret, body); // la empresa sale de la ruta, dentro del servicio
    return { ok: true };
  }
}
