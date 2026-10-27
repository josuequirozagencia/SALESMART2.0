import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { automationRuns, automationRunSteps, automations, channelAccounts, contacts, Database, pipelines, pipelineStages, queues, tags, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService } from '../custom-fields';
import { OrgMembersService } from '../organizations';
import { TemplatesService } from '../templates';
import { ACTION_LABEL, definitionSchema, renderParam, MAX_AUTOMATIONS, type ActionDef, type ConditionDef, type TriggerDef } from './automation-model';
import type { CreateAutomationDto, RunsQuery, UpdateAutomationDto } from './automations.dto';

const AUDIT = 'automation';
type Row = typeof automations.$inferSelect;

export interface AutomationView {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused';
  trigger: TriggerDef;
  conditions: ConditionDef[];
  actions: ActionDef[];
  version: number;
  /** Ejecuciones de los últimos 7 días por resultado. */
  recent: { done: number; skipped: number; failed: number; queued: number };
  created_at: string;
  updated_at: string;
}
export interface RunView {
  id: string;
  at: string;
  status: 'queued' | 'done' | 'skipped' | 'failed';
  reason: string | null;
  event_type: string;
  depth: number;
  contact: { id: string; name: string };
  steps: Array<{ position: number; action: string; label: string; outcome: string; detail: string | null }>;
}

const bad = (path: string, code: string, message: string): ValidationError => new ValidationError([{ path, code, message }]);
const shape = (r: Row): Pick<AutomationView, 'trigger' | 'conditions' | 'actions'> => ({
  trigger: { type: r.triggerType as TriggerDef['type'], filter: r.triggerFilter },
  conditions: r.conditions as ConditionDef[],
  actions: r.actions as ActionDef[],
});

/**
 * Administración de las automatizaciones de la empresa (M9.3, ADR-54; F20): crearlas, editarlas, activarlas o pausarlas y ver cómo les ha ido. Solo quien administra automatizaciones
 * (`automations.manage`). El servidor valida SIEMPRE la definición completa (esquema estricto) y que todo lo que nombra exista en ESTA empresa (etapas, colas, etiquetas, personas, conexiones,
 * plantillas, campos); activar exige además al menos una acción. Cada cambio queda auditado; el borrado es lógico y libera el nombre. La ejecución vive en el motor (`AutomationRunnerService`).
 */
