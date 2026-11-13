/**
 * Puerto de IA (M8, ADR-53). Ningún módulo importa un SDK de proveedor: solo este contrato (adaptadores, CLAUDE.md). La clave es la de la PLATAFORMA (Proveedores › IA de texto) y se entrega al
 * adaptador en cada llamada: el adaptador no guarda ninguna. Hoy solo existe `OpenAiProvider`; Gemini y OpenRouter se enchufarían aquí sin que nadie más se entere.
 */
export interface AiCredentials {
  /** Clave de API del proveedor. Solo vive en memoria del servidor: nunca se devuelve ni se registra. */
  readonly apiKey: string;
}

/** Fallo de una llamada al proveedor de IA. `retryable`: se puede reintentar (red, 5xx, límite de uso). `credentials`: la clave no sirve o no tiene saldo/permiso. El mensaje NO lleva secretos ni contenido. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly credentials = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface EmbedRequest {
  /** Modelo de embeddings. */
  readonly model: string;
  /** Textos a vectorizar (el proveedor admite varios por llamada). */
  readonly inputs: readonly string[];
  /** Dimensiones del vector (los modelos de OpenAI permiten acortarlo). */
  readonly dimensions: number;
}

export interface EmbedResult {
  /** Un vector por texto, en el mismo orden. */
  readonly vectors: number[][];
  /** Tokens que el proveedor cobró por la llamada. */
  readonly tokens: number;
}

/** Una herramienta que el modelo puede pedir (llamada a funciones). `parameters` es un esquema JSON. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Una herramienta que el modelo pidió usar. `arguments` es el texto JSON tal como lo dio el modelo: NO es de fiar hasta validarlo. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Una parte de un mensaje del cliente: texto o una imagen (ADR-70). Los bytes viajan en memoria del servidor al proveedor; nunca se firma ni se publica una dirección. */
export type ContentPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly mimeType: string; readonly bytes: Uint8Array };

/** Tipos de imagen que el puerto acepta (decididos por el contenido real antes de llegar aquí). */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | ReadonlyArray<ContentPart> }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };

/** El texto de un mensaje (las imágenes no cuentan como texto). */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** ¿El mensaje lleva alguna imagen? */
export function imageCount(m: ChatMessage): number {
  return typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image').length;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  /** Herramientas que el modelo puede pedir; sin ellas, solo responde texto. */
  readonly tools?: readonly ToolDefinition[];
}

export interface ChatResult {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Herramientas que el modelo pidió (vacío o ausente: ninguna). */
  readonly toolCalls?: readonly ToolCall[];
}

/** Un audio del cliente para transcribir (ADR-70): los bytes viajan en memoria; `filename` solo da al proveedor la extensión que reconoce el formato. */
export interface TranscribeRequest {
  readonly model: string;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  /** Idioma esperado (ISO 639-1); sin él, el proveedor lo detecta. */
  readonly language?: string;
}

export interface TranscribeResult {
  readonly text: string;
  /** Duración real del audio según el proveedor, en segundos. */
  readonly seconds: number;
  readonly language: string | null;
}

/** Formatos de audio que el puerto acepta (decididos por el contenido real antes de llegar aquí): nota de voz de WhatsApp (OGG/Opus), MP3, MP4/M4A y WebM. */
export const AUDIO_MIME_TYPES = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/webm'] as const;

export interface AIProvider {
  /** `none` = sin adaptador configurado. */
  readonly kind: 'none' | 'fake' | 'openai';
  /** ¿Necesita la clave de la plataforma para hablar con el proveedor? (`openai` sí; el fake de pruebas no.) */
  readonly requiresCredentials: boolean;
  /** Vectoriza textos. Lanza `AiProviderError`. */
  embed(credentials: AiCredentials, request: EmbedRequest): Promise<EmbedResult>;
  /** Genera una respuesta de chat. Lanza `AiProviderError`. */
  chat(credentials: AiCredentials, request: ChatRequest): Promise<ChatResult>;
  /** Transcribe un audio. Lanza `AiProviderError`. */
  transcribe(credentials: AiCredentials, request: TranscribeRequest): Promise<TranscribeResult>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Sin adaptador configurado. */
export class NoAiProvider implements AIProvider {
  readonly kind = 'none' as const;
  readonly requiresCredentials = false;
  embed(): Promise<EmbedResult> {
    return Promise.reject(new AiProviderError('No hay adaptador de IA configurado', false));
  }
  chat(): Promise<ChatResult> {
    return Promise.reject(new AiProviderError('No hay adaptador de IA configurado', false));
  }
  transcribe(): Promise<TranscribeResult> {
    return Promise.reject(new AiProviderError('No hay adaptador de IA configurado', false));
  }
}
