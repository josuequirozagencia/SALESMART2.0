import { Body, Controller, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError, TooManyAttemptsError } from '../../errors';
import { Public, WindowLimiter } from '../../http';
import { QrWebhookService } from './qr-webhook.service';

/** Evolution puede mandar ráfagas (cada estado y cada mensaje es un aviso): el límite es holgado y cuenta solo por (IP, ruta). */
const WEBHOOK_LIMIT = 1_200;
const WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entrada de los avisos de WhatsApp por QR (Evolution API, M9.6, ADR-54/ADR-05). PÚBLICA: la credencial es el identificador opaco de la dirección + el token `?token=`. Responde 200 en cuanto guarda el
 * aviso (el proceso es asíncrono). El cuerpo llega leído como JSON con un límite de 25 MB solo en esta ruta (los archivos van en base64). Cualquier identificador o token inválido: 404 uniforme.
 */
@Public()
@Controller('integrations/qr')
export class QrWebhookController {
  private readonly limiter = new WindowLimiter(WEBHOOK_LIMIT, WINDOW_MS);

  constructor(@Inject(QrWebhookService) private readonly webhook: QrWebhookService) {}

  @Post('webhook/:routeId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Param('routeId') routeId: string, @Query('token') token: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<{ ok: true }> {
    if (!UUID.test(routeId)) throw new NotFoundError();
    const gate = this.limiter.take(`${req.ip ?? '?'}|${routeId}`);
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    await this.webhook.ingest(routeId, typeof token === 'string' ? token : undefined, body);
    return { ok: true };
  }
}