@Injectable()
export class AutomationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
  ) {}

  // ------------------------------------------------------------------ lectura

  async list(): Promise<{ items: AutomationView[]; limits: { max_automations: number } }> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const { rows, recent } = await this.db.withTenant(async (tx) => {
      const rows = await tx.select().from(automations).where(isNull(automations.deletedAt)).orderBy(asc(automations.createdAt), asc(automations.id));
      return { rows, recent: await this.recent(tx, rows.map((r) => r.id), since) };
    });
    return { items: rows.map((r) => this.view(r, recent.get(r.id))), limits: { max_automations: MAX_AUTOMATIONS } };
  }

  async get(id: string): Promise<AutomationView> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    return this.db.withTenant(async (tx) => {
      const row = await this.byId(tx, id);
      return this.view(row, (await this.recent(tx, [id], since)).get(id));
    });
  }

  /** Las ejecuciones de la regla, las más recientes primero, con lo que hizo cada paso. */
  async runs(id: string, q: RunsQuery): Promise<{ items: RunView[]; next_cursor: string | null }> {
    const cur = this.decodeCursor(q.cursor);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, id);
      const conds = [eq(automationRuns.automationId, id), ...(q.status ? [eq(automationRuns.status, q.status)] : []), ...(cur ? [or(lt(automationRuns.createdAt, cur.at), and(eq(automationRuns.createdAt, cur.at), lt(automationRuns.id, cur.id)))!] : [])];
      const rows = await tx
        .select({ r: automationRuns, contactName: contacts.name })
        .from(automationRuns)
        .innerJoin(contacts, and(eq(contacts.organizationId, automationRuns.organizationId), eq(contacts.id, automationRuns.contactId)))
        .where(and(...conds))
        .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const steps = page.length > 0 ? await tx.select().from(automationRunSteps).where(inArray(automationRunSteps.runId, page.map((p) => p.r.id))).orderBy(asc(automationRunSteps.position)) : [];
      const byRun = new Map<string, typeof steps>();
      for (const s of steps) byRun.set(s.runId, [...(byRun.get(s.runId) ?? []), s]);
      const last = page.at(-1);
      return {
        items: page.map(({ r, contactName }) => ({
          id: r.id,
          at: r.createdAt.toISOString(),
          status: r.status as RunView['status'],
          reason: r.reason,
          event_type: r.eventType,
          depth: r.depth,
          contact: { id: r.contactId, name: contactName },
          steps: (byRun.get(r.id) ?? []).map((s) => ({ position: s.position, action: s.actionType, label: ACTION_LABEL[s.actionType as ActionDef['type']] ?? s.actionType, outcome: s.outcome, detail: s.detail })),
        })),
        next_cursor: rows.length > q.limit && last ? Buffer.from(`${last.r.createdAt.toISOString()}|${last.r.id}`).toString('base64url') : null,
      };
    });
  }

  // ------------------------------------------------------------------ crear, cambiar, activar, borrar

  async create(input: CreateAutomationDto): Promise<AutomationView> {
    const userId = TenantContext.current().userId ?? null;
    const people = await this.people();
    const row = await this.db
      .withTenant(async (tx) => {
        const [n] = await tx.select({ n: count() }).from(automations).where(isNull(automations.deletedAt));
        if ((n?.n ?? 0) >= MAX_AUTOMATIONS) throw new ConflictError('AUTOMATION_LIMIT', `Se alcanzó el máximo de ${MAX_AUTOMATIONS} automatizaciones. Borra alguna para crear otra`);
        await this.assertReferences(tx, { trigger: input.trigger, conditions: input.conditions, actions: input.actions }, people);
        const [created] = await tx
          .insert(automations)
          .values({ name: input.name, description: input.description?.trim() || null, triggerType: input.trigger.type, triggerFilter: input.trigger.filter, conditions: input.conditions, actions: input.actions, createdBy: userId })
          .returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: created!.id, newValue: { name: input.name, trigger: input.trigger.type, conditions: input.conditions.length, actions: input.actions.length }, source: 'manual' });
        return created!;
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return this.view(row, undefined);
  }

  async update(id: string, patch: UpdateAutomationDto): Promise<AutomationView> {
    const people = await this.people();
    const row = await this.db
      .withTenant(async (tx) => {
        const cur = await this.lock(tx, id);
        const next = { trigger: patch.trigger ?? shape(cur).trigger, conditions: patch.conditions ?? shape(cur).conditions, actions: patch.actions ?? shape(cur).actions };
        const defChanged = patch.trigger !== undefined || patch.conditions !== undefined || patch.actions !== undefined;
        if (defChanged) {
          await this.assertReferences(tx, next, people);
          if (cur.status === 'active' && next.actions.length === 0) throw bad('actions', 'required', 'Una automatización activa necesita al menos una acción: pausa la regla para quitarlas todas');
        }
        const set: Partial<typeof automations.$inferInsert> = { updatedAt: new Date() };
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (patch.name !== undefined && patch.name !== cur.name) {
          set.name = patch.name;
          changes.push({ field: 'name', oldValue: cur.name, newValue: patch.name });
        }
        if (patch.description !== undefined && (patch.description?.trim() || null) !== cur.description) {
          set.description = patch.description?.trim() || null;
          changes.push({ field: 'description', oldValue: { length: cur.description?.length ?? 0 }, newValue: { length: patch.description?.length ?? 0 } });
        }
        if (patch.trigger !== undefined && JSON.stringify(patch.trigger) !== JSON.stringify(shape(cur).trigger)) {
          set.triggerType = patch.trigger.type;
          set.triggerFilter = patch.trigger.filter;
          changes.push({ field: 'trigger', oldValue: shape(cur).trigger, newValue: patch.trigger });
        }
        if (patch.conditions !== undefined && JSON.stringify(patch.conditions) !== JSON.stringify(cur.conditions)) {
          set.conditions = patch.conditions;
          changes.push({ field: 'conditions', oldValue: cur.conditions, newValue: patch.conditions });
        }
        if (patch.actions !== undefined && JSON.stringify(patch.actions) !== JSON.stringify(cur.actions)) {
          set.actions = patch.actions;
          changes.push({ field: 'actions', oldValue: { count: cur.actions.length }, newValue: patch.actions });
        }
        if (changes.length === 0) return cur;
        if (changes.some((c) => c.field === 'trigger' || c.field === 'conditions' || c.field === 'actions')) set.version = cur.version + 1;
        const [updated] = await tx.update(automations).set(set).where(eq(automations.id, id)).returning();
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return updated!;
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return this.view(row, undefined);
  }

  /** Activa la regla: desde ahora reacciona a los hechos NUEVOS (no a los de antes). Debe estar completa y todo lo que nombra debe seguir existiendo. */
  async activate(id: string): Promise<AutomationView> {
    const people = await this.people();
    const row = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, id);
      if (cur.status === 'active') return cur;
      const def = shape(cur);
      if (def.actions.length === 0) throw bad('actions', 'required', 'Agrega al menos una acción para activar la automatización');
      await this.assertReferences(tx, def, people);
      const [updated] = await tx.update(automations).set({ status: 'active', updatedAt: new Date() }).where(eq(automations.id, id)).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: cur.status, newValue: 'active', source: 'manual' });
      return updated!;
    });
    return this.view(row, undefined);
  }

  async pause(id: string): Promise<AutomationView> {
    const row = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, id);
      if (cur.status !== 'active') throw new ConflictError('AUTOMATION_NOT_ACTIVE', 'La automatización no está activa');
      const [updated] = await tx.update(automations).set({ status: 'paused', updatedAt: new Date() }).where(eq(automations.id, id)).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: 'active', newValue: 'paused', source: 'manual' });
      return updated!;
    });
    return this.view(row, undefined);
  }

  /** Borrado lógico; lo que esté en cola de esta regla se descarta solo al llegar su turno (la regla ya no existe). */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, id);
      await tx.update(automations).set({ deletedAt: new Date(), status: cur.status === 'active' ? 'paused' : cur.status, updatedAt: new Date() }).where(eq(automations.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, oldValue: { name: cur.name }, newValue: null, source: 'manual' });
    });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------------ validación de referencias

  /** Personas que pueden recibir trabajo (identidad: se lee ANTES de la transacción de negocio). */
  private async people(): Promise<ReadonlySet<string>> {
    return new Set((await this.members.assignable()).map((p) => p.id));
  }

  /** Que todo lo que la definición nombra exista en esta empresa y encaje (la forma ya la validó el esquema). */
  async assertReferences(tx: TenantTx, def: { trigger: TriggerDef; conditions: readonly ConditionDef[]; actions: readonly ActionDef[] }, people: ReadonlySet<string>): Promise<void> {
    const parsed = definitionSchema.safeParse(def);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: 'invalid', message: i.message })));
    const issues: ErrorDetail[] = [];
    const add = (path: string, message: string, code = 'not_found'): void => void issues.push({ path, code, message });
    const fields = await this.custom.definitionsByKey(tx, 'contact');
    const exists = {
      pipeline: async (id: string): Promise<boolean> => (await tx.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.id, id), isNull(pipelines.deletedAt))).limit(1)).length > 0,
      stage: async (id: string): Promise<(typeof pipelineStages.$inferSelect) | null> => (await tx.select().from(pipelineStages).where(and(eq(pipelineStages.id, id), isNull(pipelineStages.deletedAt))).limit(1))[0] ?? null,
      queue: async (id: string): Promise<boolean> => (await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, id), isNull(queues.deletedAt))).limit(1)).length > 0,
      tag: async (id: string): Promise<(typeof tags.$inferSelect) | null> => (await tx.select().from(tags).where(and(eq(tags.id, id), isNull(tags.deletedAt))).limit(1))[0] ?? null,
      channel: async (id: string, metaOnly: boolean): Promise<boolean> =>
        (await tx.select({ id: channelAccounts.id }).from(channelAccounts).where(and(eq(channelAccounts.id, id), isNull(channelAccounts.deletedAt), ...(metaOnly ? [eq(channelAccounts.provider, 'meta_cloud')] : []))).limit(1)).length > 0,
    };

    // Disparador
    const f = def.trigger.filter;
    const pipelineId = f['pipeline_id'] as string | undefined;
    if (pipelineId && !(await exists.pipeline(pipelineId))) add('trigger.filter.pipeline_id', 'El pipeline no existe');
    const toStage = f['to_stage_id'] as string | undefined;
    if (toStage) {
      const s = await exists.stage(toStage);
      if (!s) add('trigger.filter.to_stage_id', 'La etapa no existe');
      else if (pipelineId && s.pipelineId !== pipelineId) add('trigger.filter.to_stage_id', 'La etapa no es del pipeline elegido', 'mismatch');
    }
    const trigChannel = f['channel_id'] as string | undefined;
    if (trigChannel && !(await exists.channel(trigChannel, false))) add('trigger.filter.channel_id', 'La conexión no existe');
    if (def.trigger.type === 'field_changed' && !fields.has(f['field'] as string)) add('trigger.filter.field', 'Ese campo no existe o está archivado');

    // Condiciones
    for (const [i, c] of def.conditions.entries()) {
      const p = `conditions.${i}`;
      if (c.field.startsWith('custom:') && !fields.has(c.field.slice('custom:'.length))) add(`${p}.field`, 'Ese campo no existe o está archivado');
      if (c.field === 'tag' && c.value && !(await exists.tag(c.value))) add(`${p}.value`, 'La etiqueta no existe');
      if (c.field === 'owner' && (c.op === 'eq' || c.op === 'neq') && c.value && !people.has(c.value)) add(`${p}.value`, 'Esa persona no puede recibir trabajo en la empresa');
    }

    // Acciones
    const validate = await this.custom.validator(tx, 'contact');
    for (const [i, a] of def.actions.entries()) {
      const p = `actions.${i}`;
      switch (a.type) {
        case 'assign_user':
          if (!people.has(a.user_id)) add(`${p}.user_id`, 'Esa persona no puede recibir trabajo en la empresa');
          break;
        case 'assign_queue':
          if (!(await exists.queue(a.queue_id))) add(`${p}.queue_id`, 'La cola no existe');
          break;
        case 'move_stage': {
          const s = await exists.stage(a.stage_id);
          if (!s) add(`${p}.stage_id`, 'La etapa no existe');
          else if (s.kind !== 'open') add(`${p}.stage_id`, 'Solo se mueve a etapas abiertas: ganar y perder tienen su propio proceso (venta y motivo de pérdida)', 'not_open');
          else if (s.isHidden) add(`${p}.stage_id`, 'La etapa está oculta', 'hidden');
          break;
        }
        case 'set_field':
          for (const e of validate({ [a.field]: a.value })) issues.push({ ...e, path: `${p}.value` });
          break;
        case 'add_tag':
        case 'remove_tag': {
          const t = await exists.tag(a.tag_id);
          if (!t) add(`${p}.tag_id`, 'La etiqueta no existe');
          else if (t.isSystem) add(`${p}.tag_id`, 'Las etiquetas del sistema solo las pone el sistema', 'system_tag');
          break;
        }
        case 'create_task':
          if (a.assignee !== 'owner' && !people.has(a.assignee)) add(`${p}.assignee`, 'Esa persona no puede recibir trabajo en la empresa');
          break;
        case 'send_text':
          break;
        case 'send_template':
          if (!(await exists.channel(a.channel_id, true))) add(`${p}.channel_id`, 'La conexión no existe o no es de WhatsApp oficial');
          else {
            try {
              const row = await this.templates.getSendable(tx, a.channel_id, a.template_id);
              this.templates.prepare(row, Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, renderParam(v, { name: 'Ana Pérez' })])));
            } catch (e) {
              if (e instanceof NotFoundError) add(`${p}.template_id`, 'La plantilla no existe en esa conexión');
              else if (e instanceof ConflictError) add(`${p}.template_id`, e.message, 'not_sendable');
              else if (e instanceof ValidationError) for (const d of e.details) issues.push({ ...d, path: `${p}.params.${d.path}` });
              else throw e;
            }
          }
          break;
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  // ------------------------------------------------------------------ internos

  private async byId(tx: TenantTx, id: string): Promise<Row> {
    const [row] = await tx.select().from(automations).where(and(eq(automations.id, id), isNull(automations.deletedAt))).limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async lock(tx: TenantTx, id: string): Promise<Row> {
    const [row] = await tx.select().from(automations).where(and(eq(automations.id, id), isNull(automations.deletedAt))).limit(1).for('update');
    if (!row) throw new NotFoundError();
    return row;
  }

  private async recent(tx: TenantTx, ids: readonly string[], since: Date): Promise<Map<string, AutomationView['recent']>> {
    const out = new Map<string, AutomationView['recent']>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ id: automationRuns.automationId, status: automationRuns.status, n: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(and(inArray(automationRuns.automationId, [...ids]), sql`${automationRuns.createdAt} >= ${since.toISOString()}::timestamptz`))
      .groupBy(automationRuns.automationId, automationRuns.status);
    for (const r of rows) {
      const cur = out.get(r.id) ?? { done: 0, skipped: 0, failed: 0, queued: 0 };
      cur[r.status as keyof AutomationView['recent']] = r.n;
      out.set(r.id, cur);
    }
    return out;
  }

  private view(r: Row, recent: AutomationView['recent'] | undefined): AutomationView {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status as AutomationView['status'],
      ...shape(r),
      version: r.version,
      recent: recent ?? { done: 0, skipped: 0, failed: 0, queued: 0 },
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  private nameTaken(e: unknown): ConflictError | null {
    const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
    const c = err.cause ?? err;
    return c.code === '23505' && c.constraint_name === 'automations_name_uq' ? new ConflictError('AUTOMATION_NAME_TAKEN', 'Ya existe una automatización con ese nombre') : null;
  }

  private decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
    if (!cursor) return null;
    try {
      const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      const d = new Date(at ?? '');
      if (!id || Number.isNaN(d.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('cursor');
      return { at: d, id };
    } catch {
      throw bad('cursor', 'invalid', 'El cursor no es válido');
    }
  }
}
