import { Inject, Injectable } from '@nestjs/common';
import { AI_PROVIDER, AiProviderError, type AIProvider, type ChatMessage } from './ai.ports';
import { MAX_EMBED_INPUTS } from './openai.provider';
import { AiModelPricesService, PlatformCredentialsReader } from '../platform';

/** Modelo de embeddings y tamaño del vector (ADR-53: 512 dimensiones mantienen barata la búsqueda por fuerza bruta). */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 512;

/** Por qué no se pudo llamar a la IA, en términos que el servicio que la usa puede traducir: `not_configured` (falta la clave de la plataforma), `rejected` (la clave no sirve o no tiene saldo), `busy` (pasajero), `failed` (definitivo). */
export type AiUnavailableCode = 'not_configured' | 'rejected' | 'busy' | 'failed';

export class AiUnavailableError extends Error {
  constructor(
    readonly code: AiUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
  get retryable(): boolean {
    return this.code === 'busy';
  }
}

export interface EmbeddingOutcome {
  readonly vectors: number[][];
  /** Tokens que cobró el proveedor. */
  readonly tokens: number;
  /** Costo real en USD según el precio del modelo (SOLO servidor). */
  readonly costUsd: number;
}

export interface ChatOutcome {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Costo real en USD según el precio del modelo (SOLO servidor). */
  readonly costUsd: number;
}

/**
 * Puerta de la IA para el resto del servidor (M8.2, ADR-53): resuelve la clave de la PLATAFORMA (Proveedores › IA de texto, proveedor en uso `openai`), llama al adaptador y calcula el costo real con el precio
 * del modelo. Se llama FUERA de toda transacción de negocio. Si la plataforma no tiene la clave, lanza `not_configured` (nadie gasta créditos). Nunca devuelve ni registra la clave ni el texto enviado.
 */
@Injectable()
export class AiGateway {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
    @Inject(PlatformCredentialsReader) private readonly credentials: PlatformCredentialsReader,
    @Inject(AiModelPricesService) private readonly prices: AiModelPricesService,
  ) {}

  /** ¿Hay con qué llamar a la IA? (adaptador y clave). */
  async available(): Promise<boolean> {
    try {
      await this.key();
      return this.provider.kind !== 'none';
    } catch {
      return false;
    }
  }

  /** Costo en USD de vectorizar `tokens` tokens, o null si el modelo no tiene precio cargado. */
  async embeddingCostUsd(tokens: number): Promise<number | null> {
    const p = await this.prices.price(EMBEDDING_MODEL);
    return p ? (tokens * p.usdPer1mInput) / 1_000_000 : null;
  }

  /** Vectoriza textos (en tandas de `MAX_EMBED_INPUTS`) y suma el consumo. */
  async embed(texts: readonly string[]): Promise<EmbeddingOutcome> {
    if (texts.length === 0) return { vectors: [], tokens: 0, costUsd: 0 };
    const apiKey = await this.key();
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += MAX_EMBED_INPUTS) {
      try {
        const out = await this.provider.embed({ apiKey }, { model: EMBEDDING_MODEL, inputs: texts.slice(i, i + MAX_EMBED_INPUTS), dimensions: EMBEDDING_DIMENSIONS });
        vectors.push(...out.vectors);
        tokens += out.tokens;
      } catch (e) {
        throw this.translate(e);
      }
    }
    const cost = await this.embeddingCostUsd(tokens);
    if (cost === null) throw new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado');
    return { vectors, tokens, costUsd: cost };
  }

  /** Precios (USD por millón de tokens) de un modelo de chat; null si no está cargado. SOLO servidor. */
  chatPrice(model: string): Promise<{ usdPer1mInput: number; usdPer1mOutput: number } | null> {
    return this.prices.price(model).then((p) => (p && p.kind === 'chat' ? { usdPer1mInput: p.usdPer1mInput, usdPer1mOutput: p.usdPer1mOutput } : null));
  }

  /** Genera una respuesta de chat y calcula su costo real. Se llama FUERA de toda transacción de negocio. */
  async chat(input: { model: string; messages: readonly ChatMessage[]; temperature: number; maxTokens: number }): Promise<ChatOutcome> {
    const price = await this.chatPrice(input.model);
    if (!price) throw new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado');
    const apiKey = await this.key();
    try {
      const out = await this.provider.chat({ apiKey }, { model: input.model, messages: input.messages, temperature: input.temperature, maxTokens: input.maxTokens });
      return { ...out, costUsd: (out.tokensIn * price.usdPer1mInput + out.tokensOut * price.usdPer1mOutput) / 1_000_000 };
    } catch (e) {
      throw this.translate(e);
    }
  }

  private async key(): Promise<string> {
    if (this.provider.kind === 'none') throw new AiUnavailableError('not_configured', 'El servicio de IA no está configurado');
    if (!this.provider.requiresCredentials) return '';
    const c = await this.credentials.active('text_ai');
    const apiKey = c?.provider === 'openai' ? c.values['api_key'] : undefined;
    if (!apiKey) throw new AiUnavailableError('not_configured', 'El servicio de IA aún no está configurado');
    return apiKey;
  }

  private translate(e: unknown): AiUnavailableError {
    if (e instanceof AiUnavailableError) return e;
    if (e instanceof AiProviderError) return new AiUnavailableError(e.credentials ? 'rejected' : e.retryable ? 'busy' : 'failed', e.message);
    throw e;
  }
}
