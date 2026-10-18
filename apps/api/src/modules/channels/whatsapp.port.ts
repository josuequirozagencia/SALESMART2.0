/**
 * Puerto de WhatsApp (ADR-02, ADR-50 #9). El núcleo —Inbox, conversaciones, CRM— solo habla con estos tipos normalizados; ningún módulo importa un SDK ni
 * una forma de mensaje de un proveedor. Cada implementación (Meta Cloud, el fake de pruebas, mañana Evolution/QR) cumple el mismo contract test.
 * M5.1 define lo que usan las conexiones; M5.2 añade la lectura de eventos y M5.4 el envío.
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

export type WhatsAppErrorCode = 'invalid_token' | 'number_not_found' | 'unavailable';

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

export interface WhatsAppProvider {
  readonly name: 'meta_cloud' | 'fake';
  /** Consulta el número con el token dado: sirve para comprobar que ambos son válidos. */
  describeNumber(credentials: WhatsAppCredentials, phoneNumberId: string): Promise<NumberInfo>;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

/** Tipos de contenido que el núcleo entiende; lo demás llega como `unsupported` con su descripción. */
export type MessageKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contacts' | 'reaction' | 'unsupported';

/**
 * Mensaje normalizado (Build Spec §9). Un mismo `externalId` por canal identifica un mensaje (idempotencia). `from` y `to` en E.164 con «+».
 * Se usa a partir de M5.2; se define aquí para que el contrato del puerto sea único.
 */
export interface NormalizedMessage {
  readonly channelAccountId: string;
  readonly externalId: string;
  readonly direction: 'in' | 'out';
  readonly from: string;
  readonly to: string;
  readonly timestamp: Date;
  readonly kind: MessageKind;
  readonly text: string | null;
  /** Referencia al mensaje al que responde, si lo informa el proveedor. */
  readonly replyToExternalId: string | null;
}
