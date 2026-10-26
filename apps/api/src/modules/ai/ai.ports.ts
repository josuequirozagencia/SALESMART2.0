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

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };

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

export interface AIProvider {
  /** `none` = sin adaptador configurado. */
  readonly kind: 'none' | 'fake' | 'openai';
  /** ¿Necesita la clave de la plataforma para hablar con el proveedor? (`openai` sí; el fake de pruebas no.) */
  readonly requiresCredentials: boolean;
  /** Vectoriza textos. Lanza `AiProviderError`. */
  embed(credentials: AiCredentials, request: EmbedRequest): Promise<EmbedResult>;
  /** Genera una respuesta de chat. Lanza `AiProviderError`. */
  chat(credentials: AiCredentials, request: ChatRequest): Promise<ChatResult>;
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
}
