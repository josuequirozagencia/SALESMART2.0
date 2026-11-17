import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt } from 'drizzle-orm';
import { aiLedger, Database } from '../../db';
import { AppError, ConflictError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AiCreditsService, AiGateway, AiUnavailableError, creditsFor, estimateInputTokens, type ChatMessage } from '../ai';
import { AiModelPricesService, AiPricingService } from '../platform';
import { CampaignsService } from './campaigns.service';
import { acceptVariants, MAX_VARIANT_RUNS_PER_DAY, parseVariants, variantsSystemPrompt, variantsUserPrompt } from './variants';

const DAY_MS = 86_400_000;
/** Lo que se le pide al modelo: algo creativo pero que no se aparte del original. */
const TEMPERATURE = 0.9;
/** Tokens de salida que se reservan por cada versión pedida (1 000 caracteres son ~300 tokens). */
const TOKENS_PER_VARIANT = 350;
const MAX_OUTPUT_TOKENS = 4000;

export interface VariantsView {
  /** Versiones aceptadas, listas para revisarlas: NO se guardan en ningún lado hasta que la persona guarda la campaña. */
  variants: string[];
  requested: number;
  /** Cuántas de las que escribió el modelo se descartaron por no cumplir las reglas (otras variables, números o enlaces nuevos, repetidas). */
  rejected: number;
  credits_used: number;
  /** Cuántas veces más puede pedir versiones hoy esta empresa. */
  remaining_today: number;
}

/**
 * Generación de versiones del mensaje con IA (v17, ADR-72 · enmienda «variantes con IA»): solo para campañas por WhatsApp QR (texto libre). Usa la clave de IA de la PLATAFORMA y los créditos de la
 * empresa con el mismo cobro «reservar y liquidar» del resto de la IA (tipo `variants`); un fallo libera la reserva. **No escribe nada**: las versiones vuelven al navegador, la persona las revisa,
 * las edita o las borra, y solo se guardan con la campaña. Cada versión que escribe el modelo se VALIDA en el servidor (mismas variables, sin números ni enlaces nuevos, distinta del original): la
 * IA no puede inventar un precio o un teléfono que luego se mande a miles de personas. Tope por empresa: {@link MAX_VARIANT_RUNS_PER_DAY} pedidos al día (provisional).
 */
@Injectable()
export class CampaignVariantsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CampaignsService) private readonly campaigns: CampaignsService,
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
    @Inject(AiModelPricesService) private readonly models: AiModelPricesService,
  ) {}

  async generate(input: { text: string; count: number }): Promise<VariantsView> {
    await this.campaigns.assertPlan();
    const text = input.text.trim();
    const used = await this.runsToday();
    if (used >= MAX_VARIANT_RUNS_PER_DAY) throw new ConflictError('VARIANTS_DAILY_LIMIT', `Hoy ya pediste versiones ${MAX_VARIANT_RUNS_PER_DAY} veces. Puedes escribir las tuyas o volver mañana`);
    const model = (await this.models.chatModels())[0];
    const price = model ? await this.gateway.chatPrice(model) : null;
    if (!model || !price) throw new AppError(503, 'AI_NOT_CONFIGURED', 'La generación con IA aún no está configurada. Avisa al administrador de la plataforma');
    const messages: ChatMessage[] = [{ role: 'system', content: variantsSystemPrompt(input.count) }, { role: 'user', content: variantsUserPrompt(text) }];
    const maxTokens = Math.min(MAX_OUTPUT_TOKENS, TOKENS_PER_VARIANT * input.count);
    const rate = await this.pricing.resolve(TenantContext.current().organizationId);
    const worstUsd = (estimateInputTokens(messages) * price.usdPer1mInput + maxTokens * price.usdPer1mOutput) / 1_000_000;
    const ref = 'Variaciones de campaña';
    const { holdId } = await this.credits.reserve({ credits: Math.max(1, creditsFor(worstUsd, rate.marginPct, rate.usdPerCredit)), kind: 'variants', ref });
    let out;
    try {
      out = await this.gateway.chat({ model, messages, temperature: TEMPERATURE, maxTokens });
    } catch (e) {
      await this.credits.release(holdId);
      throw this.unavailable(e);
    }
    const charged = await this.credits.settle(holdId, { costUsd: out.costUsd, ref });
    const { accepted, rejected } = acceptVariants(text, parseVariants(out.text), input.count);
    if (accepted.length === 0) throw new ConflictError('VARIANTS_NONE_VALID', 'La IA no logró escribir versiones que respeten tu mensaje. Inténtalo de nuevo o escribe las tuyas');
    return { variants: accepted, requested: input.count, rejected, credits_used: charged.credits, remaining_today: Math.max(0, MAX_VARIANT_RUNS_PER_DAY - used - 1) };
  }

  /** Cuántas veces se pidieron versiones en las últimas 24 h (cada pedido cobrado deja un movimiento `variants` en el libro). */
  private async runsToday(): Promise<number> {
    const since = new Date(Date.now() - DAY_MS);
    const [row] = await this.db.withTenant((tx) => tx.select({ n: count() }).from(aiLedger).where(and(eq(aiLedger.kind, 'variants'), gt(aiLedger.createdAt, since))));
    return Number(row?.n ?? 0);
  }

  private unavailable(e: unknown): unknown {
    if (!(e instanceof AiUnavailableError)) return e;
    if (e.code === 'not_configured') return new AppError(503, 'AI_NOT_CONFIGURED', 'La generación con IA aún no está configurada. Avisa al administrador de la plataforma');
    if (e.code === 'busy') return new AppError(503, 'AI_BUSY', 'El servicio de IA está ocupado. Inténtalo en un momento');
    return new AppError(502, 'AI_UNAVAILABLE', 'El servicio de IA no está disponible por ahora');
  }
}
