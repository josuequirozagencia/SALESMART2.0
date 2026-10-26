import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { AiPricingService } from '../../platform';
import { AiCreditsService } from '../ai-credits.service';
import { AiGateway, AiUnavailableError, type ChatOutcome } from '../ai-gateway.service';
import type { ChatMessage, ToolCall } from '../ai.ports';
import type { ToolResult } from '../tools/agent-tools.service';
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, toolDefinitions, toolGuidance, type ToolConfig } from '../tools/tool-defs';
import { creditsFor } from '../credits';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { buildChatMessages, estimateInputTokens, splitReply, trimReply } from './agent-chat';
import { AgentsService } from './agents.service';

/** Fragmentos de la biblioteca que se le entregan al modelo en cada turno. */
export const FRAGMENTS_PER_TURN = 4;

export interface TurnRequest {
  readonly agentId: string;
  /** Lo que escribió el cliente (o la persona que prueba). */
  readonly message: string;
  /** Turnos anteriores de la conversación, del más antiguo al más reciente. */
  readonly history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  /** El contacto con cuyos datos se llenan las variables; sin él, un ejemplo. */
  readonly contactId: string | null;
  /** `test` (simulador) o `use` (conversación real): así se anota en el libro de créditos. */
  readonly kind: 'use' | 'test';
  /** Herramientas del agente (M8.5b): qué se le ofrece al modelo y cómo se ejecuta cada llamada que pida. Sin esto, el modelo solo responde texto. */
  readonly tools?: { readonly config: ToolConfig; readonly execute: (call: ToolCall) => Promise<ToolResult> };
}

export interface TurnResult {
  /** Uno o varios mensajes (según «dividir respuestas»). */
  readonly replies: string[];
  readonly grounded: boolean;
  readonly hits: number;
  readonly search: { query: string; results: Array<{ document: string; score: number }> };
  readonly missingVariables: string[];
  readonly model: { name: string; tokensIn: number; tokensOut: number };
  readonly trimmed: boolean;
  /** Créditos que costó el turno (búsqueda y respuesta). */
  readonly creditsUsed: number;
  readonly contact: { id: string; name: string } | null;
  /** Lo que el modelo pidió con herramientas y cómo terminó cada una (vacío si no usó ninguna). */
  readonly toolCalls: ToolResult[];
  /** Una herramienta pidió pasar la conversación a una persona. */
  readonly transfer: boolean;
}

/**
 * Un turno del agente (M8.4/M8.5, ADR-53): el MISMO motor lo usan el simulador de prueba y el agente en vivo, así que lo que se prueba es lo que contesta. Arma las instrucciones guardadas con las variables
 * llenas, busca en los documentos DEL AGENTE, le da al modelo las reglas fijas y —solo si hay respaldo— los fragmentos (sin respaldo se le ordena no dar datos del negocio), reserva créditos (el peor
 * caso), llama al modelo y cobra lo realmente usado (un fallo libera la reserva sin cobrar la respuesta). Recorta la respuesta al largo del agente y la divide si así lo pide. No escribe nada de la conversación:
 * quien lo llama decide qué hacer con las respuestas.
 */
