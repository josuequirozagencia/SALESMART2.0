import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { companies, contacts, Database, taskRecurrences, tasks, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { TaskNoticesService } from '../task-notices';
import { CompaniesService } from './companies.service';
import type { CreateTaskDto, ListTasksQuery, RecurrenceDto, UpdateTaskDto } from './crm-extras.dto';
import { nextOccurrence, noticeAt, resolveRule, type RecurrenceEnds, type RecurrenceRule } from './recurrence';
import { ContactsRepository, type Scope } from './contacts.repository';
import type { ContactScope } from './contacts.service';

type TaskRow = typeof tasks.$inferSelect;
type SeriesRow = typeof taskRecurrences.$inferSelect;

/** La regla de repetición tal como la ve la web (F2, ADR-58). */
export interface RecurrenceView {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  weekdays: number[] | null;
  day_of_month: number | null;
  ends: RecurrenceEnds;
  /** Qué ocurrencia de la serie es esta tarea (la primera es la 1). */
  occurrence_no: number;
  occurrences_created: number;
}

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  status: 'open' | 'done';
  completed_at: string | null;
  assignee: { id: string; name: string };
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  created_by: string;
  /** Aviso anticipado del vencimiento (15, 60 o 1440 minutos antes); `null` = al vencer. */
  remind_before_minutes: number | null;
  /** La regla, si la tarea pertenece a una serie que sigue activa. */
  recurrence: RecurrenceView | null;
  /** Solo al completar una tarea que se repite: la siguiente (`null` si la serie terminó o no se repite). */
  next_task?: TaskView | null;
  /** Pendiente y con la fecha ya pasada. */
  overdue: boolean;
  /** Quien la creó o ve todo: editar y borrar. */
  can_edit: boolean;
  /** Además, su responsable: completar y reabrir. */
  can_complete: boolean;
  created_at: string;
  updated_at: string;
}

const AUDIT = 'task';
const AUDIT_SERIES = 'task_recurrence';
const BAD_CURSOR = (): ValidationError => new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
const TS_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;
const UUID_TEXT = /^[0-9a-f-]{36}$/i;

/**
 * Tareas del CRM (M3.6, ADR-48): pendiente de una persona con vencimiento opcional, vinculada a lo sumo a un contacto o una empresa. Con `contacts.view_all` se
 * ven todas; sin él, las asignadas a la persona o creadas por ella. F2 (ADR-58): una tarea puede repetirse (una sola abierta por serie; al completarla nace la siguiente, en la misma transacción) y
 * avisa a su responsable cuando se la asignan y cuando vence (`TaskNoticesService`).
 */
