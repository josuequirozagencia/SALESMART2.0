import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { aiToolCalls, contacts, conversations, Database, tasks, type TenantTx } from '../../../db';
import type { AppLogger } from '../../../logger';
import { APP_LOGGER } from '../../../tokens';
import { writeAudit } from '../../audit';
import { CustomValuesService } from '../../custom-fields';
import { AgentsService } from '../agents/agents.service';
import type { ToolCall } from '../ai.ports';
import { MAX_AI_TASKS_PER_DAY, MAX_TASK_DAYS, MAX_TASK_NOTES, MAX_TASK_TITLE, parseArgs, TOOL_CREATE_TASK, TOOL_NAMES, TOOL_TRANSFER, TOOL_UPDATE_FIELDS, type ToolConfig, type ToolName } from './tool-defs';

export interface ToolContext {
  readonly agentId: string;
  readonly agentName: string;
  /** Sin conversación (simulador de prueba) no se escribe nada: `dryRun`. */
  readonly conversationId: string | null;
  readonly contactId: string | null;
  /** Valida y dice qué haría, pero NO escribe ni registra nada (el simulador de prueba). */
  readonly dryRun: boolean;
  readonly now: Date;
}

export type ToolOutcome = 'done' | 'unchanged' | 'rejected' | 'error' | 'simulated';

export interface ToolResult {
  readonly tool: string;
  readonly outcome: ToolOutcome;
  /** Lo que se le devuelve al modelo (y se muestra en «qué hizo el agente»). Sin datos de otras personas. */
  readonly detail: string;
  /** Lo que el servidor validó y usó (nunca el texto crudo del modelo). */
  readonly args: Record<string, unknown>;
  /** La herramienta pide pasar la conversación a una persona (lo hace quien llama, después de enviar las respuestas). */
  readonly transfer: boolean;
  /** Una frase para la nota interna de la conversación («guardó en la ficha: ciudad = Guayaquil»); null si no hubo cambios. */
  readonly summary: string | null;
}

/** Quita los caracteres de control (salto de línea incluido) y deja el texto en una línea acotada. */
const clean = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? [...v]
        .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};
const result = (tool: string, outcome: ToolOutcome, detail: string, extra: Partial<Pick<ToolResult, 'args' | 'transfer' | 'summary'>> = {}): ToolResult => ({ tool, outcome, detail, args: extra.args ?? {}, transfer: extra.transfer ?? false, summary: extra.summary ?? null });

/**
 * Ejecuta las herramientas que pide el modelo (M8.5b, ADR-53; F17). **Todo se valida aquí con lo que el AGENTE tiene permitido**, no con lo que el modelo diga: un campo que no está en su lista, una
 * herramienta apagada, un argumento mal formado o un contacto que pidió no recibir mensajes se rechazan con el motivo, que vuelve al modelo. Lo que sí se hace queda en la auditoría con origen `ai`
 * (valor anterior y nuevo) y en `ai_tool_calls` (solo inserción). Reglas de F17: la IA **no pisa un campo que editó una persona** ni vacía campos; las tareas van al responsable de la conversación,
 * con tope diario y sin duplicados. Cada llamada es su propia transacción: una que falla no deshace las otras.
 */
