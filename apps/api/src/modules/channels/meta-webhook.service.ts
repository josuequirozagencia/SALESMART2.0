import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, ServiceUnavailableError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { ChannelRoutesService } from '../organizations';
import { PlatformCredentialsReader } from '../platform';
import { WebhookEventsService } from './webhook-events.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './whatsapp.port';

/** Servicio de la plataforma donde el Súper Admin guarda la aplicación de Meta (catálogo de proveedores). */
export const WHATSAPP_SERVICE = 'whatsapp_official';
const WHATSAPP_META = 'meta_cloud';

export interface ReceiveResult {
  /** Avisos nuevos guardados para procesar. */
  stored: number;
  /** Avisos que ya teníamos (Meta reintentó la misma entrega). */
  duplicates: number;
  /** Avisos de un número que no está conectado en ninguna empresa (se ignoran sin revelar nada). */
  unknownNumbers: number;
  /** Mensajes o estados que no se pudieron leer o que no usamos. */
  ignored: number;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Entrada del webhook de la aplicación de Meta (M5.2, ADR-50 #2). UNA sola URL para todas las empresas: la empresa NO sale de la URL ni del contenido en
 * bruto, sino del `phone_number_id` del aviso, que se busca en la ruta de identidad `channel_routes`. La autenticidad la da la firma `X-Hub-Signature-256`
 * calculada con el secreto de la aplicación de la plataforma; la verificación inicial usa el token de verificación de esa misma aplicación (los dos los guarda
 * el Súper Admin en «Proveedores › WhatsApp oficial»). Sin ellos, 503. Un número desconocido se ignora igual que uno conocido (200 sin efecto).
 */
@Injectable()
export class MetaWebhookService {
  constructor(
    @Inject(PlatformCredentialsReader) private readonly credentials: PlatformCredentialsReader,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(WebhookEventsService) private readonly events: WebhookEventsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Verificación inicial de Meta (GET): devuelve el desafío SOLO si el modo es `subscribe` y el token coincide. */
  async challenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): Promise<string> {
    const app = await this.app();
    if (mode !== 'subscribe' || !token || !challenge || !safeEqual(token, app.verifyToken)) throw new ForbiddenError('WEBHOOK_REJECTED', 'No se pudo verificar el origen del aviso');
    return challenge;
  }

  /** Aviso entrante (POST). `rawBody` es el cuerpo EXACTO recibido: la firma se calcula sobre esos bytes. */
  async receive(rawBody: Buffer, signature: string | undefined): Promise<ReceiveResult> {
    const app = await this.app();
    if (!this.provider.verifyWebhook(rawBody, signature, app.appSecret)) throw new ForbiddenError('WEBHOOK_REJECTED', 'No se pudo verificar el origen del aviso');
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ValidationError([{ path: 'body', code: 'invalid_json', message: 'El cuerpo no es JSON válido' }]);
    }
    const parsed = this.provider.parseWebhook(body);
    const result: ReceiveResult = { stored: 0, duplicates: 0, unknownNumbers: 0, ignored: parsed.ignored };
    for (const { event, raw } of parsed.events) {
      const route = await this.routes.resolve(event.phoneNumberId);
      if (!route) {
        result.unknownNumbers += 1;
        continue;
      }
      const isNew = await TenantContext.run({ organizationId: route.organizationId }, () => this.events.store(route.channelAccountId, event.phoneNumberId, raw));
      if (isNew) result.stored += 1;
      else result.duplicates += 1;
    }
    // Solo cuentas: ni teléfonos ni texto de los mensajes llegan al registro
    this.log.info({ stored: result.stored, duplicates: result.duplicates, unknown_numbers: result.unknownNumbers, ignored: result.ignored }, 'webhook de WhatsApp recibido');
    return result;
  }

  /** Secreto de la aplicación y token de verificación del proveedor EN USO; 503 si la plataforma no los tiene cargados. */
  private async app(): Promise<{ appSecret: string; verifyToken: string }> {
    const c = await this.credentials.active(WHATSAPP_SERVICE);
    const appSecret = c?.provider === WHATSAPP_META ? c.values['app_secret'] : undefined;
    const verifyToken = c?.provider === WHATSAPP_META ? c.values['verify_token'] : undefined;
    if (!appSecret || !verifyToken) throw new ServiceUnavailableError('WEBHOOK_NOT_CONFIGURED', 'El webhook de WhatsApp aún no está configurado en la plataforma');
    return { appSecret, verifyToken };
  }
}