@Injectable()
export class TasksService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsRepository) private readonly contactsRepo: ContactsRepository,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(TaskNoticesService) private readonly notices: TaskNoticesService,
  ) {}

  async list(scope: ContactScope, q: ListTasksQuery): Promise<{ items: TaskView[]; next_cursor: string | null; total: number | null }> {
    const sc = this.scope(scope);
    if (!sc.viewAll && q.assignee !== 'me') throw new ForbiddenError('TASK_SCOPE', 'Solo puedes ver tus propias tareas');
    const base: SQL[] = [isNull(tasks.deletedAt), this.visible(sc)];
    if (q.assignee === 'me') base.push(eq(tasks.assigneeId, sc.userId));
    else if (q.assignee !== 'all') base.push(eq(tasks.assigneeId, q.assignee));
    if (q.status !== 'all') base.push(eq(tasks.status, q.status));
    if (q.overdue) base.push(sql`${tasks.status} = 'open' AND ${tasks.dueAt} < now()`);
    if (q.contact) base.push(eq(tasks.contactId, q.contact));
    if (q.company) base.push(eq(tasks.companyId, q.company));
    const page = await this.db.withTenant(async (tx) => {
      const where = [...base];
      if (q.cursor) where.push(this.after(q.sort, q.cursor));
      const order = q.sort === 'due' ? [sql`${tasks.dueAt} ASC NULLS LAST`, asc(tasks.id)] : [desc(tasks.createdAt), desc(tasks.id)];
      const rows = await tx
        .select({ row: tasks, due: sql<string | null>`${tasks.dueAt}::text`, created: sql<string>`${tasks.createdAt}::text` })
        .from(tasks)
        .where(and(...where))
        .orderBy(...order)
        .limit(q.limit + 1);
      const rest = rows.slice(0, q.limit);
      const last = rest.at(-1);
      const next = rows.length > q.limit && last ? Buffer.from(JSON.stringify(q.sort === 'due' ? { d: last.due, i: last.row.id } : { c: last.created, i: last.row.id })).toString('base64url') : null;
      let total: number | null = null;
      if (!q.cursor) total = (await tx.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(...base)))[0]?.n ?? 0;
      return { rows: rest.map((r) => r.row), next, total, links: await this.links(tx, rest.map((r) => r.row)) };
    });
    return { items: await this.views(sc, page.rows, page.links), next_cursor: page.next, total: page.total };
  }

  async get(scope: ContactScope, id: string): Promise<TaskView> {
    const sc = this.scope(scope);
    const found = await this.db.withTenant(async (tx) => {
      const row = await this.visibleById(tx, sc, id);
      return { row, links: await this.links(tx, [row]) };
    });
    return (await this.views(sc, [found.row], found.links))[0]!;
  }

  async create(scope: ContactScope, input: CreateTaskDto): Promise<TaskView> {
    const sc = this.scope(scope);
    const assignee = await this.assigneeFor(sc, input.assignee_id);
    // La zona horaria es de identidad: se lee ANTES de la transacción de negocio
    const timeZone = input.recurrence ? (await this.directory.current()).timeZone : null;
    const now = new Date();
    const out = await this.db.withTenant(async (tx) => {
      await this.assertLinks(tx, sc, input.contact_id ?? null, input.company_id ?? null);
      let recurrenceId: string | null = null;
      if (input.recurrence && input.due_at && timeZone) recurrenceId = await this.startSeries(tx, sc, resolveRule(input.recurrence, input.due_at, timeZone));
      const remind = input.remind_before_minutes ?? null;
      const [row] = await tx
        .insert(tasks)
        .values({
          title: input.title,
          description: input.description ?? null,
          dueAt: input.due_at ?? null,
          assigneeId: assignee,
          contactId: input.contact_id ?? null,
          companyId: input.company_id ?? null,
          createdBy: sc.userId,
          recurrenceId,
          occurrenceNo: recurrenceId ? 1 : null,
          remindBeforeMinutes: remind,
          noticeAt: noticeAt(input.due_at ?? null, remind, now),
        })
        .returning();
      await writeAudit(tx, {
        entityType: AUDIT,
        entityId: row!.id,
        newValue: { title: row!.title, due_at: row!.dueAt?.toISOString() ?? null, assignee_id: assignee, contact_id: row!.contactId, company_id: row!.companyId, has_description: row!.description !== null, recurrence_id: recurrenceId },
        source: 'manual',
      });
      const notice = await this.notices.assigned(tx, { taskId: row!.id, assigneeId: assignee, actorId: sc.userId });
      return { row: row!, links: await this.links(tx, [row!]), notice };
    });
    this.notices.push([out.notice]);
    return (await this.views(sc, [out.row], out.links))[0]!;
  }

  async update(scope: ContactScope, id: string, input: UpdateTaskDto): Promise<TaskView> {
    const sc = this.scope(scope);
    const assignee = input.assignee_id === undefined ? undefined : await this.assigneeFor(sc, input.assignee_id);
    const timeZone = input.recurrence ? (await this.directory.current()).timeZone : null;
    const now = new Date();
    const out = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, sc, id);
      if (cur.createdBy !== sc.userId && !sc.viewAll) throw new ForbiddenError('TASK_NOT_YOURS', 'Solo quien creó la tarea puede cambiarla');
      const set: Partial<typeof tasks.$inferInsert> = {};
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
      const change = (field: string, key: keyof typeof tasks.$inferInsert, oldValue: unknown, newValue: unknown): void => {
        set[key] = newValue as never;
        changes.push({ field, oldValue, newValue });
      };
      if (input.title !== undefined && input.title !== cur.title) change('title', 'title', cur.title, input.title);
      if (input.description !== undefined && (input.description ?? null) !== cur.description) {
        set.description = input.description ?? null;
        changes.push({ field: 'description', oldValue: { has: cur.description !== null }, newValue: { has: input.description !== null } });
      }
      if (input.due_at !== undefined && (input.due_at?.getTime() ?? null) !== (cur.dueAt?.getTime() ?? null)) {
        set.dueAt = input.due_at ?? null;
        changes.push({ field: 'due_at', oldValue: cur.dueAt?.toISOString() ?? null, newValue: input.due_at?.toISOString() ?? null });
      }
      if (assignee !== undefined && assignee !== cur.assigneeId) change('assignee_id', 'assigneeId', cur.assigneeId, assignee);
      // Vincular a un contacto quita la empresa y al revés (la BD admite uno solo)
      const contactId = input.contact_id !== undefined ? input.contact_id : input.company_id ? null : cur.contactId;
      const companyId = input.company_id !== undefined ? input.company_id : input.contact_id ? null : cur.companyId;
      if (contactId !== cur.contactId || companyId !== cur.companyId) {
        await this.assertLinks(tx, sc, contactId !== cur.contactId ? contactId : null, companyId !== cur.companyId ? companyId : null);
        if (contactId !== cur.contactId) change('contact_id', 'contactId', cur.contactId, contactId);
        if (companyId !== cur.companyId) change('company_id', 'companyId', cur.companyId, companyId);
      }
      if (input.remind_before_minutes !== undefined && (input.remind_before_minutes ?? null) !== cur.remindBeforeMinutes) change('remind_before_minutes', 'remindBeforeMinutes', cur.remindBeforeMinutes, input.remind_before_minutes ?? null);
      const due = set.dueAt === undefined ? cur.dueAt : set.dueAt;
      const remind = set.remindBeforeMinutes === undefined ? cur.remindBeforeMinutes : set.remindBeforeMinutes;
      // Cambiar el vencimiento, el aviso anticipado o el responsable vuelve a armar el aviso de vencimiento (si ese momento ya pasó, no se avisa)
      if (cur.status === 'open' && (set.dueAt !== undefined || set.remindBeforeMinutes !== undefined || set.assigneeId !== undefined)) set.noticeAt = noticeAt(due, remind, now);
      const series = await this.applyRecurrence(tx, sc, cur, input.recurrence, due, timeZone, set);
      const row = changes.length === 0 && Object.keys(set).length === 0 ? cur : (await tx.update(tasks).set({ ...set, updatedAt: now }).where(eq(tasks.id, id)).returning())[0]!;
      for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      if (series) await writeAudit(tx, { entityType: AUDIT_SERIES, entityId: series.id, field: series.field, oldValue: null, newValue: series.value, source: 'manual' });
      const notice = assignee !== undefined && assignee !== cur.assigneeId ? await this.notices.assigned(tx, { taskId: id, assigneeId: assignee, actorId: sc.userId }) : null;
      return { row, links: await this.links(tx, [row]), notice };
    });
    this.notices.push([out.notice]);
    return (await this.views(sc, [out.row], out.links))[0]!;
  }

  async complete(scope: ContactScope, id: string): Promise<TaskView> {
    return this.setStatus(scope, id, 'done');
  }

  async reopen(scope: ContactScope, id: string): Promise<TaskView> {
    return this.setStatus(scope, id, 'open');
  }

  async remove(scope: ContactScope, id: string): Promise<{ id: string; deleted: true }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, sc, id);
      if (cur.createdBy !== sc.userId && !sc.viewAll) throw new ForbiddenError('TASK_NOT_YOURS', 'Solo quien creó la tarea puede borrarla');
      await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date(), noticeAt: null }).where(eq(tasks.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      // Borrar la tarea abierta de una serie termina la serie (ADR-58 #5)
      if (cur.recurrenceId && cur.status === 'open') await this.endSeries(tx, cur.recurrenceId, 'deleted');
      return { id, deleted: true as const };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async setStatus(scope: ContactScope, id: string, status: 'open' | 'done'): Promise<TaskView> {
    const sc = this.scope(scope);
    // La zona horaria (identidad) se lee ANTES de la transacción; con la caché de la empresa es una lectura barata
    const timeZone = status === 'done' ? (await this.directory.current()).timeZone : null;
    const out = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, sc, id);
      if (cur.assigneeId !== sc.userId && cur.createdBy !== sc.userId && !sc.viewAll) throw new ForbiddenError('TASK_NOT_YOURS', 'Solo su responsable o quien la creó puede completarla');
      if (cur.status === status) return { row: cur, links: await this.links(tx, [cur]), next: status === 'done' ? await this.successorOf(tx, cur) : null };
      const now = new Date();
      let next: TaskRow | null = null;
      if (status === 'open' && cur.recurrenceId && (await this.successorOf(tx, cur))) throw new ConflictError('TASK_SUCCESSOR_EXISTS', 'La siguiente de esta tarea ya existe: no se puede reabrir esta');
      const [row] = await tx
        .update(tasks)
        .set(
          status === 'done'
            ? { status, completedAt: now, completedBy: sc.userId, updatedAt: now, noticeAt: null }
            : { status, completedAt: null, completedBy: null, updatedAt: now, noticeAt: noticeAt(cur.dueAt, cur.remindBeforeMinutes, now) },
        )
        .where(eq(tasks.id, id))
        .returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: cur.status, newValue: status, source: 'manual' });
      if (status === 'done' && row!.recurrenceId && timeZone) next = await this.spawnNext(tx, row!, now, timeZone);
      return { row: row!, links: await this.links(tx, next ? [row!, next] : [row!]), next };
    });
    const [view] = await this.views(sc, [out.row], out.links);
    if (status !== 'done' || !out.row.recurrenceId) return view!;
    const nextView = out.next ? (await this.views(sc, [out.next], out.links))[0]! : null;
    return { ...view!, next_task: nextView };
  }

  // ── repetición (F2, ADR-58) ──────────────────────────────────────────────

  /** Crea la serie de una tarea nueva (la ocurrencia 1) y devuelve su id. */
  private async startSeries(tx: TenantTx, sc: Scope, rule: RecurrenceRule): Promise<string> {
    const [rec] = await tx.insert(taskRecurrences).values({ ...ruleColumns(rule), createdBy: sc.userId }).returning({ id: taskRecurrences.id });
    await writeAudit(tx, { entityType: AUDIT_SERIES, entityId: rec!.id, newValue: ruleAudit(rule), source: 'manual' });
    return rec!.id;
  }

  /** Termina la serie (si seguía activa) con su motivo; sin DELETE: queda como historia. */
  private async endSeries(tx: TenantTx, recurrenceId: string, reason: 'completed' | 'stopped' | 'deleted'): Promise<void> {
    const ended = await tx
      .update(taskRecurrences)
      .set({ endedAt: new Date(), endedReason: reason, updatedAt: new Date() })
      .where(and(eq(taskRecurrences.id, recurrenceId), isNull(taskRecurrences.endedAt)))
      .returning({ id: taskRecurrences.id });
    if (ended.length > 0) await writeAudit(tx, { entityType: AUDIT_SERIES, entityId: recurrenceId, field: 'ended', oldValue: false, newValue: { reason }, source: reason === 'completed' ? 'automation' : 'manual' });
  }

  /**
   * Lo que `recurrence` pide en una edición: `null` detiene la serie (la tarea actual sigue como tarea única), un objeto cambia la regla desde la siguiente o crea la serie si no había. Anota en `set` la
   * serie nueva y devuelve qué auditar. Una tarea que se repite exige vencimiento, y solo se cambia la repetición de una tarea abierta.
   */
  private async applyRecurrence(
    tx: TenantTx,
    sc: Scope,
    cur: TaskRow,
    input: RecurrenceDto | null | undefined,
    due: Date | null,
    timeZone: string | null,
    set: Partial<typeof tasks.$inferInsert>,
  ): Promise<{ id: string; field: string; value: unknown } | null> {
    const active = cur.recurrenceId ? await this.activeSeries(tx, cur.recurrenceId) : null;
    if (input === undefined) {
      if (active && due === null) throw new ValidationError([{ path: 'due_at', code: 'recurrence_requires_due', message: 'Una tarea que se repite necesita fecha de vencimiento: detén la repetición primero' }]);
      return null;
    }
    if (cur.status !== 'open') throw new ValidationError([{ path: 'recurrence', code: 'task_not_open', message: 'La repetición solo se cambia en una tarea pendiente' }]);
    if (input === null) {
      if (active) await this.endSeries(tx, active.id, 'stopped');
      return null;
    }
    if (!due || !timeZone) throw new ValidationError([{ path: 'recurrence', code: 'recurrence_requires_due', message: 'Una tarea que se repite necesita fecha de vencimiento' }]);
    const rule = resolveRule(input, due, timeZone);
    if (active) {
      await tx.update(taskRecurrences).set({ ...ruleColumns(rule), updatedAt: new Date() }).where(eq(taskRecurrences.id, active.id));
      return { id: active.id, field: 'rule', value: ruleAudit(rule) };
    }
    const id = await this.startSeries(tx, sc, rule);
    set.recurrenceId = id;
    set.occurrenceNo = 1;
    return null;
  }

  private async activeSeries(tx: TenantTx, id: string): Promise<SeriesRow | null> {
    const [rec] = await tx.select().from(taskRecurrences).where(and(eq(taskRecurrences.id, id), isNull(taskRecurrences.endedAt))).for('update').limit(1);
    return rec ?? null;
  }

  /** La siguiente ocurrencia de la tarea que se acaba de completar, en la misma transacción; termina la serie si la regla llegó a su fin. */
  private async spawnNext(tx: TenantTx, done: TaskRow, now: Date, timeZone: string): Promise<TaskRow | null> {
    const rec = done.recurrenceId ? await this.activeSeries(tx, done.recurrenceId) : null;
    if (!rec) return null;
    const dueAt = done.dueAt ? nextOccurrence(rowToRule(rec), done.dueAt, now, timeZone, rec.occurrencesCreated) : null;
    if (!dueAt) {
      await this.endSeries(tx, rec.id, 'completed');
      return null;
    }
    const [row] = await tx
      .insert(tasks)
      .values({
        title: done.title,
        description: done.description,
        dueAt,
        assigneeId: done.assigneeId,
        contactId: done.contactId,
        companyId: done.companyId,
        createdBy: done.createdBy,
        recurrenceId: rec.id,
        occurrenceNo: rec.occurrencesCreated + 1,
        remindBeforeMinutes: done.remindBeforeMinutes,
        noticeAt: noticeAt(dueAt, done.remindBeforeMinutes, now),
      })
      .returning();
    await tx.update(taskRecurrences).set({ occurrencesCreated: rec.occurrencesCreated + 1, updatedAt: now }).where(eq(taskRecurrences.id, rec.id));
    await writeAudit(tx, {
      entityType: AUDIT,
      entityId: row!.id,
      newValue: { title: row!.title, due_at: dueAt.toISOString(), assignee_id: row!.assigneeId, contact_id: row!.contactId, company_id: row!.companyId, recurrence_id: rec.id, occurrence_no: row!.occurrenceNo },
      source: 'automation',
    });
    return row!;
  }

  /** La siguiente ocurrencia ya creada de esta tarea (no borrada), si la hay. */
  private async successorOf(tx: TenantTx, cur: TaskRow): Promise<TaskRow | null> {
    if (!cur.recurrenceId || cur.occurrenceNo === null) return null;
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.recurrenceId, cur.recurrenceId), eq(tasks.occurrenceNo, cur.occurrenceNo + 1), isNull(tasks.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  /** Sin `view_all` solo las asignadas a la persona o creadas por ella. */
  private visible(sc: Scope): SQL {
    return sc.viewAll ? sql`true` : (or(eq(tasks.assigneeId, sc.userId), eq(tasks.createdBy, sc.userId)) as SQL);
  }

  private async visibleById(tx: TenantTx, sc: Scope, id: string): Promise<TaskRow> {
    const [row] = await tx.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt), this.visible(sc))).limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async lock(tx: TenantTx, sc: Scope, id: string): Promise<TaskRow> {
    const [row] = await tx.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt), this.visible(sc))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Responsable efectivo: sin `view_all` solo uno mismo; con él, una persona que pueda recibir trabajo (se consulta fuera de la transacción: identidad). */
  private async assigneeFor(sc: Scope, requested: string | undefined): Promise<string> {
    if (requested === undefined || requested === sc.userId) return sc.userId;
    if (!sc.viewAll) throw new ForbiddenError('TASK_ASSIGNEE_NOT_ALLOWED', 'Solo puedes asignarte tareas a ti');
    if (!(await this.members.canBeAssigned(requested))) throw new ValidationError([{ path: 'assignee_id', code: 'invalid_assignee', message: 'Esa persona no puede recibir tareas' }]);
    return requested;
  }

  /** El contacto debe ser visible para quien vincula y la empresa debe existir; si no, 404 uniforme. */
  private async assertLinks(tx: TenantTx, sc: Scope, contactId: string | null, companyId: string | null): Promise<void> {
    if (contactId && (await this.contactsRepo.visibleIds(tx, sc, [contactId])).length === 0) throw new NotFoundError();
    if (companyId) await this.companies.byId(tx, companyId);
  }

  /** Condición «después de este cursor» según el orden elegido. */
  private after(sort: 'due' | 'created', raw: string): SQL {
    let c: { d?: string | null; c?: string; i?: string };
    try {
      c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof c;
    } catch {
      throw BAD_CURSOR();
    }
    if (typeof c.i !== 'string' || !UUID_TEXT.test(c.i)) throw BAD_CURSOR();
    if (sort === 'created') {
      if (typeof c.c !== 'string' || !TS_TEXT.test(c.c)) throw BAD_CURSOR();
      return sql`(${tasks.createdAt}, ${tasks.id}) < (${c.c}::timestamptz, ${c.i}::uuid)`;
    }
    if (c.d === null || c.d === undefined) return sql`(${tasks.dueAt} IS NULL AND ${tasks.id} > ${c.i}::uuid)`;
    if (typeof c.d !== 'string' || !TS_TEXT.test(c.d)) throw BAD_CURSOR();
    return sql`(${tasks.dueAt} > ${c.d}::timestamptz OR (${tasks.dueAt} = ${c.d}::timestamptz AND ${tasks.id} > ${c.i}::uuid) OR ${tasks.dueAt} IS NULL)`;
  }

  /** Nombres del contacto y de la empresa vinculados (vigentes) de estas tareas. */
  private async links(tx: TenantTx, rows: readonly TaskRow[]): Promise<TaskLinks> {
    const cIds = [...new Set(rows.flatMap((r) => (r.contactId ? [r.contactId] : [])))];
    const kIds = [...new Set(rows.flatMap((r) => (r.companyId ? [r.companyId] : [])))];
    const cs = cIds.length > 0 ? await tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(inArray(contacts.id, cIds), isNull(contacts.deletedAt))) : [];
    const ks = kIds.length > 0 ? await tx.select({ id: companies.id, name: companies.name }).from(companies).where(and(inArray(companies.id, kIds), isNull(companies.deletedAt))) : [];
    const rIds = [...new Set(rows.flatMap((r) => (r.recurrenceId ? [r.recurrenceId] : [])))];
    const rs = rIds.length > 0 ? await tx.select().from(taskRecurrences).where(and(inArray(taskRecurrences.id, rIds), isNull(taskRecurrences.endedAt))) : [];
    return { contacts: new Map(cs.map((c) => [c.id, c.name])), companies: new Map(ks.map((c) => [c.id, c.name])), series: new Map(rs.map((r) => [r.id, r])) };
  }

  private async views(sc: Scope, rows: readonly TaskRow[], links: TaskLinks): Promise<TaskView[]> {
    const labels = await this.members.labels(rows.map((r) => r.assigneeId));
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      due_at: r.dueAt ? r.dueAt.toISOString() : null,
      status: r.status as 'open' | 'done',
      completed_at: r.completedAt ? r.completedAt.toISOString() : null,
      assignee: labels.get(r.assigneeId) ?? { id: r.assigneeId, name: 'Persona desconocida' },
      contact: r.contactId && links.contacts.has(r.contactId) ? { id: r.contactId, name: links.contacts.get(r.contactId)! } : null,
      company: r.companyId && links.companies.has(r.companyId) ? { id: r.companyId, name: links.companies.get(r.companyId)! } : null,
      created_by: r.createdBy,
      remind_before_minutes: r.remindBeforeMinutes,
      recurrence: r.recurrenceId && links.series.has(r.recurrenceId) ? recurrenceView(links.series.get(r.recurrenceId)!, r.occurrenceNo ?? 1) : null,
      overdue: r.status === 'open' && r.dueAt !== null && r.dueAt.getTime() < now,
      can_edit: r.createdBy === sc.userId || sc.viewAll,
      can_complete: r.assigneeId === sc.userId || r.createdBy === sc.userId || sc.viewAll,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }));
  }

  private scope(s: ContactScope): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll: s.viewAll };
  }
}

