import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import {
  agentFollowUpFiles,
  agentFollowUpRuns,
  agentFollowUps,
  agentFollowUpSteps,
  agents,
  aiConversationState,
  automations,
  channelAccounts,
  contacts,
  conversations,
  Database,
  messageAttachments,
  messages,
  type TenantTx,
} from '../../db';
import { AppError } from '../../errors';
import { TenantContext } from '../../tenant';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { AgentReplyBus, AgentRuntimeService, AgentTurnService, type AgentReplyEvent } from '../ai';
import { writeAudit } from '../audit';
import { AttachmentsService } from '../attachments';
import { AutomationEnqueueService } from '../automations';
import { windowOf } from '../inbox';
import { OrgDirectoryService, type OrgDirectory } from '../organizations';
import { AiLimitsService } from '../platform';
import { resolveQuickReply } from '../quick-replies';
import { RealtimeService } from '../realtime';
import { isOpenAt, nextOpenAt, SlaService } from '../sla';
import {
  cancelReason,
  dueAt,
  ENDS_CHAIN,
  FILE_UNASSIGNED_TTL_MS,
  LEASE_MS,
  planParts,
  RETRY_MS,
  RUN_BATCH,
  SCENARIO,
  shouldStartChain,
  type CancelReason,
  type SkipReason,
  type Snapshot,
} from './follow-up-rules';

/** Lo que hace falta de la conversación para decidir y para escribir el mensaje (se lee UNA vez bajo bloqueo). */
interface Loaded {
  run: typeof agentFollowUpRuns.$inferSelect;
  conv: { id: string; status: string; deletedAt: Date | null; ownerId: string | null; queueId: string | null; lastInboundAt: Date | null; channelAccountId: string; contactId: string };
  channel: { provider: string; status: string };
  contactName: string;
  consent: string;
  agentName: string;
  step: typeof agentFollowUpSteps.$inferSelect | null;
  snapshot: Snapshot;
}

type Outcome = 'sent' | 'cancelled' | 'skipped' | 'postponed' | 'retry';

/** La orden que se le da al modelo para escribir un seguimiento (va como instrucción de sistema, nunca como mensaje del cliente). */
const GUIDANCE =
  'El cliente no ha respondido a tu último mensaje. Escribe UN solo mensaje breve, amable y natural para retomar la conversación, sin presionar. No repitas lo que ya dijiste, no te presentes de nuevo y no inventes datos del negocio. Si hay algo concreto pendiente (una pregunta, una cita), recuérdalo con tacto.';

/**
 * El motor de los seguimientos automáticos (v11 S5, ADR-68). `arm` arma la cadena cuando el agente responde y sigue atendiendo (se registra en `AgentReplyBus`); `runDue` (la tarea periódica) resuelve los
 * pasos que ya les toca: antes de CADA envío, bajo el bloqueo de la conversación, comprueba otra vez que siga haciendo falta (el cliente pudo responder un instante antes), respeta el horario de la cola, la
 * ventana de 24 h, los créditos y el tope diario, y deja constancia de cada desenlace con su motivo. El mensaje sale como `ai` (no cuenta como respuesta humana ni detiene el SLA).
 */