@Injectable()
export class AgentToolsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Qué puede hacer el agente: sus campos permitidos que siguen existiendo y activos, y sus interruptores. */
  async configFor(agentId: string): Promise<ToolConfig> {
    const s = await this.agents.runtimeSettings(agentId);
    const fields = s.captureFields.length > 0 ? await this.db.withTenant((tx) => this.custom.contactFields(tx, s.captureFields)) : [];
    return { fields, tasksEnabled: s.tasksEnabled, transferEnabled: s.transferEnabled };
  }

  async execute(cfg: ToolConfig, ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    if (!(TOOL_NAMES as readonly string[]).includes(call.name)) return result(call.name.slice(0, 40), 'rejected', 'esa herramienta no existe');
    const tool = call.name as ToolName;
    const args = parseArgs(call);
    if (args === null) return this.finish(ctx, tool, result(tool, 'rejected', 'los argumentos no son válidos'));
    try {
      switch (tool) {
        case TOOL_UPDATE_FIELDS:
          return await this.updateFields(cfg, ctx, args);
        case TOOL_CREATE_TASK:
          return await this.createTask(cfg, ctx, args);
        case TOOL_TRANSFER:
          return await this.transfer(cfg, ctx, args);
      }
    } catch (e) {
      this.log.error({ err: e, tool, conversation_id: ctx.conversationId }, 'falló una herramienta del agente de IA'); // sin el contenido de la conversación
      return this.finish(ctx, tool, result(tool, 'error', 'no se pudo completar'));
    }
  }

  // ------------------------------------------------------------------ campos del contacto

  private async updateFields(cfg: ToolConfig, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const entries = Object.entries(args);
    if (cfg.fields.length === 0) return this.finish(ctx, TOOL_UPDATE_FIELDS, result(TOOL_UPDATE_FIELDS, 'rejected', 'este agente no puede guardar datos en la ficha'));
    if (entries.length === 0 || entries.length > 10) return this.finish(ctx, TOOL_UPDATE_FIELDS, result(TOOL_UPDATE_FIELDS, 'rejected', 'indica entre 1 y 10 campos con su valor'));
    const allowed = new Set(cfg.fields.map((f) => f.key));
    const permitted: Record<string, unknown> = {};
    const rejected: Array<{ key: string; reason: string }> = [];
    for (const [k, v] of entries) {
      if (allowed.has(k)) permitted[k] = v;
      else rejected.push({ key: k.slice(0, 40), reason: 'no tienes permiso para ese campo' });
    }
    const why = (): string => rejected.map((r) => `${r.key} (${r.reason})`).join('; ');

    if (ctx.dryRun || ctx.contactId === null || ctx.conversationId === null) {
      const errors = await this.db.withTenant(async (tx) => (await this.custom.validator(tx, 'contact'))(permitted));
      const bad = new Map(errors.map((e) => [String(e.path).replace(/^custom_fields\./, ''), e.message]));
      for (const [k, m] of bad) rejected.push({ key: k, reason: m });
      const ok = Object.entries(permitted).filter(([k]) => !bad.has(k));
      const detail = [ok.length > 0 ? `guardaría ${ok.map(([k, v]) => `${k} = ${short(v)}`).join(', ')}` : '', rejected.length > 0 ? `rechazaría ${why()}` : ''].filter(Boolean).join(' · ');
      return result(TOOL_UPDATE_FIELDS, ok.length > 0 ? 'simulated' : 'rejected', detail, { args: Object.fromEntries(ok) });
    }

    const { contactId, conversationId } = ctx;
    return this.db.withTenant(async (tx) => {
      const [c] = await tx.select({ consent: contacts.consent }).from(contacts).where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1);
      let r: ToolResult;
      if (!c) r = result(TOOL_UPDATE_FIELDS, 'rejected', 'el contacto no está disponible');
      else if (c.consent === 'revoked') r = result(TOOL_UPDATE_FIELDS, 'rejected', 'el contacto pidió no recibir mensajes: no se modifica su ficha');
      else {
        const out = await this.custom.applyForAi(tx, contactId, permitted);
        rejected.push(...out.rejected);
        for (const ch of out.changes) await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: `custom.${ch.key}`, oldValue: ch.oldValue, newValue: ch.newValue, source: 'ai' });
        const saved = Object.fromEntries(out.changes.map((ch) => [ch.key, ch.newValue]));
        const detail = [out.changes.length > 0 ? `guardado: ${out.changes.map((ch) => `${ch.key} = ${short(ch.newValue)}`).join(', ')}` : '', out.unchanged.length > 0 ? `ya estaba igual: ${out.unchanged.join(', ')}` : '', rejected.length > 0 ? `no se guardó: ${why()}` : ''].filter(Boolean).join(' · ');
        const outcome: ToolOutcome = out.changes.length > 0 ? 'done' : rejected.length > 0 ? 'rejected' : 'unchanged';
        r = result(TOOL_UPDATE_FIELDS, outcome, detail, { args: saved, summary: out.changes.length > 0 ? `guardó en la ficha: ${out.changes.map((ch) => `${ch.key} = ${short(ch.newValue)}`).join(', ')}` : null });
      }
      await this.record(tx, ctx, conversationId, contactId, r, null);
      return r;
    });
  }

  // ------------------------------------------------------------------ tareas

  private async createTask(cfg: ToolConfig, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!cfg.tasksEnabled) return this.finish(ctx, TOOL_CREATE_TASK, result(TOOL_CREATE_TASK, 'rejected', 'este agente no puede crear tareas'));
    const title = clean(args['title'], MAX_TASK_TITLE);
    const notes = clean(args['notes'], MAX_TASK_NOTES);
    const days = args['due_in_days'];
    if (title === '') return this.finish(ctx, TOOL_CREATE_TASK, result(TOOL_CREATE_TASK, 'rejected', 'falta el título de la tarea'));
    if (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_TASK_DAYS)) return this.finish(ctx, TOOL_CREATE_TASK, result(TOOL_CREATE_TASK, 'rejected', `los días deben ser un entero entre 0 y ${MAX_TASK_DAYS}`));
    const dueAt = typeof days === 'number' ? new Date(ctx.now.getTime() + days * 86_400_000) : null;
    const saved = { title, ...(notes ? { notes } : {}), ...(typeof days === 'number' ? { due_in_days: days } : {}) };
    if (ctx.dryRun || ctx.contactId === null || ctx.conversationId === null) return result(TOOL_CREATE_TASK, 'simulated', `crearía la tarea «${title}»${typeof days === 'number' ? ` para dentro de ${days} día(s)` : ''}`, { args: saved });

    const { contactId, conversationId } = ctx;
    return this.db.withTenant(async (tx) => {
      const since = new Date(ctx.now.getTime() - 86_400_000);
      const [made] = await tx.select({ n: sql<number>`count(*)::int` }).from(aiToolCalls).where(and(eq(aiToolCalls.conversationId, conversationId), eq(aiToolCalls.tool, TOOL_CREATE_TASK), eq(aiToolCalls.outcome, 'done'), gt(aiToolCalls.createdAt, since)));
      let r: ToolResult;
      let taskId: string | null = null;
      if ((made?.n ?? 0) >= MAX_AI_TASKS_PER_DAY) r = result(TOOL_CREATE_TASK, 'rejected', `ya se crearon ${MAX_AI_TASKS_PER_DAY} tareas en esta conversación hoy`, { args: saved });
      else {
        const [conv] = await tx.select({ ownerId: conversations.ownerId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
        const [ct] = await tx.select({ ownerId: contacts.ownerId, consent: contacts.consent }).from(contacts).where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1);
        const assignee = conv?.ownerId ?? ct?.ownerId ?? null;
        if (!ct) r = result(TOOL_CREATE_TASK, 'rejected', 'el contacto no está disponible', { args: saved });
        else if (assignee === null) r = result(TOOL_CREATE_TASK, 'rejected', 'todavía no hay una persona responsable de esta conversación: se le avisará al equipo', { args: saved });
        else {
          const [dup] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.contactId, contactId), eq(tasks.status, 'open'), isNull(tasks.deletedAt), gt(tasks.createdAt, since), sql`lower(${tasks.title}) = lower(${title})`)).limit(1);
          if (dup) r = result(TOOL_CREATE_TASK, 'unchanged', 'ya existe una tarea igual', { args: saved });
          else {
            const description = `${notes ? `${notes}\n\n` : ''}Creada por el agente de IA ${ctx.agentName}.`;
            const [row] = await tx.insert(tasks).values({ title, description, dueAt, assigneeId: assignee, contactId, createdBy: assignee }).returning({ id: tasks.id });
            taskId = row!.id;
            await writeAudit(tx, { entityType: 'task', entityId: taskId, newValue: { title, due_at: dueAt?.toISOString() ?? null, assignee_id: assignee, contact_id: contactId, has_description: true }, source: 'ai' });
            r = result(TOOL_CREATE_TASK, 'done', 'tarea creada para el responsable de la conversación', { args: saved, summary: `creó la tarea «${title}»` });
          }
        }
      }
      await this.record(tx, ctx, conversationId, contactId, r, taskId);
      return r;
    });
  }

  // ------------------------------------------------------------------ pasar a una persona

  private async transfer(cfg: ToolConfig, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!cfg.transferEnabled) return this.finish(ctx, TOOL_TRANSFER, result(TOOL_TRANSFER, 'rejected', 'este agente no puede pasar la conversación a una persona'));
    const reason = clean(args['reason'], 200);
    const r = ctx.dryRun || ctx.conversationId === null ? result(TOOL_TRANSFER, 'simulated', 'pasaría la conversación a una persona', { args: { reason }, transfer: true }) : result(TOOL_TRANSFER, 'done', 'la conversación pasará a una persona del equipo', { args: { reason }, transfer: true });
    return this.finish(ctx, TOOL_TRANSFER, r);
  }

  // ------------------------------------------------------------------ registro

  /** Anota la llamada en `ai_tool_calls` (si no es una prueba) y la devuelve. */
  private async finish(ctx: ToolContext, tool: ToolName, r: ToolResult): Promise<ToolResult> {
    if (ctx.dryRun || ctx.conversationId === null || ctx.contactId === null) return r;
    const { conversationId, contactId } = ctx;
    await this.db.withTenant((tx) => this.record(tx, ctx, conversationId, contactId, r, null));
    return r;
  }

  private async record(tx: TenantTx, ctx: ToolContext, conversationId: string, contactId: string, r: ToolResult, entityId: string | null): Promise<void> {
    if (r.outcome === 'simulated') return;
    await tx.insert(aiToolCalls).values({ conversationId, agentId: ctx.agentId, contactId, tool: r.tool, args: r.args, outcome: r.outcome, detail: r.detail.slice(0, 500), entityId, createdAt: ctx.now });
  }
}
