import type { EvolutionConnectionState } from '../channels';
import type { MediaKind, SentMessage } from '../channels';

/**
 * Puerto de la sesión de WhatsApp por QR (M9.6, ADR-54/ADR-31; canal NO OFICIAL). Aparte del puerto de Meta a propósito (decisión 1 de M9.6a): el QR no tiene plantillas, firma ni token por
 * número; tiene una INSTANCIA que se vincula escaneando un QR, un estado de sesión que se cae, y una clave global que es de la plataforma. El núcleo solo ve los tipos normalizados: ningún módulo
 * importa nada de Evolution. Cada implementación (Evolution, el fake) cumple el mismo contract test.
 */

/** Las credenciales de la PLATAFORMA (las guarda el Súper Admin en «Proveedores»; nunca van al navegador ni a un log). */
export interface QrCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * `not_configured` el proveedor no acepta la clave o no hay credenciales · `not_found` la instancia no existe · `session_down` la sesión de WhatsApp no está abierta (hay que escanear otro QR; el mensaje
 * debe esperar) · `unavailable` el servidor de Evolution no respondió (se puede reintentar) · `rate_limited` límite (se puede reintentar) · `recipient_invalid` el número no puede recibir ·
 * `unsupported` este tipo de mensaje no se puede enviar por QR · `rejected` cualquier otro rechazo.
 */
export type QrErrorCode = 'not_configured' | 'not_found' | 'session_down' | 'unavailable' | 'rate_limited' | 'recipient_invalid' | 'unsupported' | 'rejected';

/** ¿Tiene sentido volver a intentar el mismo envío más tarde? Una sesión caída también espera: el mensaje no se pierde ni se reenvía por otra vía. */
export const isRetryableQr = (code: QrErrorCode): boolean => code === 'unavailable' || code === 'rate_limited' || code === 'session_down';

/** Fallo del proveedor traducido a un código nuestro. El mensaje NUNCA lleva la clave, el teléfono ni el texto del cliente. */
export class QrSessionError extends Error {
  constructor(
    readonly code: QrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QrSessionError';
  }
}

export interface QrCodeResult {
  /** La imagen del QR (PNG en base64, con o sin prefijo `data:`), o null si la sesión ya está abierta o aún no hay QR. */
  readonly base64: string | null;
  readonly state: EvolutionConnectionState;
}

export interface QrSendMedia {
  /** Teléfono de destino en dígitos (sin «+»). */
  readonly to: string;
  readonly kind: MediaKind;
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly filename: string | null;
  readonly caption: string | null;
}

export interface QrSessionProvider {
  readonly name: 'evolution' | 'fake';
  /** Crea la instancia y le dice a qué dirección avisar. `webhookUrl` ya lleva el token: es un secreto. Lanza `QrSessionError`. */
  createInstance(credentials: QrCredentials, input: { instance: string; webhookUrl: string }): Promise<void>;
  /** Pide un QR nuevo (dura ~30 s; un QR sin escanear se agota tras unas renovaciones). */
  requestQr(credentials: QrCredentials, instance: string): Promise<QrCodeResult>;
  /** El estado de la sesión AHORA (el latido lo usa porque los avisos pueden perderse). */
  state(credentials: QrCredentials, instance: string): Promise<EvolutionConnectionState>;
  /** Cierra la sesión de WhatsApp de la instancia (el teléfono queda desvinculado). */
  logout(credentials: QrCredentials, instance: string): Promise<void>;
  /** Borra la instancia en Evolution. Una instancia que ya no existe NO es un error. */
  deleteInstance(credentials: QrCredentials, instance: string): Promise<void>;
  sendText(credentials: QrCredentials, instance: string, input: { to: string; text: string }): Promise<SentMessage>;
  sendMedia(credentials: QrCredentials, instance: string, input: QrSendMedia): Promise<SentMessage>;
}

export const QR_SESSION = Symbol('QR_SESSION');
