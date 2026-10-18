import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { companies, contacts, Database, tasks, type TenantTx } from '../../db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgMembersService } from '../organizations';
import { CompaniesService } from './companies.service';
import type { CreateTaskDto, ListTasksQuery, UpdateTaskDto } from './crm-extras.dto';
import { ContactsRepository, type Scope } from './contacts.repository';
import type { ContactScope } from './contacts.service';

type TaskRow = typeof tasks.$inferSelect;

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
const BAD_CURSOR = (): ValidationError => new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
const TS_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;
const UUID_TEXT = /^[0-9a-f-]{36}$/i;

/**
 * Tareas del CRM (M3.6, ADR-48): pendiente de una persona con vencimiento opcional, vinculada a lo sumo a un contacto o una empresa. Con `contacts.view_all` se
 * ven todas; sin él, las asignadas a la persona o creadas por ella. Sin recordatorios ni repetición (llegan con la Agenda).
 */
@Injectable()
export class TasksService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsRepository) private readonly contactsRepo: ContactsRepository,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
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
    const out = await this.db.withTenant(async (tx) => {
      await this.assertLinks(tx, sc, input.contact_id ?? null, input.company_id ?? null);
      const [row] = await tx
        .insert(tasks)
        .values({ title: input.title, description: input.description ?? null, dueAt: input.due_at ?? null, assigneeId: assignee, contactId: input.contact_id ?? null, companyId: input.company_id ?? null, createdBy: sc.userId })
        .returning();
      await writeAudit(tx, {
        entityType: AUDIT,
        entityId: row!.id,
        newValue: { title: row!.title, due_at: row!.dueAt?.toISOString() ?? null, assignee_id: assignee, contact_id: row!.contactId, company_id: row!.companyId, has_description: row!.description !== null },
        source: 'manual',
      });
      return { row: row!, links: await this.links(tx, [row!]) };
    });
    return (await this.views(sc, [out.row], out.links))[0]!;
  }

  async update(scope: ContactScope, id: string, input: UpdateTaskDto): Promise<TaskView> {
    const sc = this.scope(scope);
    const assignee = input.assignee_id === undefined ? undefined : await this.assigneeFor(sc, input.assignee_id);
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
      const row = changes.length === 0 ? cur : (await tx.update(tasks).set({ ...set, updatedAt: new Date() }).where(eq(tasks.id, id)).returning())[0]!;
      for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      return { row, links: await this.links(tx, [row]) };
    });
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
      await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async setStatus(scope: ContactScope, id: string, status: 'open' | 'done'): Promise<TaskView> {
    const sc = this.scope(scope);
    const out = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, sc, id);
      if (cur.assigneeId !== sc.userId && cur.createdBy !== sc.userId && !sc.viewAll) throw new ForbiddenError('TASK_NOT_YOURS', 'Solo su responsable o quien la creó puede completarla');
      if (cur.status === status) return { row: cur, links: await this.links(tx, [cur]) };
      const now = new Date();
      const [row] = await tx
        .update(tasks)
        .set(status === 'done' ? { status, completedAt: now, completedBy: sc.userId, updatedAt: now } : { status, completedAt: null, completedBy: null, updatedAt: now })
        .where(eq(tasks.id, id))
        .returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: cur.status, newValue: status, source: 'manual' });
      return { row: row!, links: await this.links(tx, [row!]) };
    });
    return (await this.views(sc, [out.row], out.links))[0]!;
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
  private async links(tx: TenantTx, rows: readonly TaskRow[]): Promise<{ contacts: Map<string, string>; companies: Map<string, string> }> {
    const cIds = [...new Set(rows.flatMap((r) => (r.contactId ? [r.contactId] : [])))];
    const kIds = [...new Set(rows.flatMap((r) => (r.companyId ? [r.companyId] : [])))];
    const cs = cIds.length > 0 ? await tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(inArray(contacts.id, cIds), isNull(contacts.deletedAt))) : [];
    const ks = kIds.length > 0 ? await tx.select({ id: companies.id, name: companies.name }).from(companies).where(and(inArray(companies.id, kIds), isNull(companies.deletedAt))) : [];
    return { contacts: new Map(cs.map((c) => [c.id, c.name])), companies: new Map(ks.map((c) => [c.id, c.name])) };
  }

  private async views(sc: Scope, rows: readonly TaskRow[], links: { contacts: Map<string, string>; companies: Map<string, string> }): Promise<TaskView[]> {
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
