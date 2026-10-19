import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { contactPhones, contacts, Database, opportunities, pipelines, pipelineStages, stageHistory, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { ContactsService, type ContactScope } from '../contacts';
import { OrgMembersService } from '../organizations';
import { PipelinesService } from '../pipelines';
import { SystemTagsService, type TagView } from '../tags';
import type { CreateOpportunityDto, ListOpportunitiesQuery, MoveOpportunityDto, SummaryQuery, UpdateOpportunityDto } from './opportunities.dto';

type OppRow = typeof opportunities.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;
interface Scope {
  readonly userId: string;
  readonly viewAll: boolean;
}
type Filters = Pick<ListOpportunitiesQuery, 'contact' | 'status' | 'q' | 'owner' | 'source' | 'tag' | 'min'>;

export interface OpportunityContact {
  id: string;
  name: string;
  email: string | null;
  /** Teléfono principal. */
  phone: string | null;
  source: string;
  tags: TagView[];
}
export interface OpportunityView {
  id: string;
  pipeline_id: string;
  stage_id: string;
  status: 'open' | 'won' | 'lost';
  /** Texto con 2 decimales («1500.00»): el dinero no pasa por flotantes. */
  amount: string;
  currency: string;
  owner: { id: string; name: string } | null;
  lost_reason: string | null;
  closed_at: string | null;
  stage_entered_at: string;
  created_at: string;
  contact: OpportunityContact;
}
export interface HistoryEntry {
  id: string;
  at: string;
  from_stage: { id: string; name: string } | null;
  to_stage: { id: string; name: string };
  user: { id: string; name: string } | null;
  origin: string;
}
export interface OpportunityDetail extends OpportunityView {
  history: HistoryEntry[];
}
export interface StageSummary {
  stage_id: string;
  count: number;
  total: string;
}

const AUDIT = 'opportunity';
const TS_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;
const UUID_TEXT = /^[0-9a-f-]{36}$/i;
const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const bad = (path: string, code: string, message: string): ValidationError => new ValidationError([{ path, code, message }]);

/**
 * Oportunidades (M4.2, ADR-49): un contacto en un pipeline. Con `contacts.view_all` se ven todas; sin él, solo las asignadas a la persona (404 uniforme para
 * las demás). Las reglas de la base las respaldan: una abierta por contacto y pipeline, motivo de pérdida coherente con el estado, historial solo de inserción.
 * Los permisos (`opportunities.read|write`) los exige el controlador.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contactsSvc: ContactsService,
    @Inject(PipelinesService) private readonly pipelinesSvc: PipelinesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(SystemTagsService) private readonly systemTags: SystemTagsService,
  ) {}

  /**
   * El lead cambia de manos (transferir una conversación, M5.5): las oportunidades ABIERTAS del contacto que eran de quien lo tenía —o de nadie— pasan a la nueva persona.
   * Las de otra persona, las ganadas y las perdidas no se tocan. Dentro de la transacción de quien llama; cada cambio queda auditado como acción manual. Devuelve cuántas movió.
   */
  async reassignOpenOwner(tx: TenantTx, contactId: string, from: string | null, to: string): Promise<number> {
    const rows = await tx
      .select({ id: opportunities.id, ownerId: opportunities.ownerId })
      .from(opportunities)
      .where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, 'open'), isNull(opportunities.deletedAt), from === null ? isNull(opportunities.ownerId) : or(isNull(opportunities.ownerId), eq(opportunities.ownerId, from))))
      .for('update');
    for (const r of rows) {
      if (r.ownerId === to) continue;
      await tx.update(opportunities).set({ ownerId: to, updatedAt: new Date() }).where(eq(opportunities.id, r.id));
      await writeAudit(tx, { entityType: 'opportunity', entityId: r.id, field: 'owner_id', oldValue: r.ownerId, newValue: to, source: 'manual' });
    }
    return rows.filter((r) => r.ownerId !== to).length;
  }

  async list(scope: ContactScope, q: ListOpportunitiesQuery): Promise<{ items: OpportunityView[]; next_cursor: string | null }> {
    const sc = this.scope(scope);
    const page = await this.db.withTenant(async (tx) => {
      const where = [...this.where(sc, q)];
      if (q.pipeline) where.push(eq(opportunities.pipelineId, q.pipeline));
      if (q.stage) where.push(eq(opportunities.stageId, q.stage));
      if (q.cursor) {
        const c = this.decode(q.cursor);
        where.push(sql`(${opportunities.stageEnteredAt}, ${opportunities.id}) < (${c.t}::timestamptz, ${c.i}::uuid)`);
      }
      const rows = await tx
        .select({ row: opportunities, key: sql<string>`${opportunities.stageEnteredAt}::text` })
        .from(opportunities)
        .innerJoin(contacts, and(eq(contacts.organizationId, opportunities.organizationId), eq(contacts.id, opportunities.contactId)))
        .where(and(...where))
        .orderBy(desc(opportunities.stageEnteredAt), desc(opportunities.id))
        .limit(q.limit + 1);
      const rest = rows.slice(0, q.limit);
      const last = rest.at(-1);
      return { rows: rest.map((r) => r.row), contacts: await this.contactCards(tx, rest.map((r) => r.row.contactId)), next: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ t: last.key, i: last.row.id })).toString('base64url') : null };
    });
    return { items: await this.views(page.rows, page.contacts), next_cursor: page.next };
  }

  /** Cuántas oportunidades y cuánto valen en cada etapa del pipeline, con los mismos filtros del tablero. */
  async summary(scope: ContactScope, pipelineId: string, q: SummaryQuery): Promise<{ items: StageSummary[] }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      const [p] = await tx.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.id, pipelineId), isNull(pipelines.deletedAt))).limit(1);
      if (!p) throw new NotFoundError();
      const rows = await tx
        .select({ stageId: opportunities.stageId, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${opportunities.amount}), 0)::text` })
        .from(opportunities)
        .innerJoin(contacts, and(eq(contacts.organizationId, opportunities.organizationId), eq(contacts.id, opportunities.contactId)))
        .where(and(...this.where(sc, q), eq(opportunities.pipelineId, pipelineId)))
        .groupBy(opportunities.stageId);
      return { items: rows.map((r) => ({ stage_id: r.stageId, count: r.n, total: Number(r.total).toFixed(2) })) };
    });
  }

  async get(scope: ContactScope, id: string): Promise<OpportunityDetail> {
    const sc = this.scope(scope);
    const found = await this.db.withTenant(async (tx) => {
      const row = await this.visibleById(tx, sc, id);
      return { row, contacts: await this.contactCards(tx, [row.contactId]), history: await this.history(tx, id) };
    });
    return this.detail(found.row, found.contacts, found.history);
  }

  async create(scope: ContactScope, input: CreateOpportunityDto): Promise<OpportunityDetail> {
    const sc = this.scope(scope);
    const requestedOwner = await this.ownerFor(sc, input.owner_id);
    const out = await this.db
      .withTenant(async (tx) => {
        const contact = await this.contactsSvc.visibleContactIn(tx, scope, input.contact_id);
        await this.pipelinesSvc.ensureDefault(tx);
        const pipeline = await this.pipelineFor(tx, input.pipeline_id);
        const stage = await this.openStageFor(tx, pipeline.id, input.stage_id);
        const owner = sc.viewAll ? (requestedOwner === undefined ? contact.ownerId : requestedOwner) : sc.userId;
        const [row] = await tx
          .insert(opportunities)
          .values({ pipelineId: pipeline.id, stageId: stage.id, contactId: contact.id, amount: input.amount ?? '0.00', ownerId: owner, status: 'open', createdBy: sc.userId })
          .returning();
        await tx.insert(stageHistory).values({ opportunityId: row!.id, fromStageId: null, toStageId: stage.id, userId: sc.userId, origin: 'manual' });
        await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: { contact_id: contact.id, pipeline_id: pipeline.id, stage_id: stage.id, amount: row!.amount, owner_id: owner }, source: 'manual' });
        return { row: row!, contacts: await this.contactCards(tx, [contact.id]), history: await this.history(tx, row!.id) };
      })
      .catch((e: unknown) => {
        throw this.openExists(e) ?? e;
      });
    return this.detail(out.row, out.contacts, out.history);
  }

  async update(scope: ContactScope, id: string, input: UpdateOpportunityDto): Promise<OpportunityDetail> {
    const sc = this.scope(scope);
    const owner = input.owner_id === undefined ? undefined : await this.ownerFor(sc, input.owner_id);
    const out = await this.db.withTenant(async (tx) => {
      const cur = await this.lock(tx, sc, id);
      const set: Partial<typeof opportunities.$inferInsert> = {};
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
      if (input.amount !== undefined && input.amount !== Number(cur.amount).toFixed(2)) {
        set.amount = input.amount;
        changes.push({ field: 'amount', oldValue: cur.amount, newValue: input.amount });
      }
      if (owner !== undefined && owner !== cur.ownerId) {
        set.ownerId = owner;
        changes.push({ field: 'owner_id', oldValue: cur.ownerId, newValue: owner });
      }
      const row = changes.length === 0 ? cur : (await tx.update(opportunities).set({ ...set, updatedAt: new Date() }).where(eq(opportunities.id, id)).returning())[0]!;
      for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      return { row, contacts: await this.contactCards(tx, [row.contactId]), history: await this.history(tx, id) };
    });
    return this.detail(out.row, out.contacts, out.history);
  }

  /**
   * Mueve la oportunidad a otra etapa de SU pipeline. A «perdida» exige el motivo; salir de «ganada» o «perdida» la reabre (la venta, cuando exista, no se borra).
   * Mover a la etapa donde ya está no hace nada. Una etapa oculta no recibe oportunidades.
   */
  async move(scope: ContactScope, id: string, input: MoveOpportunityDto): Promise<OpportunityDetail> {
    const sc = this.scope(scope);
    const out = await this.db
      .withTenant(async (tx) => {
        const cur = await this.lock(tx, sc, id);
        const [target] = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.id, input.stage_id), isNull(pipelineStages.deletedAt))).limit(1);
        if (!target || target.pipelineId !== cur.pipelineId) throw bad('stage_id', 'invalid_stage', 'La etapa debe ser de este pipeline');
        if (target.id === cur.stageId) return { row: cur, contacts: await this.contactCards(tx, [cur.contactId]), history: await this.history(tx, id) };
        if (target.isHidden) throw new ConflictError('STAGE_HIDDEN', 'La etapa está oculta: muéstrala para mover oportunidades a ella');
        if (target.kind === 'lost' && !input.lost_reason) throw bad('lost_reason', 'required', 'Escribe el motivo de la pérdida');
        const now = new Date();
        const kind = target.kind as 'open' | 'won' | 'lost';
        const [row] = await tx
          .update(opportunities)
          .set({ stageId: target.id, status: kind, lostReason: kind === 'lost' ? input.lost_reason! : null, closedAt: kind === 'open' ? null : now, stageEnteredAt: now, updatedAt: now })
          .where(eq(opportunities.id, id))
          .returning();
        await tx.insert(stageHistory).values({ opportunityId: id, fromStageId: cur.stageId, toStageId: target.id, userId: sc.userId, origin: 'manual' });
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'stage_id', oldValue: cur.stageId, newValue: { stage_id: target.id, status: kind }, source: 'manual' });
        return { row: row!, contacts: await this.contactCards(tx, [row!.contactId]), history: await this.history(tx, id) };
      })
      .catch((e: unknown) => {
        throw this.openExists(e) ?? e;
      });
    return this.detail(out.row, out.contacts, out.history);
  }

  /** Borrado lógico. */
  async remove(scope: ContactScope, id: string): Promise<{ id: string; deleted: true }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.lock(tx, sc, id);
      const now = new Date();
      await tx.update(opportunities).set({ deletedAt: now, updatedAt: now }).where(eq(opportunities.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: { deleted: true }, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Condiciones comunes del listado y del resumen: vigentes, alcance de la persona y filtros. */
  private where(sc: Scope, f: Filters): SQL[] {
    const w: SQL[] = [isNull(opportunities.deletedAt), isNull(contacts.deletedAt)];
    if (!sc.viewAll) w.push(eq(opportunities.ownerId, sc.userId));
    if (f.contact) w.push(eq(opportunities.contactId, f.contact));
    if (f.status) w.push(eq(opportunities.status, f.status));
    if (f.owner === 'me') w.push(eq(opportunities.ownerId, sc.userId));
    else if (f.owner === 'none') w.push(isNull(opportunities.ownerId));
    else if (f.owner) w.push(eq(opportunities.ownerId, f.owner));
    if (f.source) w.push(eq(contacts.source, f.source));
    if (f.min !== undefined) w.push(sql`${opportunities.amount} >= ${f.min}`);
    for (const t of f.tag ?? []) w.push(sql`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.organization_id = ${contacts.organizationId} AND ct.contact_id = ${contacts.id} AND ct.tag_id = ${t}::uuid)`);
    if (f.q) {
      const digits = f.q.replace(/\D/g, '');
      const phone = digits.length >= 3 ? sql` OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.organization_id = ${contacts.organizationId} AND cp.contact_id = ${contacts.id} AND cp.deleted_at IS NULL AND cp.e164 LIKE ${`%${digits}%`})` : sql``;
      w.push(sql`(${contacts.name} ILIKE ${like(f.q)} ESCAPE '\\' OR ${contacts.email} ILIKE ${like(f.q)} ESCAPE '\\'${phone})`);
    }
    return w;
  }

  private async visibleById(tx: TenantTx, sc: Scope, id: string): Promise<OppRow> {
    const [row] = await tx
      .select({ row: opportunities })
      .from(opportunities)
      .innerJoin(contacts, and(eq(contacts.organizationId, opportunities.organizationId), eq(contacts.id, opportunities.contactId)))
      .where(and(eq(opportunities.id, id), ...this.where(sc, {})))
      .limit(1);
    if (!row) throw new NotFoundError();
    return row.row;
  }

  private async lock(tx: TenantTx, sc: Scope, id: string): Promise<OppRow> {
    await this.visibleById(tx, sc, id);
    const [row] = await tx.select().from(opportunities).where(and(eq(opportunities.id, id), isNull(opportunities.deletedAt))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Responsable pedido: sin `view_all`, solo uno mismo; con él, una persona que pueda recibir trabajo (identidad: se consulta FUERA de la transacción). */
  private async ownerFor(sc: Scope, requested: string | null | undefined): Promise<string | null | undefined> {
    if (requested === undefined) return undefined;
    if (!sc.viewAll) {
      if (requested !== sc.userId) throw new ForbiddenError('OWNER_NOT_ALLOWED', 'Solo puedes asignarte oportunidades a ti');
      return requested;
    }
    if (requested !== null && !(await this.members.canBeAssigned(requested))) throw bad('owner_id', 'invalid_owner', 'Esa persona no puede recibir oportunidades');
    return requested;
  }

  private async pipelineFor(tx: TenantTx, id: string | undefined): Promise<typeof pipelines.$inferSelect> {
    const [p] = await tx
      .select()
      .from(pipelines)
      .where(and(isNull(pipelines.deletedAt), id ? eq(pipelines.id, id) : sql`true`))
      .orderBy(asc(pipelines.position), asc(pipelines.id))
      .limit(1);
    if (!p) throw id ? bad('pipeline_id', 'invalid_pipeline', 'Ese pipeline no existe') : new NotFoundError();
    return p;
  }

  /** La etapa pedida (abierta, visible y de ese pipeline) o, sin pedirla, la primera abierta visible. */
  private async openStageFor(tx: TenantTx, pipelineId: string, requested: string | undefined): Promise<StageRow> {
    const stages = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, pipelineId), isNull(pipelineStages.deletedAt))).orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
    if (requested) {
      const s = stages.find((x) => x.id === requested);
      if (!s) throw bad('stage_id', 'invalid_stage', 'La etapa debe ser de este pipeline');
      if (s.kind !== 'open') throw bad('stage_id', 'invalid_stage', 'Una oportunidad nueva empieza en una etapa abierta');
      if (s.isHidden) throw bad('stage_id', 'invalid_stage', 'La etapa está oculta');
      return s;
    }
    const first = stages.find((s) => s.kind === 'open' && !s.isHidden) ?? stages.find((s) => s.kind === 'open');
    if (!first) throw new NotFoundError();
    return first;
  }

  /** Contacto, teléfono principal, origen y etiquetas de estas oportunidades (para tarjetas y panel). */
  private async contactCards(tx: TenantTx, ids: readonly string[]): Promise<Map<string, OpportunityContact>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, OpportunityContact>();
    if (unique.length === 0) return out;
    const rows = await tx.select({ id: contacts.id, name: contacts.name, email: contacts.email, source: contacts.source }).from(contacts).where(inArray(contacts.id, unique));
    const phones = await tx
      .select({ contactId: contactPhones.contactId, e164: contactPhones.e164 })
      .from(contactPhones)
      .where(and(inArray(contactPhones.contactId, unique), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true)));
    const tags = await this.systemTags.forContacts(tx, unique);
    const phoneOf = new Map(phones.map((p) => [p.contactId, p.e164]));
    for (const r of rows) out.set(r.id, { id: r.id, name: r.name, email: r.email, phone: phoneOf.get(r.id) ?? null, source: r.source, tags: tags.get(r.id) ?? [] });
    return out;
  }

  private async history(tx: TenantTx, opportunityId: string) {
    const rows = await tx.select().from(stageHistory).where(eq(stageHistory.opportunityId, opportunityId)).orderBy(desc(stageHistory.at), desc(stageHistory.id));
    const stageIds = [...new Set(rows.flatMap((r) => (r.fromStageId ? [r.fromStageId, r.toStageId] : [r.toStageId])))];
    const names = stageIds.length > 0 ? await tx.select({ id: pipelineStages.id, name: pipelineStages.name }).from(pipelineStages).where(inArray(pipelineStages.id, stageIds)) : [];
    return { rows, names: new Map(names.map((n) => [n.id, n.name])) };
  }

  private async views(rows: readonly OppRow[], cards: Map<string, OpportunityContact>): Promise<OpportunityView[]> {
    const labels = await this.members.labels(rows.flatMap((r) => (r.ownerId ? [r.ownerId] : [])));
    return rows.map((r) => this.view(r, cards, labels));
  }

  private view(r: OppRow, cards: Map<string, OpportunityContact>, labels: Map<string, { id: string; name: string }>): OpportunityView {
    return {
      id: r.id,
      pipeline_id: r.pipelineId,
      stage_id: r.stageId,
      status: r.status as OpportunityView['status'],
      amount: Number(r.amount).toFixed(2),
      currency: r.currency,
      owner: r.ownerId ? (labels.get(r.ownerId) ?? { id: r.ownerId, name: 'Persona desconocida' }) : null,
      lost_reason: r.lostReason,
      closed_at: r.closedAt ? r.closedAt.toISOString() : null,
      stage_entered_at: r.stageEnteredAt.toISOString(),
      created_at: r.createdAt.toISOString(),
      contact: cards.get(r.contactId) ?? { id: r.contactId, name: 'Contacto', email: null, phone: null, source: 'manual', tags: [] },
    };
  }

  private async detail(row: OppRow, cards: Map<string, OpportunityContact>, h: Awaited<ReturnType<OpportunitiesService['history']>>): Promise<OpportunityDetail> {
    const labels = await this.members.labels([...(row.ownerId ? [row.ownerId] : []), ...h.rows.flatMap((r) => (r.userId ? [r.userId] : []))]);
    const stage = (id: string) => ({ id, name: h.names.get(id) ?? 'Etapa' });
    return {
      ...this.view(row, cards, labels),
      history: h.rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        from_stage: r.fromStageId ? stage(r.fromStageId) : null,
        to_stage: stage(r.toStageId),
        user: r.userId ? (labels.get(r.userId) ?? { id: r.userId, name: 'Persona desconocida' }) : null,
        origin: r.origin,
      })),
    };
  }

  private decode(raw: string): { t: string; i: string } {
    try {
      const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
      if (typeof c.t === 'string' && typeof c.i === 'string' && TS_TEXT.test(c.t) && UUID_TEXT.test(c.i)) return { t: c.t, i: c.i };
    } catch {
      /* cae al error de abajo */
    }
    throw bad('cursor', 'invalid_cursor', 'El cursor no es válido');
  }

  private openExists(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'opportunities_one_open_uq' ? new ConflictError('OPPORTUNITY_OPEN_EXISTS', 'Este contacto ya tiene una oportunidad abierta en ese pipeline') : undefined;
  }

  private scope(s: ContactScope): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll: s.viewAll };
  }
}
