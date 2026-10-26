import { Inject, Injectable } from '@nestjs/common';
import { gt, sql } from 'drizzle-orm';
import { agentTestRuns, Database } from '../../../db';
import { ConflictError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { AgentTurnService, FRAGMENTS_PER_TURN } from './agent-turn.service';
import { AgentsService } from './agents.service';
import type { TestTurnDto } from './agents.dto';

export { FRAGMENTS_PER_TURN };
/** Mensajes de prueba por empresa en 24 horas (ADR-53, decisión 11: evita abuso y gasto sin control). */
export const MAX_TESTS_PER_DAY = 100;

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
 * crea contactos ni conversaciones**: el contacto de «probar como» solo se lee para llenar las variables. El turno lo ejecuta el motor común (`AgentTurnService`, el mismo del agente en vivo); aquí se agrega
 * el tope diario y el registro de metadatos (nunca el texto). La conversación la lleva la pantalla (se manda el historial reciente).
 */
@Injectable()
export class AgentTestService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentTurnService) private readonly turns: AgentTurnService,
  ) {}

  async turn(agentId: string, input: TestTurnDto): Promise<TurnView> {
    await this.agents.runtimeSettings(agentId); // 404 antes de gastar nada
    const used = await this.usedToday();
    if (used >= MAX_TESTS_PER_DAY) throw new ConflictError('AGENT_TEST_LIMIT', `Llegaste al máximo de ${MAX_TESTS_PER_DAY} mensajes de prueba en 24 horas: inténtalo más tarde`);
    const userId = TenantContext.current().userId ?? null;
    const r = await this.turns.run({ agentId, message: input.message, history: input.history ?? [], contactId: input.contact_id ?? null, kind: 'test' });
    await this.db.withTenant((tx) => tx.insert(agentTestRuns).values({ agentId, userId, grounded: r.grounded, hits: r.hits, tokensIn: r.model.tokensIn, tokensOut: r.model.tokensOut, credits: r.creditsUsed, createdAt: new Date() }));
    return {
      replies: r.replies,
      trace: { search: { query: r.search.query, grounded: r.grounded, results: r.search.results }, missing_variables: r.missingVariables, model: { name: r.model.name, tokens_in: r.model.tokensIn, tokens_out: r.model.tokensOut }, split: r.replies.length > 1, trimmed: r.trimmed },
      credits_used: r.creditsUsed,
      remaining_today: Math.max(MAX_TESTS_PER_DAY - used - 1, 0),
      contact: r.contact,
    };
  }

  private async usedToday(): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentTestRuns).where(gt(agentTestRuns.createdAt, new Date(Date.now() - 24 * 3_600_000)));
      return r?.n ?? 0;
    });
  }
}
