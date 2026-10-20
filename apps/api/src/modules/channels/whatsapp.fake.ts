import { parseMetaWebhook, verifyMetaSignature, wrapMetaValue } from './meta-webhook';
import { WhatsAppProviderError, type NormalizedTemplate, type NumberInfo, type ParsedWebhook, type SendTemplateInput, type SendTextInput, type SentMessage, type TemplateSendComponent, type WhatsAppCredentials, type WhatsAppErrorCode, type WhatsAppProvider } from './whatsapp.port';

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

/** Un mensaje que el fake «envió». Si fue una plantilla, `text` es `[plantilla] nombre` y `template` trae lo enviado. */
export interface FakeSent {
  readonly phoneNumberId: string;
  readonly to: string;
  readonly text: string;
  readonly externalId: string;
  readonly template?: { readonly name: string; readonly language: string; readonly components: readonly TemplateSendComponent[] };
}

const ex = (o: Record<string, string>): Readonly<Record<string, string>> => o;
const base = { parameterFormat: 'positional', footer: null, buttons: [], unsupported: [], rejectedReason: null } as const;

/** Las plantillas de ejemplo del fake: una de cada situación que la interfaz debe manejar (con variables, con botones, con variables con nombre, y las que NO se pueden enviar). */
export const FAKE_TEMPLATES: readonly NormalizedTemplate[] = [
  { ...base, externalId: 'tpl-1', name: 'bienvenida', language: 'es', category: 'utility', status: 'approved', header: null, body: { text: 'Hola, gracias por escribirnos. Aquí estamos para ayudarte.', examples: ex({}) }, footer: 'Barbería Norte' },
  { ...base, externalId: 'tpl-2', name: 'recordatorio_cita', language: 'es', category: 'utility', status: 'approved', header: null, body: { text: 'Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}.', examples: ex({ '1': 'Ana', '2': 'viernes 24', '3': '10:00' }) }, footer: 'Responde para confirmar', buttons: [{ type: 'quick_reply', text: 'Confirmar', url: null, phone: null }, { type: 'quick_reply', text: 'Reprogramar', url: null, phone: null }] },
  { ...base, externalId: 'tpl-3', name: 'promo_corte', language: 'es', category: 'marketing', status: 'approved', header: { format: 'text', text: 'Promo para {{1}}', examples: ex({ '1': 'Ana' }) }, body: { text: 'Este mes tu corte tiene 20% de descuento. Reserva con el código {{1}}.', examples: ex({ '1': 'CORTE20' }) }, buttons: [{ type: 'url', text: 'Reservar', url: 'https://barberia.example/reservar/{{1}}', phone: null }, { type: 'phone', text: 'Llamar', url: null, phone: '+593984217730' }] },
  { ...base, externalId: 'tpl-4', name: 'seguimiento_nombrado', language: 'es', category: 'utility', status: 'approved', parameterFormat: 'named', header: null, body: { text: 'Hola {{nombre}}, ¿pudiste revisar la propuesta de {{servicio}}?', examples: ex({ nombre: 'Ana', servicio: 'corte y barba' }) } },
  { ...base, externalId: 'tpl-5', name: 'catalogo_imagen', language: 'es', category: 'marketing', status: 'approved', header: { format: 'image', text: null, examples: ex({}) }, body: { text: 'Mira nuestro catálogo de este mes.', examples: ex({}) } },
  { ...base, externalId: 'tpl-6', name: 'codigo_acceso', language: 'es', category: 'authentication', status: 'approved', header: null, body: { text: 'Tu código de verificación es {{1}}.', examples: ex({ '1': '123456' }) } },
  { ...base, externalId: 'tpl-7', name: 'en_revision', language: 'es', category: 'utility', status: 'pending', header: null, body: { text: 'Tu pedido {{1}} está en camino.', examples: ex({ '1': '#123' }) } },
  { ...base, externalId: 'tpl-8', name: 'rechazada_ejemplo', language: 'es', category: 'marketing', status: 'rejected', header: null, body: { text: 'Compra ahora con descuento.', examples: ex({}) }, rejectedReason: 'Contenido promocional en una plantilla que no es de marketing' },
  { ...base, externalId: 'tpl-9', name: 'pausada_calidad', language: 'es', category: 'marketing', status: 'paused', header: null, body: { text: 'Hoy tenemos una oferta para ti.', examples: ex({}) } },
  { ...base, externalId: 'tpl-10', name: 'bienvenida', language: 'en_US', category: 'utility', status: 'approved', header: null, body: { text: 'Hello, thanks for writing to us.', examples: ex({}) } },
];

