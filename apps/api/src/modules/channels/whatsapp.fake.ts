import { parseMetaWebhook, verifyMetaSignature, wrapMetaValue } from './meta-webhook';
import { WhatsAppProviderError, type NumberInfo, type ParsedWebhook, type SendTextInput, type SentMessage, type WhatsAppCredentials, type WhatsAppErrorCode, type WhatsAppProvider } from './whatsapp.port';

/** Token que el fake da por válido (solo desarrollo y pruebas; la configuración prohíbe el fake en producción). */
export const FAKE_WHATSAPP_TOKEN = 'fake-valid-token';
/** Un número cuyo id empieza por esto «no existe» en el fake. */
export const FAKE_UNKNOWN_PREFIX = '00000';
/** Con este id el fake simula que Meta no responde. */
export const FAKE_UNAVAILABLE_ID = '99999999';

/** Con estas marcas al inicio del texto el fake simula un fallo del proveedor en el envío (solo desarrollo y pruebas). */
export const FAKE_SEND_FAILURES: Readonly<Record<string, [WhatsAppErrorCode, string]>> = {
  '[fallar:caida]': ['unavailable', 'El proveedor no responde'],
  '[fallar:limite]': ['rate_limited', 'El proveedor limitó los envíos por ahora'],
  '[fallar:ventana]': ['window_closed', 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se admite una plantilla aprobada'],
  '[fallar:numero]': ['recipient_invalid', 'El proveedor no pudo entregar el mensaje a ese número'],
  '[fallar:rechazo]': ['rejected', 'El proveedor rechazó el mensaje'],
};

/** Un mensaje que el fake «envió». */
export interface FakeSent {
  readonly phoneNumberId: string;
  readonly to: string;
  readonly text: string;
  readonly externalId: string;
}

/**
 * WhatsApp de mentira (ADR-50 #9): determinista y sin red. Acepta `FAKE_WHATSAPP_TOKEN`; un número que empieza por `FAKE_UNKNOWN_PREFIX` no existe y
 * `FAKE_UNAVAILABLE_ID` simula una caída del proveedor. Cumple el mismo contract test que el adaptador de Meta.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake' as const;
  readonly calls: Array<{ phoneNumberId: string }> = [];
  /** Todo lo que se «envió» con éxito, en orden (las pruebas lo miran). */
  readonly outbox: FakeSent[] = [];
  private counter = 0;

  sendText(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTextInput): Promise<SentMessage> {
    if (phoneNumberId === FAKE_UNAVAILABLE_ID) return Promise.reject(new WhatsAppProviderError('unavailable', 'El proveedor no responde'));
    // Mismas validaciones y mismo orden que el adaptador de Meta: destino y texto se revisan antes de «salir a la red»
    if (!/^[0-9]{8,15}$/.test(input.to)) return Promise.reject(new WhatsAppProviderError('recipient_invalid', 'El número de destino no es válido'));
    if (input.text === '' || input.text.length > 4096) return Promise.reject(new WhatsAppProviderError('rejected', 'El texto no es válido para WhatsApp'));
    if (credentials.accessToken !== FAKE_WHATSAPP_TOKEN) return Promise.reject(new WhatsAppProviderError('invalid_token', 'El proveedor rechazó el token'));
    if (phoneNumberId.startsWith(FAKE_UNKNOWN_PREFIX)) return Promise.reject(new WhatsAppProviderError('number_not_found', 'El proveedor no encontró el número de la conexión'));
    const tag = Object.keys(FAKE_SEND_FAILURES).find((k) => input.text.startsWith(k));
    if (tag) {
      const [code, message] = FAKE_SEND_FAILURES[tag]!;
      return Promise.reject(new WhatsAppProviderError(code, message));
    }
    this.counter += 1;
    const externalId = `wamid.FAKE.${this.counter}`;
    this.outbox.push({ phoneNumberId, to: input.to, text: input.text, externalId });
    return Promise.resolve({ externalId });
  }

  // Los avisos del fake hablan el mismo formato que Meta (HMAC-SHA256 y la misma forma de mensajes): así el webhook completo se prueba sin Meta
  verifyWebhook(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
    return verifyMetaSignature(rawBody, signature, appSecret);
  }

  parseWebhook(body: unknown, now?: Date): ParsedWebhook {
    return parseMetaWebhook(body, now);
  }

  parseStored(raw: Record<string, unknown>, now?: Date): ParsedWebhook {
    return parseMetaWebhook(wrapMetaValue(raw), now);
  }

  describeNumber(credentials: WhatsAppCredentials, phoneNumberId: string): Promise<NumberInfo> {
    this.calls.push({ phoneNumberId });
    if (phoneNumberId === FAKE_UNAVAILABLE_ID) return Promise.reject(new WhatsAppProviderError('unavailable', 'El proveedor no responde'));
    if (credentials.accessToken !== FAKE_WHATSAPP_TOKEN) return Promise.reject(new WhatsAppProviderError('invalid_token', 'El proveedor rechazó el token'));
    if (phoneNumberId.startsWith(FAKE_UNKNOWN_PREFIX)) return Promise.reject(new WhatsAppProviderError('number_not_found', 'El proveedor no encontró ese número'));
    return Promise.resolve({ displayPhone: `+1 555 ${phoneNumberId.slice(-4).padStart(4, '0')}`, verifiedName: 'Negocio de prueba' });
  }
}
