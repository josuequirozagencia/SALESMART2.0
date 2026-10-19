import { Controller, Get, Header, Headers, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError, TooManyAttemptsError, ValidationError } from '../../errors';
import { Public, WindowLimiter } from '../../http';
import { MetaWebhookService } from './meta-webhook.service';

/** Intentos FALLIDOS (firma o token equivocados) por minuto y por IP antes de responder 429. Los avisos con firma válida no cuentan: Meta puede enviar muchos. */
const FAILURE_LIMIT = 30;
const WINDOW_MS = 60_000;

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Webhook de la aplicación de Meta (M5.2, ADR-50 #2). PÚBLICO: no hay sesión; la credencial es la firma del aviso. Un cuerpo que no llegó como `Buffer` (la
 * ruta lo lee crudo en `configureApp`) no se puede verificar y se rechaza. Los fallos de firma o de token cuentan contra la IP.
 */
@Public()
@Controller('channels/meta')
export class MetaWebhookController {
  private readonly failures = new WindowLimiter(FAILURE_LIMIT, WINDOW_MS);

  constructor(@Inject(MetaWebhookService) private readonly webhook: MetaWebhookService) {}

  /** Verificación al suscribir el webhook en el panel de Meta: devuelve el desafío tal cual, como texto plano. */
  @Get('webhook')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async verify(@Query() query: Record<string, unknown>, @Req() req: Request): Promise<string> {
    const ip = req.ip ?? '?';
    this.guard(ip);
    try {
      return await this.webhook.challenge(one(query['hub.mode']), one(query['hub.verify_token']), one(query['hub.challenge']));
    } catch (e) {
      throw this.count(e, ip);
    }
  }

  @Post('webhook')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') signature: string | undefined): Promise<{ ok: true }> {
    const ip = req.ip ?? '?';
    this.guard(ip);
    // Sin el cuerpo exacto no hay firma que comprobar (p. ej. una ruta con barra final que no pasó por el lector crudo)
    if (!Buffer.isBuffer(req.body)) throw new ValidationError([{ path: 'body', code: 'invalid', message: 'El cuerpo no se pudo leer' }]);
    try {
      await this.webhook.receive(req.body, signature);
    } catch (e) {
      throw this.count(e, ip);
    }
    return { ok: true };
  }

  private guard(ip: string): void {
    const b = this.failures.blocked(ip);
    if (b) throw new TooManyAttemptsError(b.retryAfterSeconds);
  }

  /** Cuenta un fallo de autenticación contra la IP y devuelve el mismo error. */
  private count(e: unknown, ip: string): unknown {
    if (e instanceof ForbiddenError) this.failures.take(ip);
    return e;
  }
}
