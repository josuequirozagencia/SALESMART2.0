import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { endpointSchema, subscribeSchema, type EndpointInput, type SubscribeInput } from './push.dto';
import { PushService } from './push.service';

/**
 * Notificaciones push del navegador (v6 fase E, ADR-64). La empresa y la persona salen del contexto verificado. Ver el estado exige `notifications.read`; suscribirse o darse de baja,
 * `notifications.write` (en «Ver como» o con solo lectura no se puede). Las direcciones de suscripción van en el cuerpo, nunca en la URL, y jamás se devuelven. `no-store`.
 */
@Controller('push')
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  /** ¿Puede este servidor mandar push? y la clave pública VAPID para suscribirse. */
  @RequirePermission('notifications.read')
  @Get('config')
  @Header('Cache-Control', 'no-store')
  config() {
    return this.push.config();
  }

  /** ¿Está suscrito este navegador (por su dirección) para esta persona? */
  @RequirePermission('notifications.read')
  @Post('status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  status(@Body(new ZodValidationPipe(endpointSchema)) body: EndpointInput) {
    return this.push.status(body);
  }

  @RequirePermission('notifications.write')
  @Post('subscribe')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  subscribe(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(subscribeSchema)) body: SubscribeInput) {
    const ua = req.headers['user-agent'];
    return this.push.subscribe(body, typeof ua === 'string' ? ua : undefined);
  }

  @RequirePermission('notifications.write')
  @Post('unsubscribe')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  unsubscribe(@Body(new ZodValidationPipe(endpointSchema)) body: EndpointInput) {
    return this.push.unsubscribe(body);
  }
}
