import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { channelAccounts, conversations, Database, queueMembers, queues, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService, type OrgPerson } from '../organizations';
import { isOpenAt, SlaConfigService, SlaService, type HoursDto, type WeekView } from '../sla';
import { AssignmentService } from './assignment.service';
import { simulate as runSimulation, type DistMode } from './distribution';
import { DistributionService, OPEN_STATUSES } from './distribution.service';
import { startOfLocalDay } from './local-day';
import { MAX_QUEUES, type CreateQueueDto, type SetMembersDto, type SimulateDto, type UpdateQueueDto } from './queues.dto';
import type { AssignmentContext } from './queues.types';

export interface QueueMemberView {
  user_id: string;
  name: string;
  role: string;
  active: boolean;
  weight: number;
  /** Conversaciones abiertas que atiende ahora. */
  open_count: number;
  /** Conversaciones que recibió hoy de esta cola. */
  today_count: number;
}

export interface QueueView {
  id: string;
  name: string;
  color: string;
  distribution_on: boolean;
  mode: DistMode;
  batch: number;
  daily_cap: number;
  only_unassigned: boolean;
  /** No repartir automáticamente mientras la cola está cerrada: el lead espera y se reparte al abrir (M5.5b). */
  respect_hours: boolean;
  /** Minutos de tiempo abierto sin respuesta humana tras los que se reasigna (0 = no reasignar). */
  reassign_minutes: number;
  /** Veces como máximo que se reasigna una misma conversación. */
  max_rotations: number;
  /** Saludo que se envía al cliente al abrir una conversación nueva (M5.5c); null = no se envía. */
  greeting: string | null;
  /** Aviso que se envía al cliente que escribe con la cola cerrada (M5.5c); null = no se envía. */
  out_of_hours_message: string | null;
  /** Horas sin mensajes tras la última respuesta después de las cuales se finaliza sola una conversación «esperando al cliente» (0 = no finalizar). */
  auto_close_hours: number;
  /** Horario propio de la cola; null = usa el de la empresa. */
  hours: WeekView | null;
  /** ¿La cola está abierta ahora (con su horario o el de la empresa, y los feriados)? */
  open_now: boolean;
  /** Todas las personas que pueden recibir trabajo, con su estado en ESTA cola (`active: false` y peso 1 si no participan). */
  members: QueueMemberView[];
  /** Conexiones cuya cola por defecto es esta (se cambia en «Conexiones»). */
  channels: Array<{ id: string; name: string }>;
  /** Conversaciones sin asignar que le corresponden. */
  unassigned_count: number;
  created_at: string;
  updated_at: string;
}

export interface QueueList {
  items: QueueView[];
  limits: { max_queues: number };
}

export interface SimulationView {
  sequence: Array<{ user_id: string; name: string }>;
  counts: Array<{ user_id: string; name: string; count: number }>;
  /** El reparto se detuvo antes de llegar al total (nadie podía recibir más por el tope diario, o no hay asesores). */
  stopped_early: boolean;
}

type QueueRow = typeof queues.$inferSelect;
const AUDIT = 'queue';
const DEFAULT_SIMULATION = 20;

const view = (q: QueueRow, members: QueueMemberView[], channels: QueueView['channels'], unassigned: number, hours: WeekView | null, openNow: boolean): QueueView => ({
  id: q.id,
  name: q.name,
  color: q.color,
  distribution_on: q.distributionOn,
  mode: q.mode as DistMode,
  batch: q.batch,
  daily_cap: q.dailyCap,
  only_unassigned: q.onlyUnassigned,
  respect_hours: q.respectHours,
  reassign_minutes: q.reassignMinutes,
  max_rotations: q.maxRotations,
  greeting: q.greetingText,
  out_of_hours_message: q.outOfHoursText,
  auto_close_hours: q.autoCloseHours,
  hours,
  open_now: openNow,
  members,
  channels,
  unassigned_count: unassigned,
  created_at: q.createdAt.toISOString(),
  updated_at: q.updatedAt.toISOString(),
});

/**
 * Colas y reparto de una empresa (M5.3, ADR-07). Solo `queues.manage` (lo exige el controlador). Las personas salen de la IDENTIDAD (se leen antes de abrir la
 * transacción); todo lo demás es de negocio y va con RLS. Una cola se archiva (borrado lógico) y no puede archivarse mientras una conexión la use.
 */
