import type { NormalizedInboundEvent } from '../conversations';

/**
 * Puerto de WhatsApp (ADR-02, ADR-50 #9). El núcleo —Inbox, conversaciones, CRM— solo habla con los tipos normalizados de `conversations`; ningún módulo
 * importa una forma de mensaje de un proveedor. Cada implementación (Meta Cloud, el fake de pruebas, mañana Evolution/QR) cumple el mismo contract test.
 * M5.1 define lo que usan las conexiones; M5.2 añade la verificación y la lectura de los avisos entrantes; M5.4 añadirá el envío.
 */

/** Credenciales de UN número (las descifra la bóveda justo antes de usarlas; nunca se registran). */
export interface WhatsAppCredentials {
  readonly accessToken: string;
}

/** Lo que el proveedor sabe de un número. */
export interface NumberInfo {
  /** Número visible, en el formato del proveedor («+593 98 421 7730»). */
  readonly displayPhone: string;
  /** Nombre verificado del negocio, si el proveedor lo informa. */
  readonly verifiedName: string | null;
}

/**
 * `invalid_token` el proveedor no acepta el token · `number_not_found` no encuentra el número · `unavailable` no respondió o falló de su lado (se puede reintentar) ·
 * `rate_limited` límite de envíos (se puede reintentar) · `window_closed` pasaron las 24 h: solo plantillas · `recipient_invalid` el destinatario no puede recibir
 * (número inválido, sin WhatsApp, fuera de la lista de prueba) · `rejected` cualquier otro rechazo del proveedor.
 */
export type WhatsAppErrorCode = 'invalid_token' | 'number_not_found' | 'unavailable' | 'rate_limited' | 'window_closed' | 'recipient_invalid' | 'rejected';

/** ¿Tiene sentido volver a intentar el mismo envío más tarde? Solo si el fallo fue pasajero. */
export const isRetryableError = (code: WhatsAppErrorCode): boolean => code === 'unavailable' || code === 'rate_limited';

/** Fallo del proveedor, traducido a un código nuestro. El mensaje NUNCA incluye el token ni datos del cliente. */
export class WhatsAppProviderError extends Error {
  constructor(
    readonly code: WhatsAppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WhatsAppProviderError';
  }
}

/** Lo que se entiende de un aviso entrante del proveedor. */
export interface ParsedWebhook {
  /** Un elemento por cada aviso de un número. `raw` es la parte original de ese aviso, para poder reprocesarla igual. */
  readonly events: ReadonlyArray<{ readonly event: NormalizedInboundEvent; readonly raw: Record<string, unknown> }>;
  /** Cuántos mensajes o estados se descartaron (tipo que no usamos, teléfono inválido, formato roto). */
  readonly ignored: number;
}

/** Mensaje de texto a enviar. `to` es el teléfono de destino en dígitos (sin «+»), tal como lo informó el proveedor. */
export interface SendTextInput {
  readonly to: string;
  readonly text: string;
}

export interface SentMessage {
  /** Identificador que el proveedor le dio al mensaje: con él llegarán sus estados de entrega. */
  readonly externalId: string;
}

export interface WhatsAppProvider {
  readonly name: 'meta_cloud' | 'fake';
  /** Consulta el número con el token dado: sirve para comprobar que ambos son válidos. */
  describeNumber(credentials: WhatsAppCredentials, phoneNumberId: string): Promise<NumberInfo>;
  /** Envía un mensaje de texto desde el número. Lanza `WhatsAppProviderError` (con un mensaje seguro: sin token ni texto del cliente) si no se pudo. */
  sendText(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTextInput): Promise<SentMessage>;
  /** ¿El aviso entrante lo firmó de verdad el proveedor? `rawBody` es el cuerpo EXACTO recibido; `appSecret`, el secreto de la aplicación de la plataforma. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean;
  /** Lee un aviso entrante (ya verificado) y lo traduce a eventos normalizados, uno por número. Nunca lanza por un contenido mal formado. */
  parseWebhook(body: unknown, now?: Date): ParsedWebhook;
  /** Vuelve a leer la parte `raw` de un aviso guardado. */
  parseStored(raw: Record<string, unknown>, now?: Date): ParsedWebhook;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
