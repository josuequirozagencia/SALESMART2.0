import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { aiModelPrices, Database } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { PlatformContext, TenantContext } from '../../tenant';
import { PlatformAuditService } from './platform-audit.service';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const CACHE_MS = 30_000;

/** Precio de un modelo (dólares por millón de tokens). SOLO servidor. */
export interface ModelPrice {
  readonly model: string;
  readonly kind: 'embedding' | 'chat' | 'transcription';
  readonly usdPer1mInput: number;
  readonly usdPer1mOutput: number;
  /** ¿Entiende imágenes? (solo modelos de chat; ADR-70). */
  readonly vision: boolean;
  /** Dólares por minuto de audio (solo transcripción). */
  readonly usdPerMinute: number | null;
}

export interface ModelPriceView {
  model: string;
  kind: 'embedding' | 'chat' | 'transcription';
  usd_per_1m_input: string;
  usd_per_1m_output: string;
  vision: boolean;
  usd_per_minute: string | null;
  updated_at: string;
}

/**
 * Precios de los modelos de IA (M8.2, ADR-53): tabla de PLATAFORMA. El servicio de IA los lee para calcular el costo real de cada llamada (con memoria de 30 s); el Súper Admin los cambia. Jamás llegan a una
 * respuesta de cliente.
 */
@Injectable()
export class AiModelPricesService {
  private cache: { at: number; value: Map<string, ModelPrice> } | null = null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  /** El precio de un modelo; null si no está en la tabla (el llamador decide qué hacer). Se puede llamar desde la ruta del cliente: lee como «el sistema». */
  async price(model: string, now = Date.now()): Promise<ModelPrice | null> {
    return (await this.load(now)).get(model) ?? null;
  }

  /** Los NOMBRES de los modelos de chat disponibles (lo que puede elegir un agente). Sin precios: el cliente jamás los ve. */
  async chatModels(now = Date.now()): Promise<string[]> {
    return [...(await this.load(now)).values()].filter((m) => m.kind === 'chat').map((m) => m.model).sort();
  }

  /** El modelo de transcripción en uso (ADR-70): el primero por nombre entre los cargados; null si el Súper Admin aún no cargó ninguno. SOLO servidor. */
  async transcriptionModel(now = Date.now()): Promise<ModelPrice | null> {
    return [...(await this.load(now)).values()].filter((m) => m.kind === 'transcription').sort((a, b) => a.model.localeCompare(b.model))[0] ?? null;
  }

  /** Los NOMBRES de los modelos de chat que entienden imágenes (ADR-70). */
  async visionModels(now = Date.now()): Promise<string[]> {
    return [...(await this.load(now)).values()].filter((m) => m.kind === 'chat' && m.vision).map((m) => m.model).sort();
  }

  private async load(now: number): Promise<Map<string, ModelPrice>> {
    if (!this.cache || now - this.cache.at >= CACHE_MS) {
      const read = () => this.db.withPlatform((tx) => tx.select().from(aiModelPrices));
      const rows = PlatformContext.currentOrNull() ? await read() : await TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
      this.cache = { at: now, value: new Map(rows.map((r) => [r.model, { model: r.model, kind: r.kind as ModelPrice['kind'], usdPer1mInput: Number(r.usdPer1mInput), usdPer1mOutput: Number(r.usdPer1mOutput), vision: r.vision, usdPerMinute: r.usdPerMinute === null ? null : Number(r.usdPerMinute) }])) };
    }
    return this.cache.value;
  }

