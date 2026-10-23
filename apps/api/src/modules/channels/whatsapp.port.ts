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
 * (número inválido, sin WhatsApp, fuera de la lista de prueba) · `template_unavailable` la plantilla ya no existe o está en pausa o deshabilitada · `template_params` las
 * variables enviadas no coinciden con lo que la plantilla pide · `media_rejected` el proveedor no aceptó el archivo (tipo o tamaño) · `media_unavailable` el archivo que el
 * cliente mandó ya no está en el proveedor (vence) · `rejected` cualquier otro rechazo del proveedor.
 */
export type WhatsAppErrorCode = 'invalid_token' | 'number_not_found' | 'unavailable' | 'rate_limited' | 'window_closed' | 'recipient_invalid' | 'template_unavailable' | 'template_params' | 'media_rejected' | 'media_unavailable' | 'rejected';

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

// ── Plantillas (M5.6a) ──────────────────────────────────────────────────────

/** Categoría que Meta le asigna a la plantilla (de ella depende el cobro). */
export type TemplateCategory = 'marketing' | 'utility' | 'authentication' | 'other';
/** Estado de la plantilla en Meta: solo una `approved` se puede enviar. */
export type TemplateStatus = 'approved' | 'pending' | 'rejected' | 'paused' | 'disabled' | 'other';
export type TemplateHeaderFormat = 'text' | 'image' | 'video' | 'document' | 'location' | 'other';
export type TemplateButtonType = 'quick_reply' | 'phone' | 'url' | 'other';

export interface TemplateButton {
  readonly type: TemplateButtonType;
  readonly text: string;
  /** Solo `url`: la dirección; si termina en `{{1}}` lleva una variable. */
  readonly url: string | null;
  /** Solo `phone`. */
  readonly phone: string | null;
}

/**
 * Una plantilla de WhatsApp como la entiende el núcleo (la misma forma para cualquier proveedor). Los textos conservan sus variables tal como las escribió quien la
 * creó: `{{1}}`, `{{2}}`… (`positional`) o `{{nombre}}` (`named`). `examples` guarda el ejemplo que dio en Meta para cada variable (clave = número o nombre).
 */
export interface NormalizedTemplate {
  /** Identificador de la plantilla en el proveedor. */
  readonly externalId: string;
  readonly name: string;
  /** Código de idioma del proveedor (`es`, `es_MX`…). */
  readonly language: string;
  readonly category: TemplateCategory;
  readonly status: TemplateStatus;
  readonly parameterFormat: 'positional' | 'named';
  readonly header: { readonly format: TemplateHeaderFormat; readonly text: string | null; readonly examples: Readonly<Record<string, string>> } | null;
  readonly body: { readonly text: string; readonly examples: Readonly<Record<string, string>> } | null;
  readonly footer: string | null;
  readonly buttons: readonly TemplateButton[];
  /** Componentes que no entendemos (carrusel, oferta por tiempo limitado…): la plantilla se lista, pero no se envía desde aquí. */
  readonly unsupported: readonly string[];
  /** Por qué Meta la rechazó, si la rechazó. */
  readonly rejectedReason: string | null;
}

/** Un valor para una variable de la plantilla. `name` solo si la plantilla usa variables con nombre. */
export interface TemplateParameter {
  readonly name: string | null;
  readonly text: string;
}

/** Los valores de una parte de la plantilla: encabezado, cuerpo o el botón de URL con variable (`index` = posición del botón). */
export interface TemplateSendComponent {
  readonly type: 'header' | 'body' | 'button';
  readonly subType: 'url' | null;
  readonly index: number | null;
  readonly parameters: readonly TemplateParameter[];
}

export interface SendTemplateInput {
  /** Teléfono de destino en dígitos (sin «+»). */
  readonly to: string;
  readonly name: string;
  readonly language: string;
  /** Solo las partes que llevan variables; una plantilla sin variables va sin componentes. */
  readonly components: readonly TemplateSendComponent[];
}

// ── Archivos adjuntos (M5.6d) ───────────────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Un archivo a enviar: el adaptador lo sube al proveedor y manda el mensaje que lo referencia. `caption` no aplica al audio ni a los stickers. */
export interface SendMediaInput {
  /** Teléfono de destino en dígitos (sin «+»). */
  readonly to: string;
  readonly kind: MediaKind;
  readonly bytes: Buffer;
  readonly mimeType: string;
  /** Solo documentos: el nombre con el que lo ve el cliente. */
  readonly filename: string | null;
  readonly caption: string | null;
}

/** Un archivo que el cliente mandó, ya descargado del proveedor. */
export interface DownloadedMedia {
  readonly bytes: Buffer;
  readonly mimeType: string | null;
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
  /** Todas las plantillas de la cuenta de WhatsApp Business (`wabaId`), de cualquier estado. Lanza `WhatsAppProviderError` si no se pudo. */
  listTemplates(credentials: WhatsAppCredentials, wabaId: string): Promise<readonly NormalizedTemplate[]>;
  /** Envía una plantilla aprobada desde el número (dentro o fuera de las 24 h). Lanza `WhatsAppProviderError` (mensaje seguro) si no se pudo. */
  sendTemplate(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTemplateInput): Promise<SentMessage>;
  /** Sube un archivo al proveedor y lo envía en un mensaje desde el número. Lanza `WhatsAppProviderError` (mensaje seguro: sin token, teléfono ni contenido) si no se pudo. */
  sendMedia(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendMediaInput): Promise<SentMessage>;
  /** Descarga un archivo que el cliente mandó. `maxBytes` acota lo que se acepta leer. Lanza `WhatsAppProviderError` (`media_unavailable` si ya no existe o supera el tope). */
  downloadMedia(credentials: WhatsAppCredentials, mediaId: string, maxBytes: number): Promise<DownloadedMedia>;
  /** ¿El aviso entrante lo firmó de verdad el proveedor? `rawBody` es el cuerpo EXACTO recibido; `appSecret`, el secreto de la aplicación de la plataforma. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean;
  /** Lee un aviso entrante (ya verificado) y lo traduce a eventos normalizados, uno por número. Nunca lanza por un contenido mal formado. */
  parseWebhook(body: unknown, now?: Date): ParsedWebhook;
  /** Vuelve a leer la parte `raw` de un aviso guardado. */
  parseStored(raw: Record<string, unknown>, now?: Date): ParsedWebhook;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