@Injectable()
export class QueuesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(DistributionService) private readonly distribution: DistributionService,
    @Inject(AssignmentService) private readonly assignment: AssignmentService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(SlaConfigService) private readonly slaConfig: SlaConfigService,
  ) {}

  async list(): Promise<QueueList> {
    return { items: await this.load(), limits: { max_queues: MAX_QUEUES } };
  }

  async create(input: CreateQueueDto): Promise<QueueView> {
    const id = await this.db
      .withTenant(async (tx) => {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(queues).where(isNull(queues.deletedAt));
        if ((n?.n ?? 0) >= MAX_QUEUES) throw new ConflictError('QUEUE_LIMIT', `Se alcanzó el máximo de ${MAX_QUEUES} departamentos. Archiva alguno para crear otro`);
        const [q] = await tx
          .insert(queues)
          .values({ name: input.name, ...(input.color ? { color: input.color } : {}), createdBy: TenantContext.current().userId ?? null })
          .returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: q!.id, newValue: { name: q!.name, color: q!.color }, source: 'manual' });
        return q!.id;
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return this.one(id);
  }

  async update(id: string, input: UpdateQueueDto): Promise<QueueView> {
    await this.db
      .withTenant(async (tx) => {
        const q = await this.mustGet(tx, id, true);
        const set: Partial<typeof queues.$inferInsert> = {};
        const audits: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const change = <K extends keyof UpdateQueueDto>(key: K, col: keyof typeof queues.$inferInsert, cur: unknown, next: UpdateQueueDto[K] | undefined) => {
          if (next === undefined || next === cur) return;
          (set as Record<string, unknown>)[col] = next;
          audits.push({ field: key, oldValue: cur, newValue: next });
        };
        change('name', 'name', q.name, input.name);
        change('color', 'color', q.color, input.color);
        change('distribution_on', 'distributionOn', q.distributionOn, input.distribution_on);
        change('mode', 'mode', q.mode, input.mode);
        change('batch', 'batch', q.batch, input.batch);
        change('daily_cap', 'dailyCap', q.dailyCap, input.daily_cap);
        change('only_unassigned', 'onlyUnassigned', q.onlyUnassigned, input.only_unassigned);
        change('respect_hours', 'respectHours', q.respectHours, input.respect_hours);
        change('reassign_minutes', 'reassignMinutes', q.reassignMinutes, input.reassign_minutes);
        change('max_rotations', 'maxRotations', q.maxRotations, input.max_rotations);
        change('greeting', 'greetingText', q.greetingText, input.greeting);
        change('out_of_hours_message', 'outOfHoursText', q.outOfHoursText, input.out_of_hours_message);
        change('auto_close_hours', 'autoCloseHours', q.autoCloseHours, input.auto_close_hours);
        if (audits.length === 0) return;
        set.updatedAt = new Date();
        await tx.update(queues).set(set).where(eq(queues.id, id));
        for (const a of audits) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: a.field, oldValue: a.oldValue, newValue: a.newValue, source: 'manual' });
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return this.one(id);
  }

  /** Horario propio de la cola (`days: null` = vuelve a usar el de la empresa). */
  async setHours(id: string, input: HoursDto): Promise<QueueView> {
    await this.slaConfig.setQueueHours(id, input);
    return this.one(id);
  }

  /** Quién participa en la cola y con qué peso. Solo personas que pueden recibir trabajo. Quien tenía fila y no aparece queda apagado. */
  async setMembers(id: string, input: SetMembersDto): Promise<QueueView> {
    const people = await this.members.assignable();
    const ok = new Set(people.map((p) => p.id));
    const bad = input.members.findIndex((m) => !ok.has(m.user_id));
    if (bad >= 0) throw new ValidationError([{ path: `members.${bad}.user_id`, code: 'invalid_member', message: 'Esa persona no puede recibir conversaciones en esta empresa' }]);
    await this.db.withTenant(async (tx) => {
      await this.mustGet(tx, id, true);
      const rows = await tx.select().from(queueMembers).where(eq(queueMembers.queueId, id));
      const byUser = new Map(rows.map((r) => [r.userId, r]));
      const listed = new Set(input.members.map((m) => m.user_id));
      const changes: Array<{ user_id: string; active: boolean; weight: number; was: { active: boolean; weight: number } | null }> = [];
      const now = new Date();
      for (const m of input.members) {
        const cur = byUser.get(m.user_id);
        if (cur && cur.active === m.active && cur.weight === m.weight) continue;
        await tx
          .insert(queueMembers)
          .values({ queueId: id, userId: m.user_id, active: m.active, weight: m.weight })
          .onConflictDoUpdate({ target: [queueMembers.organizationId, queueMembers.queueId, queueMembers.userId], set: { active: m.active, weight: m.weight, updatedAt: now } });
        changes.push({ user_id: m.user_id, active: m.active, weight: m.weight, was: cur ? { active: cur.active, weight: cur.weight } : null });
      }
      for (const r of rows) {
        if (listed.has(r.userId) || !r.active) continue;
        await tx.update(queueMembers).set({ active: false, updatedAt: now }).where(and(eq(queueMembers.queueId, id), eq(queueMembers.userId, r.userId)));
        changes.push({ user_id: r.userId, active: false, weight: r.weight, was: { active: true, weight: r.weight } });
      }
      if (changes.length === 0) return;
      await tx.update(queues).set({ updatedAt: now }).where(eq(queues.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'members', oldValue: changes.map((c) => ({ user_id: c.user_id, ...(c.was ?? { active: false, weight: 1 }) })), newValue: changes.map((c) => ({ user_id: c.user_id, active: c.active, weight: c.weight })), source: 'manual' });
    });
    return this.one(id);
  }

  /** Archiva la cola (borrado lógico). No se puede mientras una conexión la use como cola por defecto. */
  async archive(id: string): Promise<{ id: string; archived: true }> {
    await this.db.withTenant(async (tx) => {
      await this.mustGet(tx, id, true);
      const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(channelAccounts).where(and(eq(channelAccounts.queueId, id), isNull(channelAccounts.deletedAt)));
      if ((used?.n ?? 0) > 0) throw new ConflictError('QUEUE_IN_USE', 'Hay conexiones que usan este departamento. Cámbialas de departamento en «Conexiones» antes de archivarlo');
      const now = new Date();
      await tx.update(queues).set({ deletedAt: now, updatedAt: now }).where(eq(queues.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'archived', oldValue: false, newValue: true, source: 'manual' });
    });
    return { id, archived: true };
  }

  /**
   * Simula el reparto sin guardar nada: parte de cero y suma cada asignación a la carga y al tope del día, como pasaría de verdad. Por omisión usa lo guardado;
   * lo que se mande lo sustituye (probar antes de guardar). Con «carga» el orden real depende de las conversaciones abiertas de ese momento.
   */
  async simulate(id: string, input: SimulateDto): Promise<SimulationView> {
    const people = await this.members.assignable();
    const dir = await this.directory.current({ fresh: true });
    const ctx: AssignmentContext = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    const names = new Map(people.map((p) => [p.id, p.name]));
    const count = input.count ?? DEFAULT_SIMULATION;
    const out = await this.db.withTenant(async (tx) => {
      const q = await this.mustGet(tx, id);
      const rules = { mode: (input.mode ?? q.mode) as DistMode, batch: input.batch ?? q.batch, dailyCap: input.daily_cap ?? q.dailyCap };
      const override = input.members?.filter((m) => m.active).map((m) => ({ userId: m.user_id, weight: m.weight }));
      const candidates = await this.distribution.candidates(tx, id, ctx, rules, override);
      return runSimulation(candidates, rules, count);
    });
    return {
      sequence: out.sequence.map((u) => ({ user_id: u, name: names.get(u) ?? 'Persona' })),
      counts: Object.entries(out.counts).map(([u, n]) => ({ user_id: u, name: names.get(u) ?? 'Persona', count: n })),
      stopped_early: out.sequence.length < count,
    };
  }

  /**
   * Reparte AHORA las conversaciones «sin asignar» de la cola (las que llegaron cuando el reparto estaba apagado, no había asesores o la conexión aún no tenía
   * cola). Es una acción explícita: encender el reparto no reasigna por sorpresa chats antiguos. Se detiene cuando nadie puede recibir más.
   */
  async distributeUnassigned(id: string): Promise<{ assigned: number; remaining: number }> {
    const dir = await this.directory.current({ fresh: true });
    const ctx: AssignmentContext = { now: new Date(), timeZone: dir.timeZone, assignable: dir.assignable };
    return this.db.withTenant(async (tx) => {
      const q = await this.mustGet(tx, id);
      if (!q.distributionOn) throw new ConflictError('QUEUE_DISTRIBUTION_OFF', 'El reparto de este departamento está apagado. Enciéndelo para repartir');
      const assigned = await this.distributeWithin(tx, id, ctx, 500);
      return { assigned, remaining: (await this.unassignedOf(tx, id, 100_000)).length };
    });
  }

  /**
   * Reparte las «sin asignar» de UNA cola dentro de la transacción de quien llama (hasta `limit`, las más antiguas primero) y devuelve cuántas asignó. Se detiene cuando nadie
   * puede recibir más (o, con «respetar el horario», mientras la cola está cerrada). La usan «Repartir ahora» y la tarea que atiende lo que esperó a que la cola abriera.
   */
  async distributeWithin(tx: TenantTx, queueId: string, ctx: AssignmentContext, limit = 500): Promise<number> {
    let assigned = 0;
    for (const convId of await this.unassignedOf(tx, queueId, limit)) {
      const r = await this.assignment.assignConversation(tx, convId, ctx);
      if (!r.assigned) break;
      assigned += 1;
    }
    return assigned;
  }

  // ── lectura ────────────────────────────────────────────────────────────────

  private async one(id: string): Promise<QueueView> {
    const [q] = await this.load([id]);
    if (!q) throw new NotFoundError();
    return q;
  }

  /** Las colas (todas o las indicadas) con sus asesores, conexiones y cifras. Las personas se leen ANTES de la transacción (identidad). */
  private async load(only?: readonly string[]): Promise<QueueView[]> {
    const people = await this.members.assignable();
    const dir = await this.directory.current({ fresh: true });
    const now = new Date();
    const since = startOfLocalDay(now, dir.timeZone);
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(queues)
        .where(and(isNull(queues.deletedAt), ...(only ? [inArray(queues.id, [...only])] : [])))
        .orderBy(asc(queues.createdAt), asc(queues.id));
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const memberRows = await tx.select().from(queueMembers).where(inArray(queueMembers.queueId, ids));
      const chans = await tx.select({ id: channelAccounts.id, name: channelAccounts.name, queueId: channelAccounts.queueId }).from(channelAccounts).where(and(inArray(channelAccounts.queueId, ids), isNull(channelAccounts.deletedAt))).orderBy(asc(channelAccounts.createdAt));
      const personIds = people.map((p) => p.id);
      const ownHours = await this.slaConfig.queueHours(tx, ids);
      const cals = await this.sla.calendars(tx, dir.timeZone);

      const unassigned = new Map<string, number>();
      const pendingRows = await tx.execute<{ qid: string; n: number }>(sql`
        SELECT coalesce(c.queue_id, ch.queue_id) AS qid, count(*)::int AS n
          FROM conversations c JOIN channel_accounts ch ON ch.organization_id = c.organization_id AND ch.id = c.channel_account_id
         WHERE c.status = 'unassigned' AND coalesce(c.queue_id, ch.queue_id) IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         GROUP BY 1`);
      for (const r of pendingRows.rows) unassigned.set(r.qid, r.n);

      const today = new Map<string, number>(); // `${queue}|${user}` → recibidas hoy
      const open = new Map<string, number>();
      if (personIds.length > 0) {
        const t = await tx
          .select({ q: conversations.queueId, u: conversations.ownerId, n: sql<number>`count(*)::int` })
          .from(conversations)
          .where(and(inArray(conversations.queueId, ids), inArray(conversations.ownerId, personIds), eq(conversations.assignmentSource, 'distribution'), gte(conversations.assignedAt, since)))
          .groupBy(conversations.queueId, conversations.ownerId);
        for (const r of t) if (r.q && r.u) today.set(`${r.q}|${r.u}`, r.n);
        const o = await tx
          .select({ u: conversations.ownerId, n: sql<number>`count(*)::int` })
          .from(conversations)
          .where(and(inArray(conversations.ownerId, personIds), inArray(conversations.status, [...OPEN_STATUSES])))
          .groupBy(conversations.ownerId);
        for (const r of o) if (r.u) open.set(r.u, r.n);
      }

      return rows.map((q) => {
        const mine = new Map(memberRows.filter((m) => m.queueId === q.id).map((m) => [m.userId, m]));
        const members: QueueMemberView[] = people.map((p: OrgPerson) => {
          const m = mine.get(p.id);
          return { user_id: p.id, name: p.name, role: p.role, active: m?.active ?? false, weight: m?.weight ?? 1, open_count: open.get(p.id) ?? 0, today_count: today.get(`${q.id}|${p.id}`) ?? 0 };
        });
        return view(q, members, chans.filter((c) => c.queueId === q.id).map((c) => ({ id: c.id, name: c.name })), unassigned.get(q.id) ?? 0, ownHours.get(q.id) ?? null, isOpenAt(cals.forQueue(q.id), now));
      });
    });
  }

  /** Conversaciones «sin asignar» que le corresponden a la cola (la suya o, si aún no la tienen, la de su conexión), las más antiguas primero. */
  private async unassignedOf(tx: TenantTx, queueId: string, limit: number): Promise<string[]> {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT c.id FROM conversations c JOIN channel_accounts ch ON ch.organization_id = c.organization_id AND ch.id = c.channel_account_id
       WHERE c.status = 'unassigned' AND coalesce(c.queue_id, ch.queue_id) = ${queueId}::uuid
       ORDER BY coalesce(c.last_inbound_at, c.created_at), c.id LIMIT ${limit}`);
    return rows.rows.map((r) => r.id);
  }

  private async mustGet(tx: TenantTx, id: string, lock = false): Promise<QueueRow> {
    const q = tx.select().from(queues).where(and(eq(queues.id, id), isNull(queues.deletedAt))).limit(1);
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new NotFoundError();
    return row;
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'queues_org_name_uq' ? new ConflictError('QUEUE_EXISTS', 'Ya existe un departamento con ese nombre') : undefined;
  }
}
