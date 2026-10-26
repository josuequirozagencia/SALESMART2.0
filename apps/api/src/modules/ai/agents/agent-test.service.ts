import { Inject, Injectable } from '@nestjs/common';
import { gt, sql } from 'drizzle-orm';
import { agentTestRuns, Database } from '../../../db';
import { AppError, ConflictError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { AiPricingService } from '../../platform';
import { AiCreditsService } from '../ai-credits.service';
import { AiGateway, AiUnavailableError } from '../ai-gateway.service';
import { creditsFor } from '../credits';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { buildChatMessages, estimateInputTokens, splitReply, trimReply } from './agent-chat';
import { AgentsService } from './agents.service';
import type { TestTurnDto } from './agents.dto';

/** Mensajes de prueba por empresa en 24 horas (ADR-53, decisión 11: evita abuso y gasto sin control). */
export const MAX_TESTS_PER_DAY = 100;
/** Fragmentos de la biblioteca que se le entregan al modelo en cada turno. */
export const FRAGMENTS_PER_TURN = 4;

export interface TurnView {
  /** Lo que respondería el agente: uno o varios mensajes (según «dividir respuestas»). */
  replies: string[];
  /** «Qué hizo el agente» para este turno. */
  trace: {
    search: { query: string; grounded: boolean; results: Array<{ document: string; score: number }> };
    missing_variables: string[];
    model: { name: string; tokens_in: number; tokens_out: number };
    split: boolean;
    trimmed: boolean;
  };
  /** Créditos que costó el turno (búsqueda y respuesta). */
  credits_used: number;
  /** Mensajes de prueba que le quedan hoy a la empresa. */
  remaining_today: number;
  contact: { id: string; name: string } | null;
}

/**
 * Simulador de prueba de un agente (M8.4, ADR-20/53): un turno de conversación con el modelo y las instrucciones GUARDADAS del agente, para ver cómo respondería antes de activarlo. **No envía mensajes ni
 * crea contactos ni conversaciones**: el contacto de «probar como» solo se lee para llenar las variables. Cada turno busca en los documentos del agente (si no hay respaldo se lo dice al modelo, y se
 * muestra), reserva créditos de «prueba» —el peor caso— y cobra lo realmente usado. La conversación la lleva la pantalla (se manda el historial reciente); el servidor solo guarda metadatos del turno
 * para el tope diario, nunca el texto. El texto de la respuesta se recorta al largo máximo del agente y se divide en bloques si así lo pide.
 */
@Injectable()
export class AgentTestService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
  ) {}

  async turn(agentId: string, input: TestTurnDto): Promise<TurnView> {
    const settings = await this.agents.runtimeSettings(agentId); // 404 antes de gastar nada
    const used = await this.usedToday();
    if (used >= MAX_TESTS_PER_DAY) throw new ConflictError('AGENT_TEST_LIMIT', `Llegaste al máximo de ${MAX_TESTS_PER_DAY} mensajes de prueba en 24 horas: inténtalo más tarde`);
    const userId = TenantContext.current().userId ?? null;
    const message = input.message.trim();
    // 1) Las instrucciones guardadas con las variables llenas (contacto real o ejemplo)
    const prompt = await this.agents.preview({ agent_id: agentId, ...(input.contact_id ? { contact_id: input.contact_id } : {}) });
    // 2) El respaldo: fragmentos de LOS DOCUMENTOS DEL AGENTE parecidos a la pregunta
    const found = await this.knowledge.search({ query: message, limit: FRAGMENTS_PER_TURN, agentId, kind: 'test' });
    const fragments = found.hits.map((h) => ({ document: h.document.name, content: h.content }));
    const messages = buildChatMessages({ system: prompt.system, fragments, history: input.history ?? [], message });
    // 3) Reservar créditos (el peor caso) y llamar al modelo
    const price = await this.gateway.chatPrice(settings.model);
    if (!price) throw this.unavailable(new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado'));
    const org = TenantContext.current().organizationId;
    const rate = await this.pricing.resolve(org);
    const worstUsd = (estimateInputTokens(messages) * price.usdPer1mInput + settings.maxTokens * price.usdPer1mOutput) / 1_000_000;
    const { holdId } = await this.credits.reserve({ credits: Math.max(1, creditsFor(worstUsd, rate.marginPct, rate.usdPerCredit)), kind: 'test', ref: `Prueba del agente ${settings.name}`.slice(0, 200) });
    let out;
    try {
      out = await this.gateway.chat({ model: settings.model, messages, temperature: settings.temperature, maxTokens: settings.maxTokens });
    } catch (e) {
      await this.credits.release(holdId);
      throw this.unavailable(e);
    }
    const charged = await this.credits.settle(holdId, { costUsd: out.costUsd, ref: `Prueba del agente ${settings.name}`.slice(0, 200) });
    // 4) La respuesta: recortada al largo del agente y dividida si así lo pide
    const trimmed = trimReply(out.text, settings.maxChars);
    const replies = settings.splitEnabled ? splitReply(trimmed, settings.splitBlocks) : trimmed === '' ? [] : [trimmed];
    const creditsUsed = found.credits_used + charged.credits;
    await this.db.withTenant((tx) => tx.insert(agentTestRuns).values({ agentId, userId, grounded: fragments.length > 0, hits: fragments.length, tokensIn: out.tokensIn, tokensOut: out.tokensOut, credits: creditsUsed, createdAt: new Date() }));
    return {
      replies,
      trace: {
        search: { query: message, grounded: fragments.length > 0, results: found.hits.map((h) => ({ document: h.document.name, score: h.score })) },
        missing_variables: prompt.missing,
        model: { name: settings.model, tokens_in: out.tokensIn, tokens_out: out.tokensOut },
        split: replies.length > 1,
        trimmed: trimmed.length < out.text.trim().length,
      },
      credits_used: creditsUsed,
      remaining_today: Math.max(MAX_TESTS_PER_DAY - used - 1, 0),
      contact: prompt.contact,
    };
  }

  private async usedToday(): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentTestRuns).where(gt(agentTestRuns.createdAt, new Date(Date.now() - 24 * 3_600_000)));
      return r?.n ?? 0;
    });
  }

  /** Cómo contarle a la persona que la IA no está disponible. */
  private unavailable(e: unknown): unknown {
    if (!(e instanceof AiUnavailableError)) return e;
    if (e.code === 'not_configured') return new AppError(503, 'AI_NOT_CONFIGURED', 'El servicio de IA aún no está configurado. Avisa al administrador de la plataforma');
    if (e.code === 'busy') return new AppError(503, 'AI_BUSY', 'El servicio de IA está ocupado. Inténtalo en un momento');
    return new AppError(502, 'AI_UNAVAILABLE', 'El servicio de IA no está disponible por ahora');
  }
}