@Injectable()
export class AgentTurnService {
  constructor(
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
  ) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    const settings = await this.agents.runtimeSettings(req.agentId); // 404 antes de gastar nada
    const message = req.message.trim();
    const prompt = await this.agents.preview({ agent_id: req.agentId, ...(req.contactId ? { contact_id: req.contactId } : {}) });
    const found = await this.knowledge.search({ query: message, limit: FRAGMENTS_PER_TURN, agentId: req.agentId, kind: req.kind });
    const fragments = found.hits.map((h) => ({ document: h.document.name, content: h.content }));
    const defs = req.tools ? toolDefinitions(req.tools.config) : [];
    const guidance = req.tools ? toolGuidance(req.tools.config) : '';
    const messages: ChatMessage[] = buildChatMessages({ system: guidance ? `${prompt.system}

${guidance}` : prompt.system, fragments, history: req.history, message });
    const price = await this.gateway.chatPrice(settings.model);
    if (!price) throw this.unavailable(new AiUnavailableError('failed', 'El precio del modelo de IA no está cargado'));
    const rate = await this.pricing.resolve(TenantContext.current().organizationId);
    const ref = `${req.kind === 'test' ? 'Prueba del agente' : 'Agente'} ${settings.name}`.slice(0, 200);
    const defsChars = JSON.stringify(defs).length;
    // Una vuelta de chat: reserva (el peor caso), llamada y cobro de lo realmente usado; un fallo libera la reserva
    const round = async (withTools: boolean): Promise<{ out: ChatOutcome; credits: number }> => {
      const worstUsd = ((estimateInputTokens(messages) + Math.ceil(withTools ? defsChars / 3 : 0)) * price.usdPer1mInput + settings.maxTokens * price.usdPer1mOutput) / 1_000_000;
      const { holdId } = await this.credits.reserve({ credits: Math.max(1, creditsFor(worstUsd, rate.marginPct, rate.usdPerCredit)), kind: req.kind, ref });
      let out: ChatOutcome;
      try {
        out = await this.gateway.chat({ model: settings.model, messages, temperature: settings.temperature, maxTokens: settings.maxTokens, ...(withTools && defs.length > 0 ? { tools: defs } : {}) });
      } catch (e) {
        await this.credits.release(holdId);
        throw this.unavailable(e);
      }
      const charged = await this.credits.settle(holdId, { costUsd: out.costUsd, ref });
      return { out, credits: charged.credits };
    };

    let tokensIn = 0;
    let tokensOut = 0;
    let credits = found.credits_used;
    let text = '';
    const toolResults: ToolResult[] = [];
    let transfer = false;
    for (let i = 0; ; i++) {
      const withTools = req.tools !== undefined && defs.length > 0 && i < MAX_TOOL_ROUNDS;
      const { out, credits: c } = await round(withTools);
      tokensIn += out.tokensIn;
      tokensOut += out.tokensOut;
      credits += c;
      if (out.text.trim() !== '') text = out.text;
      const calls = out.toolCalls.slice(0, MAX_CALLS_PER_ROUND);
      if (!withTools || calls.length === 0 || !req.tools) break;
      // El modelo pidió herramientas: se ejecutan EN EL SERVIDOR con lo que el agente tiene permitido y su resultado vuelve al modelo
      messages.push({ role: 'assistant', content: out.text, toolCalls: calls });
      for (const call of calls) {
        const r = await req.tools.execute(call);
        toolResults.push(r);
        if (r.transfer) transfer = true;
        messages.push({ role: 'tool', toolCallId: call.id, content: `${r.outcome}: ${r.detail}` });
      }
    }
    const trimmed = trimReply(text, settings.maxChars);
    const replies = settings.splitEnabled ? splitReply(trimmed, settings.splitBlocks) : trimmed === '' ? [] : [trimmed];
    return {
      replies,
      grounded: fragments.length > 0,
      hits: fragments.length,
      search: { query: message, results: found.hits.map((h) => ({ document: h.document.name, score: h.score })) },
      missingVariables: prompt.missing,
      model: { name: settings.model, tokensIn, tokensOut },
      trimmed: trimmed.length < text.trim().length,
      creditsUsed: credits,
      contact: prompt.contact,
      toolCalls: toolResults,
      transfer,
    };
  }

  /** Cómo contarle a la persona que la IA no está disponible. */
  private unavailable(e: unknown): unknown {
    if (!(e instanceof AiUnavailableError)) return e;
    if (e.code === 'not_configured') return new AppError(503, 'AI_NOT_CONFIGURED', 'El servicio de IA aún no está configurado. Avisa al administrador de la plataforma');
    if (e.code === 'busy') return new AppError(503, 'AI_BUSY', 'El servicio de IA está ocupado. Inténtalo en un momento');
    return new AppError(502, 'AI_UNAVAILABLE', 'El servicio de IA no está disponible por ahora');
  }
}
