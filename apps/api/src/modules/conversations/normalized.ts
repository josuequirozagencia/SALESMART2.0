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

/**
 * De dónde llegó el mensaje, cuando fue un clic a un anuncio (Click-to-WhatsApp, M6.6): lo informa Meta en el PRIMER mensaje tras el clic. Todo es opcional; sin `ctwaClid` no se puede
 * atribuir (ni informar a Meta) y se trata como un mensaje normal.
 */
export interface NormalizedReferral {
  /** Id del anuncio (o de la publicación) de Meta. */
  readonly sourceId: string | null;
  /** `ad` o `post`. */
  readonly sourceType: string | null;
  readonly sourceUrl: string | null;
  readonly headline: string | null;
  readonly body: string | null;
  readonly thumbnailUrl: string | null;
  readonly ctwaClid: string | null;
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
  /** Si el mensaje llegó por un clic a un anuncio (M6.6). */
  readonly referral?: NormalizedReferral | null;
  /**
   * Quién lo escribió. Ausente o `contact`: el cliente (entra). `device` (v9, WhatsApp por QR): lo escribió la persona dueña de la línea desde su TELÉFONO; en ese caso `from` sigue siendo el CLIENTE
   * (el destinatario) y el mensaje se guarda como de salida, sin autor de la plataforma.
   */
  readonly origin?: 'contact' | 'device';
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

/** Reacción del cliente a un mensaje (nuestro o suyo). `emoji` null = quitó su reacción. Un cliente tiene una sola reacción por mensaje: la última reemplaza a la anterior. */
export interface NormalizedReaction {
  /** Identificador, en el proveedor, del mensaje al que reacciona. */
  readonly targetExternalId: string;
  readonly emoji: string | null;
  readonly at: Date;
}

/** Todo lo que un proveedor avisó de UN número en un mismo aviso. */
export interface NormalizedInboundEvent {
  /** Identificador del número de la empresa al que llegó (con él se resuelve la empresa). */
  readonly phoneNumberId: string;
  readonly messages: readonly NormalizedMessage[];
  readonly statuses: readonly NormalizedStatus[];
  readonly reactions: readonly NormalizedReaction[];
}
