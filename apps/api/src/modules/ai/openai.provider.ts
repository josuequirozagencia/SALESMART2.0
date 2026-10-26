import { AiProviderError, type AiCredentials, type AIProvider, type ChatRequest, type ChatResult, type EmbedRequest, type EmbedResult } from './ai.ports';

const DEFAULT_BASE = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 60_000;
/** Textos por llamada de embeddings (el proveedor admite hasta 2048; se acota para que una llamada no sea enorme). */
export const MAX_EMBED_INPUTS = 100;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Texto del proveedor apto para mostrarse: sin saltos de línea, acotado y sin nada parecido a una clave (`sk-…`) ni a un correo. El contenido enviado por el cliente no se repite. */
const safeText = (v: unknown): string =>
  String(typeof v === 'string' ? v : '')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[clave]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, '[correo]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

interface ErrorBody { error?: { message?: unknown; code?: unknown; type?: unknown } }

/**
 * Adaptador de OpenAI (M8, ADR-53): `POST /v1/embeddings` y `POST /v1/chat/completions`. La clave va en la cabecera `Authorization` (nunca en la dirección), sin redirecciones y con tiempo máximo. 401 y 403,
 * y el 429 por «sin cuota» (`insufficient_quota`), son fallos de la CLAVE y definitivos; otro 429, 5xx y la red caída se reintentan; un 400 es definitivo (por ejemplo, un texto demasiado largo). El mensaje de
 * todo error es seguro: jamás lleva la clave ni lo que se envió. Probado contra un servidor SIMULADO, NO contra OpenAI real.
 */
export class OpenAiProvider implements AIProvider {
  readonly kind = 'openai' as const;
  readonly requiresCredentials = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embed(credentials: AiCredentials, request: EmbedRequest): Promise<EmbedResult> {
    if (!MODEL.test(request.model)) throw new AiProviderError('El modelo de embeddings no es válido', false);
    if (request.inputs.length === 0 || request.inputs.length > MAX_EMBED_INPUTS) throw new AiProviderError(`Se pueden vectorizar de 1 a ${MAX_EMBED_INPUTS} textos por llamada`, false);
    if (request.inputs.some((s) => s.trim().length === 0)) throw new AiProviderError('Hay un texto vacío que no se puede vectorizar', false);
    if (!Number.isInteger(request.dimensions) || request.dimensions < 8 || request.dimensions > 3072) throw new AiProviderError('Las dimensiones del vector no son válidas', false);
    const res = await this.call('/v1/embeddings', credentials, { model: request.model, input: request.inputs, dimensions: request.dimensions, encoding_format: 'float' });
    try {
      const body = (await res.json()) as { data?: Array<{ index?: unknown; embedding?: unknown }>; usage?: { total_tokens?: unknown; prompt_tokens?: unknown } };
      const data = Array.isArray(body.data) ? [...body.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
      if (data.length !== request.inputs.length) throw new AiProviderError('El proveedor de IA respondió algo que no se entiende', true);
      const vectors = data.map((d) => {
        const e = d.embedding;
        if (!Array.isArray(e) || e.length !== request.dimensions || e.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new AiProviderError('El proveedor de IA respondió un vector que no se entiende', true);
        return e as number[];
      });
      const tokens = Number(body.usage?.total_tokens ?? body.usage?.prompt_tokens);
      if (!Number.isFinite(tokens) || tokens < 0) throw new AiProviderError('El proveedor de IA no informó el consumo', true);
      return { vectors, tokens: Math.floor(tokens) };
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      throw new AiProviderError('El proveedor de IA respondió algo que no se entiende', true);
    }
  }

  async chat(credentials: AiCredentials, request: ChatRequest): Promise<ChatResult> {
    if (!MODEL.test(request.model)) throw new AiProviderError('El modelo de chat no es válido', false);
    if (request.messages.length === 0) throw new AiProviderError('No hay mensajes que enviar', false);
    const res = await this.call('/v1/chat/completions', credentials, {
      model: request.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: Math.min(Math.max(request.temperature, 0), 2),
      max_completion_tokens: Math.min(Math.max(Math.floor(request.maxTokens), 1), 16_000),
    });
    try {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      const text = body.choices?.[0]?.message?.content;
      const tokensIn = Number(body.usage?.prompt_tokens);
      const tokensOut = Number(body.usage?.completion_tokens);
      if (typeof text !== 'string' || !Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) throw new AiProviderError('El proveedor de IA respondió algo que no se entiende', true);
      return { text, tokensIn: Math.floor(tokensIn), tokensOut: Math.floor(tokensOut) };
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      throw new AiProviderError('El proveedor de IA respondió algo que no se entiende', true);
    }
  }

  private async call(path: string, credentials: AiCredentials, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Red caída, tiempo agotado o redirección: pasajero. El error original podría traer la dirección o el cuerpo: no se propaga.
      throw new AiProviderError('No se pudo contactar al proveedor de IA', true);
    }
    if (res.ok) return res;
    let detail: ErrorBody['error'] | undefined;
    try {
      detail = ((await res.json()) as ErrorBody).error;
    } catch {
      detail = undefined;
    }
    const text = safeText(detail?.message);
    const tail = text ? `: ${text}` : '';
    if (res.status === 401 || res.status === 403) throw new AiProviderError(`El proveedor de IA rechazó la clave de la plataforma${tail}`, false, true);
    if (res.status === 429 && (detail?.code === 'insufficient_quota' || detail?.type === 'insufficient_quota')) throw new AiProviderError('La cuenta del proveedor de IA no tiene saldo o cuota', false, true);
    if (res.status === 429 || res.status >= 500) throw new AiProviderError(`El proveedor de IA no pudo atender la llamada ahora${tail}`, true);
    throw new AiProviderError(`El proveedor de IA rechazó la solicitud${tail}`, false);
  }
}