/** Cuántas variables distintas lleva un texto de plantilla. */
const variablesIn = (text: string | null | undefined): Set<string> => new Set([...(text ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!));

/**
 * WhatsApp de mentira (ADR-50 #9): determinista y sin red. Acepta `FAKE_WHATSAPP_TOKEN`; un número que empieza por `FAKE_UNKNOWN_PREFIX` no existe y
 * `FAKE_UNAVAILABLE_ID` simula una caída del proveedor. Cumple el mismo contract test que el adaptador de Meta.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake' as const;
  readonly calls: Array<{ phoneNumberId: string }> = [];
  /** Todo lo que se «envió» con éxito, en orden (las pruebas lo miran). */
  readonly outbox: FakeSent[] = [];
  /** Las plantillas que «tiene» la cuenta de WhatsApp Business (las pruebas las cambian). */
  templates: NormalizedTemplate[] = [...FAKE_TEMPLATES];
  /** Las cuentas (WABA) cuyas plantillas se pidieron. */
  readonly listed: string[] = [];
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

  listTemplates(credentials: WhatsAppCredentials, wabaId: string): Promise<readonly NormalizedTemplate[]> {
    this.listed.push(wabaId);
    if (wabaId === FAKE_UNAVAILABLE_ID) return Promise.reject(new WhatsAppProviderError('unavailable', 'El proveedor no responde'));
    if (credentials.accessToken !== FAKE_WHATSAPP_TOKEN) return Promise.reject(new WhatsAppProviderError('invalid_token', 'El proveedor rechazó el token'));
    if (wabaId.startsWith(FAKE_UNKNOWN_PREFIX)) return Promise.reject(new WhatsAppProviderError('number_not_found', 'El proveedor no encontró la cuenta de WhatsApp Business'));
    return Promise.resolve(this.templates.map((t) => ({ ...t })));
  }

  sendTemplate(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTemplateInput): Promise<SentMessage> {
    if (phoneNumberId === FAKE_UNAVAILABLE_ID) return Promise.reject(new WhatsAppProviderError('unavailable', 'El proveedor no responde'));
    if (!/^[0-9]{8,15}$/.test(input.to)) return Promise.reject(new WhatsAppProviderError('recipient_invalid', 'El número de destino no es válido'));
    if (credentials.accessToken !== FAKE_WHATSAPP_TOKEN) return Promise.reject(new WhatsAppProviderError('invalid_token', 'El proveedor rechazó el token'));
    if (phoneNumberId.startsWith(FAKE_UNKNOWN_PREFIX)) return Promise.reject(new WhatsAppProviderError('number_not_found', 'El proveedor no encontró el número de la conexión'));
    const t = this.templates.find((x) => x.name === input.name && x.language === input.language);
    if (!t || t.status !== 'approved') return Promise.reject(new WhatsAppProviderError('template_unavailable', 'La plantilla ya no está disponible'));
    // Como Meta: la cantidad de datos que se envían por parte debe coincidir con las variables de la plantilla
    const given = (type: TemplateSendComponent['type']): number => input.components.filter((c) => c.type === type).reduce((n, c) => n + c.parameters.length, 0);
    const urlVars = t.buttons.filter((b) => b.type === 'url').reduce((n, b) => n + variablesIn(b.url).size, 0);
    if (given('header') !== variablesIn(t.header?.text).size || given('body') !== variablesIn(t.body?.text).size || given('button') !== urlVars) {
      return Promise.reject(new WhatsAppProviderError('template_params', 'Los datos de la plantilla no coinciden con lo que pide'));
    }
    const first = input.components.flatMap((c) => c.parameters.map((p) => p.text));
    for (const text of first) {
      const tag = Object.keys(FAKE_SEND_FAILURES).find((k) => text.startsWith(k));
      if (tag) {
        const [code, message] = FAKE_SEND_FAILURES[tag]!;
        return Promise.reject(new WhatsAppProviderError(code, message));
      }
    }
    this.counter += 1;
    const externalId = `wamid.FAKE.${this.counter}`;
    this.outbox.push({ phoneNumberId, to: input.to, text: `[plantilla] ${input.name}`, externalId, template: { name: input.name, language: input.language, components: input.components } });
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
