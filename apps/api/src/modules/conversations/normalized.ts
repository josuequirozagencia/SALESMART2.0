/**
 * Tipos NORMALIZADOS de mensajería (Build Spec §9, ADR-50 #9). Es lo único que el núcleo —conversaciones, CRM, Inbox— conoce de un canal: ningún módulo
 * importa una forma de mensaje de un proveedor. Cada adaptador (Meta Cloud, el fake, mañana Evolution/QR) traduce lo suyo a esto.
 */

/** Tipos de contenido que el núcleo entiende. Lo demás llega como `unsupported`. */
export type InboundKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contacts' | 'interactive' | 'button' | 'unsupported';

/** Referencia a un archivo adjunto que el proveedor aún guarda (hasta M5.6 no lo descargamos). */
export interface NormalizedMedia {
  /** Identificador del archivo en el proveedor. */
  readonly id: string;
  readonly mimeType: string | null;
  readonly filename: string | null;
}

/** Mensaje que ENTRA: lo escribió un contacto. Un mismo `externalId` por canal identifica un mensaje (idempotencia). */
export interface NormalizedMessage {
  readonly externalId: string;
  /** Teléfono de quien escribe, en E.164 con «+». */
  readonly from: string;
  /** Identificador de quien escribe tal como lo informó el proveedor (sin normalizar; para depurar). */
  readonly fromRaw: string;
  /** Nombre del perfil del contacto en el proveedor, si lo informa. */
  readonly profileName: string | null;
  readonly kind: InboundKind;
  /** Texto del mensaje, o el pie de un adjunto, o el título del botón elegido. */
  readonly text: string | null;
  readonly media: NormalizedMedia | null;
  /** Datos propios del tipo (ubicación, cantidad de contactos…). Nunca credenciales. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** Cuándo lo envió el contacto (la hora que informa el proveedor). */
  readonly sentAt: Date;
}

/** Estado de un mensaje que SALIÓ, según el proveedor. */
export type DeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

export interface NormalizedStatus {
  readonly externalId: string;
  readonly state: DeliveryState;
  readonly at: Date;
  /** Solo para `failed`: código y título del error del proveedor (sin datos del cliente). */
  readonly error: { readonly code: string; readonly title: string } | null;
}

/** Todo lo que un proveedor avisó de UN número en un mismo aviso. */
export interface NormalizedInboundEvent {
  /** Identificador del número de la empresa al que llegó (con él se resuelve la empresa). */
  readonly phoneNumberId: string;
  readonly messages: readonly NormalizedMessage[];
  readonly statuses: readonly NormalizedStatus[];
}