/** Lo que se carga junto a las tareas para armar sus vistas. */
interface TaskLinks {
  contacts: Map<string, string>;
  companies: Map<string, string>;
  /** Las series ACTIVAS de estas tareas. */
  series: Map<string, SeriesRow>;
}

const ruleColumns = (r: RecurrenceRule) => ({
  freq: r.freq,
  intervalN: r.interval,
  weekdays: r.weekdays ? [...r.weekdays] : null,
  dayOfMonth: r.dayOfMonth,
  endsKind: r.ends.kind,
  endsOn: r.ends.kind === 'on' ? r.ends.date : null,
  endsAfter: r.ends.kind === 'after' ? r.ends.count : null,
});

/** Lo que va a la auditoría de una regla (sin datos personales). */
const ruleAudit = (r: RecurrenceRule): Record<string, unknown> => ({ freq: r.freq, interval: r.interval, weekdays: r.weekdays, day_of_month: r.dayOfMonth, ends: r.ends });

function rowToRule(r: SeriesRow): RecurrenceRule {
  const ends: RecurrenceEnds = r.endsKind === 'on' && r.endsOn ? { kind: 'on', date: r.endsOn } : r.endsKind === 'after' && r.endsAfter ? { kind: 'after', count: r.endsAfter } : { kind: 'never' };
  return { freq: r.freq as RecurrenceRule['freq'], interval: r.intervalN, weekdays: r.weekdays, dayOfMonth: r.dayOfMonth, ends };
}

function recurrenceView(r: SeriesRow, occurrenceNo: number): RecurrenceView {
  const rule = rowToRule(r);
  return { freq: rule.freq, interval: rule.interval, weekdays: rule.weekdays ? [...rule.weekdays] : null, day_of_month: rule.dayOfMonth, ends: rule.ends, occurrence_no: occurrenceNo, occurrences_created: r.occurrencesCreated };
}