  async list(): Promise<ModelPriceView[]> {
    const rows = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).orderBy(aiModelPrices.kind, aiModelPrices.model));
    return rows.map((r) => ({ model: r.model, kind: r.kind as ModelPrice['kind'], usd_per_1m_input: r.usdPer1mInput, usd_per_1m_output: r.usdPer1mOutput, vision: r.vision, usd_per_minute: r.usdPerMinute, updated_at: r.updatedAt.toISOString() }));
  }

  /**
   * Da de alta un modelo de CHAT nuevo (v11 S4: cada agente puede elegir entre los que el Súper Admin cargó). Los de embeddings no se agregan aquí: cambiarlos obliga a revectorizar las bibliotecas.
   * 409 si ya existe. El precio es el que el Súper Admin teclea (sale de la página de precios del proveedor); sin precio no se puede usar el modelo.
   */
  async create(model: string, input: { kind?: 'chat' | 'transcription'; usd_per_1m_input?: string | undefined; usd_per_1m_output?: string | undefined; vision?: boolean | undefined; usd_per_minute?: string | undefined }): Promise<ModelPriceView> {
    const kind = input.kind ?? 'chat';
    const actor = PlatformContext.current().actorUserId;
    const [exists] = await this.db.withPlatform((tx) => tx.select({ model: aiModelPrices.model }).from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    if (exists) throw new ConflictError('MODEL_EXISTS', 'Ese modelo ya está cargado: cambia su precio en la lista');
    await this.db.withPlatform((tx) =>
      tx.insert(aiModelPrices).values(
        kind === 'transcription'
          ? { model, kind, usdPer1mInput: '0', usdPer1mOutput: '0', usdPerMinute: input.usd_per_minute!, updatedBy: actor }
          : { model, kind, usdPer1mInput: input.usd_per_1m_input!, usdPer1mOutput: input.usd_per_1m_output!, vision: input.vision ?? false, updatedBy: actor },
      ),
    );
    this.cache = null;
    await this.audit.record({ action: 'ai.model_price.create', entityType: 'ai_model', details: kind === 'transcription' ? { model, kind, per_minute: input.usd_per_minute } : { model, kind, input: input.usd_per_1m_input, output: input.usd_per_1m_output, vision: input.vision ?? false } });
    const [row] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    return { model, kind, usd_per_1m_input: row!.usdPer1mInput, usd_per_1m_output: row!.usdPer1mOutput, vision: row!.vision, usd_per_minute: row!.usdPerMinute, updated_at: row!.updatedAt.toISOString() };
  }

  /** Cambia el precio de un modelo que YA existe. */
  async set(model: string, input: { usd_per_1m_input?: string | undefined; usd_per_1m_output?: string | undefined; usd_per_minute?: string | undefined; vision?: boolean | undefined }): Promise<ModelPriceView> {
    const actor = PlatformContext.current().actorUserId;
    const [before] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    if (!before) throw new NotFoundError();
    // El precio que se cambia depende del tipo: por minuto para la transcripción, por tokens para lo demás
    if (before.kind === 'transcription') {
      if (input.usd_per_minute === undefined || input.usd_per_1m_input !== undefined || input.usd_per_1m_output !== undefined || input.vision !== undefined) throw new ValidationError([{ path: 'usd_per_minute', code: 'required', message: 'Un modelo de transcripción solo lleva su precio por minuto de audio' }]);
      await this.db.withPlatform((tx) => tx.update(aiModelPrices).set({ usdPerMinute: input.usd_per_minute!, updatedAt: new Date(), updatedBy: actor }).where(eq(aiModelPrices.model, model)));
      this.cache = null;
      await this.audit.record({ action: 'ai.model_price.update', entityType: 'ai_model', details: { model, before: { per_minute: before.usdPerMinute }, after: { per_minute: input.usd_per_minute } } });
      const [t] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
      return { model, kind: 'transcription', usd_per_1m_input: t!.usdPer1mInput, usd_per_1m_output: t!.usdPer1mOutput, vision: t!.vision, usd_per_minute: t!.usdPerMinute, updated_at: t!.updatedAt.toISOString() };
    }
    if (input.usd_per_1m_input === undefined || input.usd_per_1m_output === undefined || input.usd_per_minute !== undefined) throw new ValidationError([{ path: 'usd_per_1m_input', code: 'required', message: 'Este modelo lleva los precios de entrada y de salida por millón de tokens' }]);
    const next = { usd_per_1m_input: input.usd_per_1m_input, usd_per_1m_output: input.usd_per_1m_output };
    if (input.vision === true && before.kind !== 'chat') throw new ConflictError('VISION_ONLY_CHAT', 'Solo un modelo de chat puede entender imágenes');
    await this.db.withPlatform((tx) => tx.update(aiModelPrices).set({ usdPer1mInput: next.usd_per_1m_input, usdPer1mOutput: next.usd_per_1m_output, ...(input.vision !== undefined ? { vision: input.vision } : {}), updatedAt: new Date(), updatedBy: actor }).where(eq(aiModelPrices.model, model)));
    this.cache = null;
    await this.audit.record({ action: 'ai.model_price.update', entityType: 'ai_model', details: { model, before: { input: before.usdPer1mInput, output: before.usdPer1mOutput }, after: { input: next.usd_per_1m_input, output: next.usd_per_1m_output }, vision: { before: before.vision, after: input.vision ?? before.vision } } });
    const [row] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    return { model, kind: row!.kind as ModelPrice['kind'], usd_per_1m_input: row!.usdPer1mInput, usd_per_1m_output: row!.usdPer1mOutput, vision: row!.vision, usd_per_minute: row!.usdPerMinute, updated_at: row!.updatedAt.toISOString() };
  }

  invalidate(): void {
    this.cache = null;
  }
}