@Injectable()
export class FollowUpRunnerService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentReplyBus) private readonly bus: AgentReplyBus,
    @Inject(AgentTurnService) private readonly turns: AgentTurnService,
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(AutomationEnqueueService) private readonly enqueue: AutomationEnqueueService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(AiLimitsService) private readonly limits: AiLimitsService,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((tx, e) => this.arm(tx, e));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  // ------------------------------------------------------------------ armar

  /** El agente respondió y sigue atendiendo: si el escenario está activo y este mensaje del cliente aún no tuvo su cadena, se programa el paso 1. Corre DENTRO de la transacción del agente. */
  async arm(tx: TenantTx, e: AgentReplyEvent): Promise<void> {
    const [fu] = await tx.select({ id: agentFollowUps.id }).from(agentFollowUps).where(and(eq(agentFollowUps.agentId, e.agentId), eq(agentFollowUps.scenario, SCENARIO), eq(agentFollowUps.enabled, true))).limit(1);
    if (!fu) return;
    const [first] = await tx.select({ delay: agentFollowUpSteps.delayMinutes }).from(agentFollowUpSteps).where(and(eq(agentFollowUpSteps.followUpId, fu.id), eq(agentFollowUpSteps.position, 1))).limit(1);
    if (!first) return;
    const [conv] = await tx.select({ lastInboundAt: conversations.lastInboundAt, ownerId: conversations.ownerId, status: conversations.status }).from(conversations).where(eq(conversations.id, e.conversationId)).limit(1);
    if (!conv || conv.status === 'closed') return;
    const chains = await tx.select({ at: agentFollowUpRuns.chainInboundAt }).from(agentFollowUpRuns).where(and(eq(agentFollowUpRuns.conversationId, e.conversationId), eq(agentFollowUpRuns.scenario, SCENARIO)));
    if (!shouldStartChain({ lastInboundAt: conv.lastInboundAt, existingChainInboundAts: chains.map((c) => c.at) })) return;
    const now = new Date();
    // Una cadena anterior que siguiera pendiente ya no aplica (el cliente volvió a escribir)
    await tx.update(agentFollowUpRuns).set({ status: 'cancelled', reason: 'superseded', processedAt: now, processingStartedAt: null, updatedAt: now }).where(and(eq(agentFollowUpRuns.conversationId, e.conversationId), eq(agentFollowUpRuns.scenario, SCENARIO), eq(agentFollowUpRuns.status, 'pending')));
    await tx
      .insert(agentFollowUpRuns)
      .values({ agentId: e.agentId, conversationId: e.conversationId, scenario: SCENARIO, chainInboundAt: conv.lastInboundAt!, anchorAt: e.sentAt, ownerId: conv.ownerId, stepPosition: 1, dueAt: dueAt(e.sentAt, first.delay) })
      .onConflictDoNothing();
  }

  // ------------------------------------------------------------------ limpieza de archivos (v15)

  /**
   * Vence los archivos de seguimiento que ya no hacen falta —subidos hace más de 24 h y sin asignar a un paso, o de un agente borrado— y borra del almacenamiento el objeto de los vencidos (quitados de un paso
   * también). Lo ya enviado a clientes no se toca: cada envío tiene su propia copia. Devuelve cuántos objetos borró.
   */
  async cleanupFiles(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - FILE_UNASSIGNED_TTL_MS);
    await this.db.withTenant(async (tx) => {
      await tx.update(agentFollowUpFiles).set({ state: 'expired', updatedAt: now }).where(and(eq(agentFollowUpFiles.state, 'ready'), isNull(agentFollowUpFiles.stepPosition), lt(agentFollowUpFiles.createdAt, cutoff)));
      await tx
        .update(agentFollowUpFiles)
        .set({ state: 'expired', stepPosition: null, updatedAt: now })
        .where(and(eq(agentFollowUpFiles.state, 'ready'), sql`${agentFollowUpFiles.followUpId} IN (SELECT f.id FROM ${agentFollowUps} f JOIN ${agents} a ON a.id = f.agent_id AND a.organization_id = f.organization_id WHERE a.deleted_at IS NOT NULL)`));
    });
    const gone = await this.db.withTenant((tx) =>
      tx.select({ id: agentFollowUpFiles.id, key: agentFollowUpFiles.storageKey }).from(agentFollowUpFiles).where(and(eq(agentFollowUpFiles.state, 'expired'), sql`${agentFollowUpFiles.storageKey} IS NOT NULL`)).orderBy(asc(agentFollowUpFiles.updatedAt)).limit(50),
    );
    for (const g of gone) {
      await this.files.remove(g.key!);
      await this.db.withTenant((tx) => tx.update(agentFollowUpFiles).set({ storageKey: null, updatedAt: now }).where(eq(agentFollowUpFiles.id, g.id)));
    }
    return gone.length;
  }

  // ------------------------------------------------------------------ la tarea

  /** Una pasada de la tarea para la empresa del contexto: toma los pasos que ya les toca (con arrendamiento) y resuelve cada uno. Devuelve cuántos tocó. */
  async runDue(now: Date): Promise<number> {
    const dir = await this.directory.current(); // identidad: ANTES de la transacción de negocio
    const cutoff = new Date(now.getTime() - LEASE_MS);
    const ids = await this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: agentFollowUpRuns.id })
        .from(agentFollowUpRuns)
        .where(and(eq(agentFollowUpRuns.status, 'pending'), lte(agentFollowUpRuns.dueAt, now), or(isNull(agentFollowUpRuns.processingStartedAt), lt(agentFollowUpRuns.processingStartedAt, cutoff))))
        .orderBy(asc(agentFollowUpRuns.dueAt))
        .limit(RUN_BATCH)
        .for('update', { skipLocked: true });
      if (rows.length > 0) await tx.update(agentFollowUpRuns).set({ processingStartedAt: now }).where(inArray(agentFollowUpRuns.id, rows.map((r) => r.id)));
      return rows.map((r) => r.id);
    });
    let touched = 0;
    for (const id of ids) {
      try {
        if ((await this.processOne(id, now, dir)) !== 'retry') touched += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido', run_id: id }, 'un seguimiento falló y se reintentará');
        await this.db.withTenant((tx) => tx.update(agentFollowUpRuns).set({ processingStartedAt: null, dueAt: new Date(now.getTime() + RETRY_MS), updatedAt: now }).where(and(eq(agentFollowUpRuns.id, id), eq(agentFollowUpRuns.status, 'pending')))).catch(() => undefined);
      }
    }
    return touched;
  }

  /** Resuelve UN paso en tres tiempos: (A) decidir bajo bloqueo, (B) escribir el texto fuera de la transacción (la IA tarda y cobra), (C) volver a comprobar y enviar bajo bloqueo. */
  private async processOne(id: string, now: Date, dir: OrgDirectory): Promise<Outcome> {
    const dailyMax = (await this.limits.resolve()).followUpsPerDay; // el tope lo fija el Súper Admin; se lee ANTES de abrir la transacción de la empresa
    // A) decidir
    const a = await this.db.withTenant(async (tx) => {
      const l = await this.load(tx, id);
      if (!l || l.run.status !== 'pending') return { kind: 'gone' as const };
      const reason = cancelReason({ chainInboundAt: l.run.chainInboundAt, ownerId: l.run.ownerId }, l.snapshot);
      if (reason) return { kind: 'cancel' as const, reason };
      // Horario de la cola: fuera de él se pospone al siguiente tramo abierto (también con el agente «a toda hora»)
      const cal = (await this.sla.calendars(tx, dir.timeZone)).forQueue(l.conv.queueId);
      if (!isOpenAt(cal, now)) {
        const next = nextOpenAt(cal, now);
        return { kind: 'postpone' as const, at: next ?? new Date(now.getTime() + 60 * 60_000) };
      }
      const step = l.step!;
      const sendsMessage = step.mode !== 'none';
      if (sendsMessage) {
        if (l.channel.status !== 'active') return { kind: 'skip' as const, reason: 'channel_unavailable' as SkipReason };
        if (!windowOf(l.conv.lastInboundAt, now, l.channel.provider).open) return { kind: 'skip' as const, reason: 'window_closed' as SkipReason };
        const [sent] = await tx.select({ n: sql<number>`count(*)::int` }).from(agentFollowUpRuns).where(and(eq(agentFollowUpRuns.status, 'sent'), gt(agentFollowUpRuns.processedAt, new Date(now.getTime() - 24 * 3_600_000))));
        if ((sent?.n ?? 0) >= dailyMax) return { kind: 'skip' as const, reason: 'daily_limit' as SkipReason };
      }
      // v15: los archivos del paso (solo los pasos de texto fijo los llevan). GoHighLevel es de solo texto: ese paso no puede salir
      const stepFiles = step.mode === 'fixed_text' ? await tx.select().from(agentFollowUpFiles).where(and(eq(agentFollowUpFiles.followUpId, step.followUpId), eq(agentFollowUpFiles.stepPosition, step.position), eq(agentFollowUpFiles.state, 'ready'))).orderBy(asc(agentFollowUpFiles.sortOrder)) : [];
      if (stepFiles.length > 0 && l.channel.provider === 'ghl') return { kind: 'skip' as const, reason: 'channel_unavailable' as SkipReason };
      let history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
      if (step.mode === 'ai') {
        const recent = await tx
          .select({ direction: messages.direction, kind: messages.kind, body: messages.body, status: messages.status })
          .from(messages)
          .where(and(eq(messages.conversationId, l.conv.id), sql`${messages.status} <> 'internal'`, sql`${messages.kind} <> 'note'`))
          .orderBy(desc(messages.sentAt), desc(messages.id))
          .limit(14);
        history = [...recent]
          .reverse()
          .filter((m) => m.kind === 'text' && m.body && (m.direction === 'in' || m.status !== 'failed'))
          .map((m) => ({ role: m.direction === 'in' ? ('user' as const) : ('assistant' as const), text: m.body!.slice(0, 1500) }));
      }
      return { kind: 'go' as const, step, contactName: l.contactName, agentName: l.agentName, agentId: l.run.agentId, contactId: l.conv.contactId, history, stepFiles };
    });
    if (a.kind === 'gone') return 'skipped';
    if (a.kind === 'cancel') return this.finishRun(id, 'cancelled', a.reason, now);
    if (a.kind === 'skip') return this.finishRun(id, 'skipped', a.reason, now, ENDS_CHAIN.has(a.reason));
    if (a.kind === 'postpone') {
      await this.db.withTenant((tx) => tx.update(agentFollowUpRuns).set({ dueAt: a.at, processingStartedAt: null, updatedAt: now }).where(eq(agentFollowUpRuns.id, id)));
      return 'postponed';
    }

    // B) el texto
    let text: string | null = null;
    if (a.step.mode === 'fixed_text') {
      const r = resolveQuickReply(a.step.fixedText ?? '', { contactName: a.contactName, contactPhone: null, agentName: a.agentName, orgName: '', custom: {} });
      if (r.missing.length > 0 || r.text.trim() === '') return this.finishRun(id, 'skipped', 'missing_variable', now, false);
      text = r.text.trim();
    } else if (a.step.mode === 'ai') {
      try {
        const last = [...a.history].reverse().find((m) => m.role === 'user')?.text;
        const turn = await this.turns.run({ agentId: a.agentId, message: 'El cliente no ha respondido. Retoma la conversación.', guidance: GUIDANCE, ...(last ? { searchQuery: last } : {}), history: a.history, contactId: a.contactId, kind: 'follow_up' });
        text = turn.replies.join('\n\n').trim();
        if (text === '') return this.finishRun(id, 'skipped', 'empty_reply', now, false);
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (code === 'AI_NO_CREDITS') return this.finishRun(id, 'skipped', 'no_credits', now, true);
        if (code === 'AI_NOT_CONFIGURED' || code === 'AI_BUSY') {
          await this.db.withTenant((tx) => tx.update(agentFollowUpRuns).set({ processingStartedAt: null, dueAt: new Date(now.getTime() + RETRY_MS), updatedAt: now }).where(eq(agentFollowUpRuns.id, id)));
          return 'retry';
        }
        this.log.warn({ err: e instanceof Error ? e.message : 'desconocido', run_id: id }, 'la IA no pudo escribir el seguimiento');
        return this.finishRun(id, 'skipped', 'ai_unavailable', now, false);
      }
    }

    // B2) v15: cada archivo se COPIA a un adjunto propio de su mensaje (un archivo quitado del paso después no rompe lo ya enviado) y se revisa otra vez con el antivirus. Fuera de la transacción: leer y guardar tarda
    const copies: Array<{ id: string; key: string; scan: 'clean' | 'skipped'; file: (typeof a.stepFiles)[number] }> = [];
    const dropCopies = async (): Promise<void> => {
      for (const c of copies) await this.files.remove(c.key);
    };
    if (a.stepFiles.length > 0) {
      const organizationId = TenantContext.current().organizationId;
      for (const f of a.stepFiles) {
        try {
          if (!f.storageKey) throw new AppError(404, 'NOT_FOUND', 'Falta el archivo');
          const bytes = await this.files.read(f.storageKey);
          const copyId = uuidv7();
          const stored = await this.files.scanAndStore(organizationId, copyId, { bytes, mime: f.mimeType });
          copies.push({ id: copyId, key: stored.key, scan: stored.scanStatus, file: f });
        } catch (e) {
          await dropCopies();
          const code = (e as { code?: string } | null)?.code;
          if (code === 'ATTACHMENT_INFECTED') return this.finishRun(id, 'skipped', 'attachment_infected', now, true);
          if (code === 'NOT_FOUND') return this.finishRun(id, 'skipped', 'attachment_unavailable', now, true);
          // Almacenamiento o antivirus caídos un momento: se reintenta, no se descarta el paso
          await this.db.withTenant((tx) => tx.update(agentFollowUpRuns).set({ processingStartedAt: null, dueAt: new Date(now.getTime() + RETRY_MS), updatedAt: now }).where(and(eq(agentFollowUpRuns.id, id), eq(agentFollowUpRuns.status, 'pending'))));
          return 'retry';
        }
      }
    }

    // C) volver a comprobar y enviar
    return this.db.withTenant(async (tx) => {
      const l = await this.load(tx, id, true);
      if (!l || l.run.status !== 'pending') {
        await dropCopies();
        return 'skipped' as const;
      }
      const reason = cancelReason({ chainInboundAt: l.run.chainInboundAt, ownerId: l.run.ownerId }, l.snapshot);
      if (reason) {
        await dropCopies();
        await this.resolve(tx, l, 'cancelled', reason, now, true); // cancelar termina la cadena
        return 'cancelled' as const;
      }
      const step = l.step!;
      let messageId: string | null = null;
      if (copies.length > 0 && text !== null) {
        // Texto y archivos, EN ORDEN y uno por mensaje (el texto de pie del primero si lleva pie; si no, antes). Mensajes automáticos: no cuentan como respuesta humana
        const parts = planParts(text, copies.map((c) => ({ id: c.id, kind: c.file.kind as 'image' | 'video' | 'audio' | 'document' })));
        for (const [i, part] of parts.entries()) {
          const at = new Date(now.getTime() + i);
          if (part.type === 'text') {
            const [m] = await tx
              .insert(messages)
              .values({ conversationId: l.conv.id, channelAccountId: l.conv.channelAccountId, direction: 'out', senderType: 'automation', kind: 'text', body: part.body, status: 'queued', sentAt: at, attempts: 0, nextAttemptAt: now, meta: { agent_id: l.run.agentId, follow_up: step.position } })
              .returning({ id: messages.id });
            messageId = m!.id;
          } else {
            const c = copies.find((x) => x.id === part.fileId)!;
            const [m] = await tx
              .insert(messages)
              .values({ conversationId: l.conv.id, channelAccountId: l.conv.channelAccountId, direction: 'out', senderType: 'automation', kind: part.kind, body: part.caption, status: 'queued', sentAt: at, attempts: 0, nextAttemptAt: now, meta: { agent_id: l.run.agentId, follow_up: step.position } })
              .returning({ id: messages.id });
            messageId = m!.id;
            await tx.insert(messageAttachments).values({ id: c.id, conversationId: l.conv.id, messageId: m!.id, direction: 'out', kind: c.file.kind, mimeType: c.file.mimeType, filename: c.file.filename, sizeBytes: c.file.sizeBytes, storageKey: c.key, checksum: c.file.checksum, state: 'ready', scanStatus: c.scan });
          }
        }
        await tx.update(conversations).set({ lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${now}::timestamptz), ${now}::timestamptz)`, updatedAt: now }).where(eq(conversations.id, l.conv.id));
      } else if (text !== null) {
        const [m] = await tx
          .insert(messages)
          .values({ conversationId: l.conv.id, channelAccountId: l.conv.channelAccountId, direction: 'out', senderType: 'ai', kind: 'text', body: text, status: 'queued', sentAt: now, attempts: 0, nextAttemptAt: now, meta: { agent_id: l.run.agentId, follow_up: step.position } })
          .returning({ id: messages.id });
        messageId = m!.id;
        await tx.update(conversations).set({ lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${now}::timestamptz), ${now}::timestamptz)`, updatedAt: now }).where(eq(conversations.id, l.conv.id));
      }
      let automationNote = '';
      if (step.startAutomationId) automationNote = await this.startAutomation(tx, l, step.startAutomationId, id);
      const note = `Seguimiento ${step.position} enviado por el agente ${l.agentName}${text === null ? ' (sin mensaje)' : ''}${copies.length > 0 ? ` con ${copies.length} ${copies.length === 1 ? 'archivo' : 'archivos'}` : ''}${automationNote}`;
      await tx.insert(messages).values({ conversationId: l.conv.id, channelAccountId: l.conv.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: note.slice(0, 2000), status: 'internal', sentAt: now });
      await writeAudit(tx, { entityType: 'conversation', entityId: l.conv.id, field: 'ai_follow_up', oldValue: null, newValue: { step: step.position, mode: step.mode, automation: step.startAutomationId, files: copies.map((c) => ({ kind: c.file.kind, size_bytes: c.file.sizeBytes })) }, source: 'ai' }); // solo tipo y tamaño: nunca el contenido
      await this.resolve(tx, l, 'sent', null, now, false);
      this.realtime.touchHere(l.conv.id, messageId ? { message: { id: messageId, kind: 'created' } } : {});
      return 'sent' as const;
    });
  }

  /** Cierra un paso sin enviar nada (cancelado u omitido) y, si corresponde, arma el siguiente. */
  private async finishRun(id: string, status: 'cancelled' | 'skipped', reason: CancelReason | SkipReason, now: Date, endsChain = false): Promise<Outcome> {
    await this.db.withTenant(async (tx) => {
      const l = await this.load(tx, id, true);
      if (!l || l.run.status !== 'pending') return;
      await this.resolve(tx, l, status, reason, now, status === 'cancelled' ? true : endsChain);
      // v15: si un archivo hizo fallar el paso, queda dicho en la conversación («qué hizo el agente») y los pasos siguientes no salen
      if (reason === 'attachment_infected' || reason === 'attachment_unavailable') {
        const why = reason === 'attachment_infected' ? 'el antivirus bloqueó uno de sus archivos' : 'falta uno de sus archivos';
        await tx.insert(messages).values({ conversationId: l.conv.id, channelAccountId: l.conv.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: `Seguimiento ${l.run.stepPosition} del agente ${l.agentName} no se envió: ${why}. No se enviarán los pasos siguientes.`, status: 'internal', sentAt: now });
      }
    });
    return status;
  }

  /** Deja el desenlace del paso y, si no terminó la cadena, programa el siguiente contado desde AHORA (el momento del envío o de la omisión). */
  private async resolve(tx: TenantTx, l: Loaded, status: 'sent' | 'skipped' | 'cancelled', reason: string | null, now: Date, endsChain: boolean): Promise<void> {
    await tx.update(agentFollowUpRuns).set({ status, reason, processedAt: now, processingStartedAt: null, updatedAt: now }).where(eq(agentFollowUpRuns.id, l.run.id));
    if (endsChain) return;
    const [cfg] = await tx.select({ id: agentFollowUps.id }).from(agentFollowUps).where(and(eq(agentFollowUps.agentId, l.run.agentId), eq(agentFollowUps.scenario, SCENARIO), eq(agentFollowUps.enabled, true))).limit(1);
    if (!cfg) return;
    const [next] = await tx.select({ delay: agentFollowUpSteps.delayMinutes }).from(agentFollowUpSteps).where(and(eq(agentFollowUpSteps.followUpId, cfg.id), eq(agentFollowUpSteps.position, l.run.stepPosition + 1))).limit(1);
    if (!next) return;
    await tx
      .insert(agentFollowUpRuns)
      .values({ agentId: l.run.agentId, conversationId: l.run.conversationId, scenario: SCENARIO, chainInboundAt: l.run.chainInboundAt, anchorAt: now, ownerId: l.run.ownerId, stepPosition: l.run.stepPosition + 1, dueAt: dueAt(now, next.delay) })
      .onConflictDoNothing();
  }

  /** Inicia la automatización elegida para el contacto (con las defensas de siempre). Un fallo NO impide el seguimiento: queda dicho en la nota. */
  private async startAutomation(tx: TenantTx, l: Loaded, automationId: string, runId: string): Promise<string> {
    const [rule] = await tx.select().from(automations).where(and(eq(automations.id, automationId), isNull(automations.deletedAt))).limit(1);
    if (!rule || rule.status !== 'active') return ' · la automatización elegida no está activa';
    try {
      const r = await this.enqueue.callRule(tx, rule, l.conv.contactId, null, `follow-up:${runId}`);
      return r === 'queued' ? ` · se inició «${rule.name}»` : ` · «${rule.name}» no se inició (${r})`;
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : 'desconocido', run_id: runId }, 'no se pudo iniciar la automatización del seguimiento');
      return ` · «${rule.name}» no se pudo iniciar`;
    }
  }

  /** La conversación, el agente y todo lo que decide si el paso sigue haciendo falta, leído UNA vez (con `lock`, bajo el bloqueo de la conversación). */
  private async load(tx: TenantTx, runId: string, lock = false): Promise<Loaded | null> {
    const [run] = await tx.select().from(agentFollowUpRuns).where(eq(agentFollowUpRuns.id, runId)).limit(1);
    if (!run) return null;
    const q = tx
      .select({ id: conversations.id, status: conversations.status, deletedAt: conversations.deletedAt, ownerId: conversations.ownerId, queueId: conversations.queueId, lastInboundAt: conversations.lastInboundAt, channelAccountId: conversations.channelAccountId, contactId: conversations.contactId })
      .from(conversations)
      .where(eq(conversations.id, run.conversationId))
      .limit(1);
    const [conv] = lock ? await q.for('update') : await q;
    if (!conv) return { run, conv: null as never, channel: { provider: '', status: '' }, contactName: '', consent: 'unknown', agentName: '', step: null, snapshot: { conversation: null, consent: null, agentActive: false, agentLinked: false, agentState: null, humanWroteAfterAnchor: false, enabled: false, stepExists: false } };
    const [channel] = await tx.select({ provider: channelAccounts.provider, status: channelAccounts.status }).from(channelAccounts).where(eq(channelAccounts.id, conv.channelAccountId)).limit(1);
    const [contact] = await tx.select({ name: contacts.name, consent: contacts.consent }).from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
    const [agent] = await tx.select({ name: agents.name, active: agents.active, deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, run.agentId)).limit(1);
    const [state] = await tx.select({ status: aiConversationState.status }).from(aiConversationState).where(eq(aiConversationState.conversationId, conv.id)).limit(1);
    const linked = (await this.runtime.channelAgent(tx, conv.id)) === run.agentId;
    const [cfg] = await tx.select().from(agentFollowUps).where(and(eq(agentFollowUps.agentId, run.agentId), eq(agentFollowUps.scenario, SCENARIO))).limit(1);
    const [step] = cfg ? await tx.select().from(agentFollowUpSteps).where(and(eq(agentFollowUpSteps.followUpId, cfg.id), eq(agentFollowUpSteps.position, run.stepPosition))).limit(1) : [];
    const human = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'out'), eq(messages.senderType, 'human'), sql`${messages.status} <> 'internal'`, gt(messages.sentAt, run.anchorAt)))
      .limit(1);
    return {
      run,
      conv,
      channel: channel ?? { provider: '', status: 'disabled' },
      contactName: contact?.name ?? '',
      consent: contact?.consent ?? 'unknown',
      agentName: agent?.name ?? '',
      step: step ?? null,
      snapshot: {
        conversation: { status: conv.status, deleted: conv.deletedAt !== null, ownerId: conv.ownerId, lastInboundAt: conv.lastInboundAt },
        consent: contact?.consent ?? null,
        agentActive: !!agent && agent.active && agent.deletedAt === null,
        agentLinked: linked,
        agentState: state?.status ?? null,
        humanWroteAfterAnchor: human.length > 0,
        enabled: cfg?.enabled ?? false,
        stepExists: !!step,
      },
    };
  }
}
