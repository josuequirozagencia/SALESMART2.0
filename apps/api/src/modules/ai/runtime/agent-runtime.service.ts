import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { agents, aiConversationState, conversations, Database, messages, type TenantTx } from '../../../db';
import { ConflictError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import { APP_LOGGER } from '../../../tokens';
import { writeAudit } from '../../audit';
import { loadConversation, scopeOf, type InboxAccess } from '../../inbox';
import { OrgDirectoryService, type OrgDirectory } from '../../organizations';
import { AssignmentService, type AssignmentContext } from '../../queues';
import { RealtimeService } from '../../realtime';
import { isOpenAt, SlaService } from '../../sla';
import { AgentTurnService } from '../agents/agent-turn.service';
import { AgentsService } from '../agents/agents.service';
import { AgentToolsService } from '../tools/agent-tools.service';
import { hasTools } from '../tools/tool-defs';
import { asksForPerson, HANDOFF_MESSAGE, handoffNote, MAX_AGENT_TURNS, MAX_UNSUPPORTED_STREAK, type HandoffReason } from './handoff';

export const AGENT_RUNTIME_BATCH = 5;
/** El agente solo contesta mensajes recientes: uno más antiguo (por ejemplo, tras una caída) ya no se contesta solo, lo ve una persona. */
export const AGENT_FRESH_MS = 60 * 60_000;
/** Una conversación «tomada» por la tarea hace más que esto (el proceso murió) se retoma. */
export const AGENT_LEASE_MS = 3 * 60_000;
export const AGENT_MAX_ATTEMPTS = 5;
const HISTORY_MESSAGES = 14;
const MAX_BACKOFF_MS = 10 * 60_000;
const WAIT_FOR_AI_MS = 60_000;

type PauseReason = 'human_message' | 'human_took' | 'manual' | 'no_credits';

interface Claimed {
  conversationId: string;
  contactId: string;
  channelAccountId: string;
  queueId: string | null;
  agentId: string;
  turns: number;
  unsupportedStreak: number;
  attempts: number;
  handledUntil: Date | null;
}

export interface AgentStatusView {
  agent: { id: string; name: string } | null;
  /** `idle`: el agente no ha intervenido (una persona la lleva); `active` contesta; `paused` lo detuvo una persona o faltan créditos; `handed_off` pasó a una persona. */
  state: 'idle' | 'active' | 'paused' | 'handed_off';
  reason: string | null;
  can_control: boolean;
}

/** A dónde va una conversación cuando el agente la pasa a una persona: la cola de transferencia del agente (si tiene) y el contexto de reparto (la zona horaria y quién puede recibir trabajo se leen ANTES de la transacción). */
interface Route {
  queueId: string | null;
  ctx: AssignmentContext;
}

export type AgentOutcome = 'replied' | 'handed_off' | 'paused' | 'skipped' | 'retry';

/**
 * El agente de IA en vivo (M8.5, ADR-53; F17): atiende los mensajes entrantes de las conexiones donde un agente está activo. Una tarea cada 5 s recorre las conversaciones con algo sin contestar
 * (sin tocar la ingesta de mensajes: nada se acopla a ella) y, para cada una, ejecuta UN turno con el motor común (`AgentTurnService`, el del simulador). Reglas:
 *  - Solo atiende mensajes **recientes** (menos de 1 h) y de **texto**; una conversación cuyo cliente ya fue atendido por una persona, o que una persona tomó, **no se contesta sola** (un mensaje humano
 *    la PAUSA y solo una persona la reanuda).
 *  - **Pasa a una persona** —con un aviso al cliente cuando fue él quien lo pidió, y siempre con una nota interna— si el cliente lo pide (reglas fijas, no del modelo), llega al máximo de respuestas
 *    seguidas, se queda dos veces seguidas sin respaldo en los documentos, envía algo que no es texto o la IA falla 5 veces. Sin créditos se PAUSA.
 *  - Sin clave de IA en la plataforma espera sin gastar intentos. Con «a toda hora» apagado, solo contesta con la cola abierta.
 * Las respuestas salen como mensajes `ai` en cola (los envía el despachador de siempre) y NO cuentan como respuesta humana. Todo cambio de estado deja una nota interna y queda auditado.
 */
@Injectable()
export class AgentRuntimeService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentTurnService) private readonly turns: AgentTurnService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentToolsService) private readonly tools: AgentToolsService,
    @Inject(AssignmentService) private readonly assignment: AssignmentService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Procesa lo pendiente de la empresa del contexto. Devuelve cuántas conversaciones tocó. */
  async runDue(now: Date, batch = AGENT_RUNTIME_BATCH): Promise<number> {
    await this.pauseForHumans(now);
    const dir = await this.directory.current(); // identidad: ANTES de la transacción de negocio
    let touched = 0;
    for (let i = 0; i < batch; i++) {
      const job = await this.claim(now);
      if (!job) break;
      touched += 1;
      await this.handle(job, now, dir);
    }
    return touched;
  }

  // ------------------------------------------------------------------ pausar cuando una persona interviene

  /** Pausa a los agentes de las conversaciones donde una persona escribió o la tomó. Solo una persona puede reanudarlos. */
  async pauseForHumans(now: Date): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const res = await tx.execute(sql`
        SELECT s.conversation_id AS id, s.agent_id,
               EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.direction = 'out' AND h.sender_type = 'human' AND h.status <> 'internal' AND h.sent_at > COALESCE(s.resumed_at, '-infinity'::timestamptz)) AS human_message
          FROM ai_conversation_state s
          JOIN conversations c ON c.id = s.conversation_id AND c.organization_id = s.organization_id
         WHERE s.status = 'active' AND c.status <> 'closed'
           AND ((s.resumed_at IS NULL AND c.status NOT IN ('unassigned', 'pending'))
                OR EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.direction = 'out' AND h.sender_type = 'human' AND h.status <> 'internal' AND h.sent_at > COALESCE(s.resumed_at, '-infinity'::timestamptz)))
         LIMIT 50
         FOR UPDATE OF s SKIP LOCKED`);
      const rows = res.rows as Array<{ id: string; agent_id: string; human_message: boolean }>;
      for (const r of rows) await this.setState(tx, r.id, r.agent_id, { status: 'paused', reason: r.human_message ? 'human_message' : 'human_took' }, now, 'automation');
      return rows.length;
    });
  }

  // ------------------------------------------------------------------ tomar y atender

  private claim(now: Date): Promise<Claimed | null> {
    return this.db.withTenant(async (tx) => {
      const fresh = new Date(now.getTime() - AGENT_FRESH_MS);
      const lease = new Date(now.getTime() - AGENT_LEASE_MS);
      const res = await tx.execute(sql`
        SELECT c.id AS conversation_id, c.contact_id, c.channel_account_id, c.queue_id, a.id AS agent_id,
               COALESCE(s.turns, 0) AS turns, COALESCE(s.unsupported_streak, 0) AS streak, COALESCE(s.attempts, 0) AS attempts, s.handled_until
          FROM conversations c
          JOIN agent_channels ac ON ac.channel_id = c.channel_account_id AND ac.organization_id = c.organization_id
          JOIN agents a ON a.id = ac.agent_id AND a.organization_id = ac.organization_id AND a.active AND a.deleted_at IS NULL
          JOIN channel_accounts ch ON ch.id = c.channel_account_id AND ch.organization_id = c.organization_id AND ch.status = 'active' AND ch.deleted_at IS NULL
          LEFT JOIN ai_conversation_state s ON s.conversation_id = c.id AND s.organization_id = c.organization_id
         WHERE c.status <> 'closed'
           AND (s.conversation_id IS NULL OR (s.status = 'active' AND s.next_attempt_at <= ${now} AND (s.processing_started_at IS NULL OR s.processing_started_at < ${lease})))
           AND ((s.resumed_at IS NULL AND c.status IN ('unassigned', 'pending')) OR s.resumed_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.direction = 'out' AND h.sender_type = 'human' AND h.status <> 'internal' AND h.sent_at > COALESCE(s.resumed_at, '-infinity'::timestamptz))
           AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.sent_at > GREATEST(COALESCE(s.handled_until, '-infinity'::timestamptz), ac.created_at, ${fresh}))
         ORDER BY c.last_inbound_at NULLS LAST
         LIMIT 1
         FOR UPDATE OF c SKIP LOCKED`);
      const r = (res.rows as Array<{ conversation_id: string; contact_id: string; channel_account_id: string; queue_id: string | null; agent_id: string; turns: number; streak: number; attempts: number; handled_until: Date | string | null }>)[0];
      if (!r) return null;
      await tx
        .insert(aiConversationState)
        .values({ conversationId: r.conversation_id, agentId: r.agent_id, processingStartedAt: now, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [aiConversationState.organizationId, aiConversationState.conversationId], set: { agentId: r.agent_id, processingStartedAt: now, updatedAt: now } });
      return { conversationId: r.conversation_id, contactId: r.contact_id, channelAccountId: r.channel_account_id, queueId: r.queue_id, agentId: r.agent_id, turns: Number(r.turns), unsupportedStreak: Number(r.streak), attempts: Number(r.attempts), handledUntil: r.handled_until ? new Date(r.handled_until) : null };
    });
  }

  private async handle(job: Claimed, now: Date, dir: OrgDirectory): Promise<AgentOutcome> {
    try {
      const settings = await this.agents.runtimeSettings(job.agentId);
      const route: Route = { queueId: settings.transferQueueId, ctx: { now, timeZone: dir.timeZone, assignable: dir.assignable } };
      // 1) Lo que hay que contestar: los mensajes del cliente posteriores a lo ya atendido, y la conversación reciente como historial
      const recent = await this.db.withTenant((tx) =>
        tx
          .select({ direction: messages.direction, sender: messages.senderType, kind: messages.kind, body: messages.body, status: messages.status, at: messages.sentAt })
          .from(messages)
          .where(and(eq(messages.conversationId, job.conversationId), sql`${messages.status} <> 'internal'`, sql`${messages.kind} <> 'note'`))
          .orderBy(sql`${messages.sentAt} DESC`, sql`${messages.id} DESC`)
          .limit(HISTORY_MESSAGES),
      );
      const ordered = [...recent].reverse();
      const since = job.handledUntil;
      const pending = ordered.filter((m) => m.direction === 'in' && (since === null || m.at > since));
      const newest = pending.reduce<Date | null>((d, m) => (d === null || m.at > d ? m.at : d), null) ?? now;
      const text = pending.filter((m) => m.kind === 'text' && m.body).map((m) => m.body!).join('\n');
      if (text.trim() === '') return await this.handoff(job, settings.name, 'unsupported_media', newest, false, now, route);
      if (job.turns >= MAX_AGENT_TURNS) return await this.handoff(job, settings.name, 'turn_limit', newest, false, now, route);
      if (settings.transferEnabled && asksForPerson(text)) return await this.handoff(job, settings.name, 'requested', newest, true, now, route);
      // 2) Fuera de horario con «a toda hora» apagado: no contesta (la cola avisa); no se vuelve a intentar con este mensaje
      if (!settings.alwaysOn && job.queueId) {
        const open = await this.db.withTenant(async (tx) => isOpenAt((await this.sla.calendars(tx, dir.timeZone)).forQueue(job.queueId), now));
        if (!open) return await this.finish(job, newest, { replied: 0, grounded: true }, now, null, '', route);
      }
      // 3) El turno
      const history = ordered
        .filter((m) => m.kind === 'text' && m.body && !pending.includes(m) && (m.direction === 'in' || m.status !== 'failed'))
        .map((m) => ({ role: m.direction === 'in' ? ('user' as const) : ('assistant' as const), text: m.body!.slice(0, 1500) }));
      // Herramientas del agente (M8.5b): se ejecutan en el servidor con lo que el agente tiene permitido
      const config = await this.tools.configFor(job.agentId);
      const tools = hasTools(config) ? { config, execute: (call: Parameters<AgentToolsService['execute']>[2]) => this.tools.execute(config, { agentId: job.agentId, agentName: settings.name, conversationId: job.conversationId, contactId: job.contactId, dryRun: false, now }, call) } : undefined;
      const turn = await this.turns.run({ agentId: job.agentId, message: text.slice(0, 1000), history, contactId: job.contactId, kind: 'use', ...(tools ? { tools } : {}) });
      const notes = turn.toolCalls.flatMap((c) => (c.summary ? [`El agente ${settings.name} ${c.summary}.`] : []));
      const extra = { notes, transfer: turn.transfer };
      if (turn.replies.length === 0 && !turn.transfer && notes.length === 0) return await this.finish(job, newest, { replied: 0, grounded: turn.grounded }, now, null, settings.name, route);
      return await this.finish(job, newest, { replied: turn.replies.length, grounded: turn.grounded }, now, turn.replies, settings.name, route, extra);
    } catch (e) {
      return this.failed(job, e, now);
    }
  }

  /** Guarda las respuestas y deja el estado de la conversación al día. Si una persona escribió mientras el agente pensaba, NO envía nada y pausa. */
  private async finish(job: Claimed, newest: Date, r: { replied: number; grounded: boolean }, now: Date, replies: string[] | null, agentName: string, route: Route, extra: { notes: string[]; transfer: boolean } = { notes: [], transfer: false }): Promise<AgentOutcome> {
    return this.db.withTenant(async (tx) => {
      const [c] = await tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, job.conversationId)).for('update').limit(1);
      if (!c || c.status === 'closed') {
        await tx.update(aiConversationState).set({ processingStartedAt: null, handledUntil: newest, updatedAt: now }).where(eq(aiConversationState.conversationId, job.conversationId));
        return 'skipped' as const;
      }
      if (replies && (await this.humanWroteSince(tx, job.conversationId, now))) {
        await this.setState(tx, job.conversationId, job.agentId, { status: 'paused', reason: 'human_message' }, now, 'automation', agentName || undefined);
        return 'paused' as const;
      }
      // Si el agente decidió pasar la conversación a una persona y no dijo nada, se le avisa al cliente con el texto fijo
      const toSend = replies && extra.transfer && replies.length === 0 ? [HANDOFF_MESSAGE] : replies;
      if (toSend && toSend.length > 0) await this.sendReplies(tx, job, toSend, newest, now);
      for (const n of extra.notes) await this.systemNote(tx, job, n, now);
      const streak = replies === null ? job.unsupportedStreak : r.grounded ? 0 : job.unsupportedStreak + 1;
      await tx
        .update(aiConversationState)
        .set({ handledUntil: newest, turns: replies ? job.turns + 1 : job.turns, unsupportedStreak: streak, attempts: 0, processingStartedAt: null, nextAttemptAt: now, updatedAt: now })
        .where(eq(aiConversationState.conversationId, job.conversationId));
      if (replies && extra.transfer) {
        await this.setState(tx, job.conversationId, job.agentId, { status: 'handed_off', reason: 'agent_decision' }, now, 'ai', agentName);
        await this.routeToQueue(tx, job, route, now);
        return 'handed_off' as const;
      }
      if (replies && streak >= MAX_UNSUPPORTED_STREAK) {
        await this.setState(tx, job.conversationId, job.agentId, { status: 'handed_off', reason: 'no_support' }, now, 'ai', agentName);
        await this.routeToQueue(tx, job, route, now);
        return 'handed_off' as const;
      }
      return replies ? ('replied' as const) : ('skipped' as const);
    });
  }

  /** Pasa la conversación a una persona: aviso al cliente (si fue él quien lo pidió), nota interna y estado. */
  private async handoff(job: Claimed, agentName: string, reason: HandoffReason, newest: Date, tellClient: boolean, now: Date, route: Route): Promise<AgentOutcome> {
    return this.db.withTenant(async (tx) => {
      if (tellClient && !(await this.humanWroteSince(tx, job.conversationId, now))) await this.sendReplies(tx, job, [HANDOFF_MESSAGE], newest, now);
      await tx.update(aiConversationState).set({ handledUntil: newest, processingStartedAt: null, updatedAt: now }).where(eq(aiConversationState.conversationId, job.conversationId));
      await this.setState(tx, job.conversationId, job.agentId, { status: 'handed_off', reason }, now, 'ai', agentName);
      await this.routeToQueue(tx, job, route, now);
      return 'handed_off' as const;
    });
  }

  /**
   * Al pasar a una persona, si la conversación sigue SIN asignar y el agente tiene una cola de transferencia, se pone en esa cola y se reparte con su regla (la misma de siempre: cartera primero,
   * rotación, tope diario, SLA). Si ya tiene responsable, no se toca: una persona ya la tiene.
   */
  private async routeToQueue(tx: TenantTx, job: Claimed, route: Route, now: Date): Promise<void> {
    if (route.queueId === null) return;
    const [c] = await tx.select({ status: conversations.status, queueId: conversations.queueId }).from(conversations).where(eq(conversations.id, job.conversationId)).for('update').limit(1);
    if (!c || c.status !== 'unassigned') return;
    if (c.queueId !== route.queueId) await tx.update(conversations).set({ queueId: route.queueId, updatedAt: now }).where(eq(conversations.id, job.conversationId));
    await this.assignment.assignConversation(tx, job.conversationId, route.ctx);
  }

  /** Lo que pasa cuando algo falla: sin créditos pausa; sin clave de IA espera; un fallo pasajero reintenta con espera creciente y, tras 5 intentos, pasa a una persona. */
  private async failed(job: Claimed, e: unknown, now: Date): Promise<AgentOutcome> {
    const code = (e as { code?: string } | null)?.code;
    const name = await this.agents.runtimeSettings(job.agentId).then((s) => s.name).catch(() => 'de IA');
    if (code === 'AI_NO_CREDITS') {
      return this.db.withTenant(async (tx) => {
        await this.setState(tx, job.conversationId, job.agentId, { status: 'paused', reason: 'no_credits' }, now, 'ai', name);
        return 'paused' as const;
      });
    }
    if (code === 'AI_NOT_CONFIGURED') {
      await this.db.withTenant((tx) => tx.update(aiConversationState).set({ processingStartedAt: null, nextAttemptAt: new Date(now.getTime() + WAIT_FOR_AI_MS), updatedAt: now }).where(eq(aiConversationState.conversationId, job.conversationId)));
      return 'retry';
    }
    const attempts = job.attempts + 1;
    if (code !== 'AI_BUSY' && code !== 'AI_UNAVAILABLE') this.log.error({ err: e, conversation_id: job.conversationId }, 'fallo inesperado del agente de IA'); // sin el contenido de la conversación
    if (attempts >= AGENT_MAX_ATTEMPTS) {
      const queueId = await this.agents.runtimeSettings(job.agentId).then((s) => s.transferQueueId).catch(() => null);
      const dir = await this.directory.current(); // identidad: antes de la transacción
      return this.db.withTenant(async (tx) => {
        await this.setState(tx, job.conversationId, job.agentId, { status: 'handed_off', reason: 'ai_error' }, now, 'ai', name);
        await this.routeToQueue(tx, job, { queueId, ctx: { now, timeZone: dir.timeZone, assignable: dir.assignable } }, now);
        return 'handed_off' as const;
      });
    }
    await this.db.withTenant((tx) => tx.update(aiConversationState).set({ attempts, processingStartedAt: null, nextAttemptAt: new Date(now.getTime() + Math.min(2 ** attempts * 15_000, MAX_BACKOFF_MS)), updatedAt: now }).where(eq(aiConversationState.conversationId, job.conversationId)));
    return 'retry';
  }

  // ------------------------------------------------------------------ control por una persona (pausar y reanudar)

  /** Qué hace el agente en esta conversación, para la bandeja. 404 si la persona no puede ver la conversación. */
  async status(access: InboxAccess, conversationId: string): Promise<AgentStatusView> {
    const scope = scopeOf(access);
    return this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, conversationId);
      const agentId = await this.channelAgent(tx, conversationId);
      const [state] = await tx.select({ status: aiConversationState.status, reason: aiConversationState.reason }).from(aiConversationState).where(eq(aiConversationState.conversationId, conversationId)).limit(1);
      const agent = agentId ? ((await tx.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1))[0] ?? null) : null;
      if (!agent) return { agent: null, state: 'idle', reason: null, can_control: false };
      const open = c.status !== 'closed';
      const effective = (state ? state.status : c.status === 'unassigned' || c.status === 'pending' ? 'active' : 'idle') as AgentStatusView['state'];
      return { agent, state: effective, reason: state?.reason ?? null, can_control: access.canReply && open };
    });
  }

  /** Una persona toma el control: el agente deja de contestar en esta conversación. */
  async pauseByPerson(access: InboxAccess, conversationId: string): Promise<AgentStatusView> {
    const scope = scopeOf(access);
    await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, conversationId, true);
      if (c.status === 'closed') throw new ConflictError('CONVERSATION_CLOSED', 'La conversación está finalizada');
      await this.pause(tx, conversationId);
    });
    return this.status(access, conversationId);
  }

  /** Una persona reanuda al agente: desde ahora contesta lo que escriba el cliente. */
  async resumeByPerson(access: InboxAccess, conversationId: string): Promise<AgentStatusView> {
    const scope = scopeOf(access);
    await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, conversationId, true);
      if (c.status === 'closed') throw new ConflictError('CONVERSATION_CLOSED', 'La conversación está finalizada');
      await this.resume(tx, conversationId);
    });
    return this.status(access, conversationId);
  }

  /** Pausa a mano al agente en esta conversación (la crea si el agente aún no había intervenido). */
  async pause(tx: TenantTx, conversationId: string): Promise<void> {
    const agentId = await this.channelAgent(tx, conversationId);
    if (!agentId) throw new ConflictError('NO_AGENT', 'Esta conexión no tiene un agente de IA');
    await this.ensureState(tx, conversationId, agentId);
    await this.setState(tx, conversationId, agentId, { status: 'paused', reason: 'manual' }, new Date(), 'manual');
  }

  /** Reanuda al agente: desde ahora contesta lo que escriba el cliente (lo anterior no se contesta). Solo lo hace una persona. */
  async resume(tx: TenantTx, conversationId: string): Promise<void> {
    const agentId = await this.channelAgent(tx, conversationId);
    if (!agentId) throw new ConflictError('NO_AGENT', 'Esta conexión no tiene un agente de IA activo');
    const now = new Date();
    await this.ensureState(tx, conversationId, agentId);
    const [last] = await tx.select({ at: sql<Date | null>`max(${messages.sentAt})` }).from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in')));
    await tx.update(aiConversationState).set({ resumedAt: now, handledUntil: last?.at ? new Date(last.at) : now, turns: 0, unsupportedStreak: 0, attempts: 0, nextAttemptAt: now, processingStartedAt: null }).where(eq(aiConversationState.conversationId, conversationId));
    await this.setState(tx, conversationId, agentId, { status: 'active', reason: null }, now, 'manual');
  }

  /** El agente activo de la conexión de la conversación (null si no hay o está apagado). */
  async channelAgent(tx: TenantTx, conversationId: string): Promise<string | null> {
    const res = await tx.execute(sql`SELECT a.id FROM conversations c JOIN agent_channels ac ON ac.channel_id = c.channel_account_id AND ac.organization_id = c.organization_id JOIN agents a ON a.id = ac.agent_id AND a.organization_id = ac.organization_id AND a.active AND a.deleted_at IS NULL WHERE c.id = ${conversationId} LIMIT 1`);
    return (res.rows as Array<{ id: string }>)[0]?.id ?? null;
  }

  // ------------------------------------------------------------------ interno

  private async ensureState(tx: TenantTx, conversationId: string, agentId: string): Promise<void> {
    await tx.insert(aiConversationState).values({ conversationId, agentId, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  }

  private async humanWroteSince(tx: TenantTx, conversationId: string, since: Date): Promise<boolean> {
    const res = await tx.execute(sql`SELECT 1 FROM messages h JOIN ai_conversation_state s ON s.conversation_id = h.conversation_id AND s.organization_id = h.organization_id WHERE h.conversation_id = ${conversationId} AND h.direction = 'out' AND h.sender_type = 'human' AND h.status <> 'internal' AND h.sent_at > COALESCE(s.resumed_at, '-infinity'::timestamptz) AND h.sent_at >= ${new Date(since.getTime() - AGENT_LEASE_MS)} LIMIT 1`);
    return res.rows.length > 0;
  }

  /** Una nota interna del sistema en la conversación (lo que hizo el agente: guardar un dato, crear una tarea). */
  private async systemNote(tx: TenantTx, job: Claimed, body: string, now: Date): Promise<void> {
    await tx.insert(messages).values({ conversationId: job.conversationId, channelAccountId: job.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: body.slice(0, 2000), status: 'internal', sentAt: now });
    this.realtime.touchHere(job.conversationId, {});
  }

  /** Cambia el estado del agente en la conversación, con su nota interna, su auditoría y el aviso en vivo. */
  private async setState(tx: TenantTx, conversationId: string, agentId: string, to: { status: 'active' | 'paused' | 'handed_off'; reason: HandoffReason | PauseReason | null }, now: Date, source: 'manual' | 'automation' | 'ai', agentName?: string): Promise<void> {
    const [cur] = await tx.select({ status: aiConversationState.status, reason: aiConversationState.reason, version: aiConversationState.version }).from(aiConversationState).where(eq(aiConversationState.conversationId, conversationId)).for('update').limit(1);
    if (!cur || (cur.status === to.status && cur.reason === to.reason)) return;
    await tx.update(aiConversationState).set({ status: to.status, reason: to.reason, version: cur.version + 1, processingStartedAt: null, updatedAt: now }).where(eq(aiConversationState.conversationId, conversationId));
    const [conv] = await tx.select({ channelAccountId: conversations.channelAccountId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const name = agentName ?? (await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1))[0]?.name ?? 'de IA';
    if (conv) {
      const body = to.status === 'active' ? `Una persona reanudó al agente ${name}.` : to.reason ? handoffNote(name, to.reason) : null;
      if (body) await tx.insert(messages).values({ conversationId, channelAccountId: conv.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: body.slice(0, 2000), status: 'internal', sentAt: now });
    }
    await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'ai_agent', oldValue: { status: cur.status, reason: cur.reason }, newValue: { status: to.status, reason: to.reason }, source });
    this.realtime.touchHere(conversationId, {});
  }

  /** Inserta las respuestas del agente como mensajes `ai` en cola, DESPUÉS del último mensaje del cliente, y mueve la última actividad de la conversación. */
  private async sendReplies(tx: TenantTx, job: Claimed, replies: readonly string[], newest: Date, now: Date): Promise<void> {
    const base = Math.max(now.getTime(), newest.getTime() + 1);
    let last = base;
    for (const [i, body] of replies.entries()) {
      last = base + i;
      const [m] = await tx
        .insert(messages)
        .values({ conversationId: job.conversationId, channelAccountId: job.channelAccountId, direction: 'out', senderType: 'ai', kind: 'text', body, status: 'queued', sentAt: new Date(last), attempts: 0, nextAttemptAt: now, meta: { agent_id: job.agentId } })
        .returning({ id: messages.id });
      this.realtime.touchHere(job.conversationId, { message: { id: m!.id, kind: 'created' } });
    }
    await tx.update(conversations).set({ lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${new Date(last)}::timestamptz), ${new Date(last)}::timestamptz)`, updatedAt: now }).where(eq(conversations.id, job.conversationId));
  }
}

