import { Inject, Injectable } from '@nestjs/common';
import { and, desc, gt, isNotNull, sql } from 'drizzle-orm';
import { aiSuggestionRuns, Database, messages } from '../../../db';
import { AppError, ConflictError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { AiLimitsService } from '../../platform';
import { assertCanReply, assertWindowOpen, loadConversation, scopeOf, type InboxAccess } from '../../inbox';
import { AgentTurnService } from '../agents/agent-turn.service';
import { AgentsService } from '../agents/agents.service';
import { AgentRuntimeService } from './agent-runtime.service';

/** Cuántos mensajes recientes de la conversación se le dan al modelo como contexto. */
const HISTORY_MESSAGES = 14;

export interface SuggestionView {
  /** El borrador. NO se guarda en ninguna parte del servidor: la persona lo edita y lo envía (o lo descarta). */
  text: string;
  agent: { id: string; name: string };
  credits_used: number;
  /** Sugerencias que le quedan hoy a la empresa. */
  remaining_today: number;
}

/**
 * Sugerencia de respuesta para la persona que atiende (v11 S4, ADR-61): el MISMO motor de turnos del agente (instrucciones, reglas fijas de «no inventar», base de conocimiento y créditos «reservar y liquidar»)
 * pero **sin herramientas**, **sin enviar nada** y **sin tocar al agente** (no lo pausa, no lo reanuda, no cambia de dueño la conversación). Solo la pide quien puede responder esa conversación; lo que no puede
 * ver responde 404 igual que lo inexistente. El contexto son los mensajes visibles de la conversación (**las notas internas no entran**: podrían filtrarse en un borrador que se envía al cliente). No se
 * guarda el texto, solo metadatos (`ai_suggestion_runs`: quién, qué conversación, créditos y tokens).
 */
@Injectable()
export class ReplySuggestionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(AgentTurnService) private readonly turns: AgentTurnService,
    @Inject(AiLimitsService) private readonly limits: AiLimitsService,
  ) {}

  async suggest(access: InboxAccess, conversationId: string): Promise<SuggestionView> {
    const scope = scopeOf(access);
    const now = new Date();
    const ctx = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, conversationId); // 404 uniforme
      assertCanReply(scope, c, channel.state, collab, channel.provider);
      assertWindowOpen(c.lastInboundAt, now, channel.provider); // con WhatsApp oficial, fuera de las 24 h solo valen plantillas
      const agentId = await this.runtime.channelAgent(tx, conversationId);
      if (!agentId) throw new ConflictError('NO_AGENT', 'Esta conversación no tiene un agente de IA en su conexión');
      const recent = await tx
        .select({ direction: messages.direction, kind: messages.kind, body: messages.body, status: messages.status })
        .from(messages)
        .where(and(sql`${messages.conversationId} = ${conversationId}`, sql`${messages.status} <> 'internal'`, sql`${messages.kind} <> 'note'`, isNotNull(messages.body)))
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(HISTORY_MESSAGES);
      return { contactId: c.contactId, agentId, recent: [...recent].reverse() };
    });
    const settings = await this.agents.runtimeSettings(ctx.agentId);
    if (!settings.suggestionsEnabled) throw new ConflictError('SUGGESTIONS_DISABLED', 'Las sugerencias de respuesta no están activadas en el agente de esta conversación');
    const max = (await this.limits.resolve()).suggestionsPerDay; // el tope lo fija el Súper Admin
    const used = await this.usedToday();
    if (used >= max) throw new ConflictError('SUGGESTION_LIMIT', `Tu empresa llegó al máximo de ${max} sugerencias en 24 horas: inténtalo más tarde`);

    // Lo que hay que contestar: el último bloque de mensajes del cliente que aún no tiene respuesta; lo anterior es el contexto
    const texts = ctx.recent.filter((m) => m.kind === 'text' && m.body && m.body.trim() !== '');
    let cut = texts.length;
    while (cut > 0 && texts[cut - 1]!.direction === 'in') cut--;
    const pending = texts.slice(cut);
    if (pending.length === 0) throw new ConflictError('NOTHING_TO_ANSWER', 'No hay un mensaje del cliente sin responder: la sugerencia contesta a lo último que escribió');
    const history = texts
      .slice(0, cut)
      .filter((m) => m.direction === 'in' || m.status !== 'failed')
      .map((m) => ({ role: m.direction === 'in' ? ('user' as const) : ('assistant' as const), text: m.body!.slice(0, 1500) }));
    const message = pending.map((m) => m.body!).join('\n').slice(0, 1000);

    const r = await this.turns.run({ agentId: ctx.agentId, message, history, contactId: ctx.contactId, kind: 'suggest' }); // sin `tools`: solo responde texto
    await this.db.withTenant((tx) =>
      tx.insert(aiSuggestionRuns).values({ agentId: ctx.agentId, conversationId, userId: TenantContext.current().userId ?? null, grounded: r.grounded, hits: r.hits, tokensIn: r.model.tokensIn, tokensOut: r.model.tokensOut, credits: r.creditsUsed }),
    );
    const text = r.replies.join('\n\n').trim();
    if (text === '') throw new AppError(502, 'SUGGESTION_EMPTY', 'La IA no pudo preparar una sugerencia esta vez. Inténtalo de nuevo');
    return { text, agent: { id: settings.id, name: settings.name }, credits_used: r.creditsUsed, remaining_today: Math.max(max - used - 1, 0) };
  }

  private async usedToday(): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(aiSuggestionRuns).where(gt(aiSuggestionRuns.createdAt, new Date(Date.now() - 24 * 3_600_000)));
      return r?.n ?? 0;
    });
  }
}
