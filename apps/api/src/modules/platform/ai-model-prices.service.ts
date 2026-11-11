import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { aiModelPrices, Database } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { PlatformContext, TenantContext } from '../../tenant';
import { PlatformAuditService } from './platform-audit.service';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const CACHE_MS = 30_000;

/** Precio de un modelo (dólares por millón de tokens). SOLO servidor. */
export interface ModelPrice {
  readonly model: string;
  readonly kind: 'embedding' | 'chat';
  readonly usdPer1mInput: number;
  readonly usdPer1mOutput: number;
}

export interface ModelPriceView {
  model: string;
  kind: 'embedding' | 'chat';
  usd_per_1m_input: string;
  usd_per_1m_output: string;
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

  private async load(now: number): Promise<Map<string, ModelPrice>> {
    if (!this.cache || now - this.cache.at >= CACHE_MS) {
      const read = () => this.db.withPlatform((tx) => tx.select().from(aiModelPrices));
      const rows = PlatformContext.currentOrNull() ? await read() : await TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
      this.cache = { at: now, value: new Map(rows.map((r) => [r.model, { model: r.model, kind: r.kind as ModelPrice['kind'], usdPer1mInput: Number(r.usdPer1mInput), usdPer1mOutput: Number(r.usdPer1mOutput) }])) };
    }
    return this.cache.value;
  }

  async list(): Promise<ModelPriceView[]> {
    const rows = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).orderBy(aiModelPrices.kind, aiModelPrices.model));
    return rows.map((r) => ({ model: r.model, kind: r.kind as ModelPrice['kind'], usd_per_1m_input: r.usdPer1mInput, usd_per_1m_output: r.usdPer1mOutput, updated_at: r.updatedAt.toISOString() }));
  }

  /**
   * Da de alta un modelo de CHAT nuevo (v11 S4: cada agente puede elegir entre los que el Súper Admin cargó). Los de embeddings no se agregan aquí: cambiarlos obliga a revectorizar las bibliotecas.
   * 409 si ya existe. El precio es el que el Súper Admin teclea (sale de la página de precios del proveedor); sin precio no se puede usar el modelo.
   */
  async create(model: string, input: { usd_per_1m_input: string; usd_per_1m_output: string }): Promise<ModelPriceView> {
    const actor = PlatformContext.current().actorUserId;
    const [exists] = await this.db.withPlatform((tx) => tx.select({ model: aiModelPrices.model }).from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    if (exists) throw new ConflictError('MODEL_EXISTS', 'Ese modelo ya está cargado: cambia su precio en la lista');
    await this.db.withPlatform((tx) => tx.insert(aiModelPrices).values({ model, kind: 'chat', usdPer1mInput: input.usd_per_1m_input, usdPer1mOutput: input.usd_per_1m_output, updatedBy: actor }));
    this.cache = null;
    await this.audit.record({ action: 'ai.model_price.create', entityType: 'ai_model', details: { model, kind: 'chat', input: input.usd_per_1m_input, output: input.usd_per_1m_output } });
    const [row] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    return { model, kind: 'chat', usd_per_1m_input: row!.usdPer1mInput, usd_per_1m_output: row!.usdPer1mOutput, updated_at: row!.updatedAt.toISOString() };
  }

  /** Cambia el precio de un modelo que YA existe. */
  async set(model: string, input: { usd_per_1m_input: string; usd_per_1m_output: string }): Promise<ModelPriceView> {
    const actor = PlatformContext.current().actorUserId;
    const [before] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    if (!before) throw new NotFoundError();
    await this.db.withPlatform((tx) => tx.update(aiModelPrices).set({ usdPer1mInput: input.usd_per_1m_input, usdPer1mOutput: input.usd_per_1m_output, updatedAt: new Date(), updatedBy: actor }).where(eq(aiModelPrices.model, model)));
    this.cache = null;
    await this.audit.record({ action: 'ai.model_price.update', entityType: 'ai_model', details: { model, before: { input: before.usdPer1mInput, output: before.usdPer1mOutput }, after: { input: input.usd_per_1m_input, output: input.usd_per_1m_output } } });
    const [row] = await this.db.withPlatform((tx) => tx.select().from(aiModelPrices).where(eq(aiModelPrices.model, model)).limit(1));
    return { model, kind: row!.kind as ModelPrice['kind'], usd_per_1m_input: row!.usdPer1mInput, usd_per_1m_output: row!.usdPer1mOutput, updated_at: row!.updatedAt.toISOString() };
  }

  invalidate(): void {
    this.cache = null;
  }
}
