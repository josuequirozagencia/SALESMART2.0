import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { companies, contactCompanies, contacts, Database, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { MAX_COMPANIES_PER_CONTACT, type CompanyContactsQuery, type CreateCompanyDto, type ListCompaniesQuery, type UpdateCompanyDto } from './crm-extras.dto';
import { ContactsRepository, type Scope } from './contacts.repository';
import type { ContactScope } from './contacts.service';

type CompanyRow = typeof companies.$inferSelect;

export interface CompanyView {
  id: string;
  name: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  /** Contactos vinculados que ESTA persona puede ver (el alcance del ADR-43 manda). */
  contact_count: number;
  created_at: string;
  updated_at: string;
}
export interface CompanyContactView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

const AUDIT = 'company';
const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const encode = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
function decode<T>(raw: string): T {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T;
  } catch {
    throw new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
  }
}

/** Resultado de un intento de vincular: quién entró y por qué no entraron los demás. */
export interface LinkOutcome {
  added: string[];
  already: string[];
  limited: string[];
  hidden: string[];
}

/**
 * Empresas del CRM (M3.6, ADR-48). Compartidas por toda la organización; lo que SÍ depende de la persona son los contactos que ve de cada una (ADR-43).
 * Los permisos los exige el controlador (`contacts.read|write|delete`); aquí se aplica el alcance, la unicidad del nombre y el tope de empresas por contacto.
 */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsRepository) private readonly contactsRepo: ContactsRepository,
  ) {}

  async list(scope: ContactScope, q: ListCompaniesQuery): Promise<{ items: CompanyView[]; next_cursor: string | null }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      const where = [isNull(companies.deletedAt)];
      if (q.q) where.push(sql`${companies.name} ILIKE ${like(q.q)} ESCAPE '\\'`);
      if (q.cursor) {
        const c = decode<{ n: string; i: string }>(q.cursor);
        if (typeof c.n !== 'string' || typeof c.i !== 'string') throw new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
        where.push(sql`(lower(${companies.name}), ${companies.id}) > (${c.n}, ${c.i}::uuid)`);
      }
      const rows = await tx.select().from(companies).where(and(...where)).orderBy(sql`lower(${companies.name})`, asc(companies.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const counts = await this.counts(tx, sc, page.map((r) => r.id));
      return { items: page.map((r) => this.view(r, counts.get(r.id) ?? 0)), next_cursor: rows.length > q.limit && last ? encode({ n: last.name.toLowerCase(), i: last.id }) : null };
    });
  }

  async get(scope: ContactScope, id: string): Promise<CompanyView> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      const row = await this.byId(tx, id);
      return this.view(row, (await this.counts(tx, sc, [id])).get(id) ?? 0);
    });
  }

  async create(scope: ContactScope, input: CreateCompanyDto): Promise<CompanyView> {
    const sc = this.scope(scope);
    return this.db
      .withTenant(async (tx) => {
        const [row] = await tx
          .insert(companies)
          .values({ name: input.name, website: input.website ?? null, phone: input.phone ?? null, email: input.email ?? null, createdBy: sc.userId })
          .returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: { name: row!.name, website: row!.website, phone: row!.phone, email: row!.email }, source: 'manual' });
        return this.view(row!, 0);
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
  }

  async update(scope: ContactScope, id: string, input: UpdateCompanyDto): Promise<CompanyView> {
    const sc = this.scope(scope);
    return this.db
      .withTenant(async (tx) => {
        const [cur] = await tx.select().from(companies).where(and(eq(companies.id, id), isNull(companies.deletedAt))).for('update').limit(1);
        if (!cur) throw new NotFoundError();
        const set: Partial<typeof companies.$inferInsert> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const consider = <K extends 'name' | 'website' | 'phone' | 'email'>(k: K, v: string | null | undefined): void => {
          if (v === undefined || v === cur[k]) return;
          set[k] = v as never;
          changes.push({ field: k, oldValue: cur[k], newValue: v });
        };
        consider('name', input.name);
        consider('website', input.website);
        consider('phone', input.phone);
        consider('email', input.email);
        const row = changes.length === 0 ? cur : (await tx.update(companies).set({ ...set, updatedAt: new Date() }).where(eq(companies.id, id)).returning())[0]!;
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return this.view(row, (await this.counts(tx, sc, [id])).get(id) ?? 0);
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
  }

  /** Borrado lógico: el nombre queda libre y las notas y tareas de la empresa dejan de ser accesibles. Los vínculos se conservan (se ocultan). */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    return this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(companies).where(and(eq(companies.id, id), isNull(companies.deletedAt))).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      await tx.update(companies).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(companies.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  /** Contactos de la empresa que esta persona puede ver, por nombre. */
  async contactsOf(scope: ContactScope, id: string, q: CompanyContactsQuery): Promise<{ items: CompanyContactView[]; next_cursor: string | null }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, id);
      const where = [eq(contactCompanies.companyId, id), this.contactsRepo.visible(sc)];
      if (q.cursor) {
        const c = decode<{ n: string; i: string }>(q.cursor);
        if (typeof c.n !== 'string' || typeof c.i !== 'string') throw new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
        where.push(sql`(lower(${contacts.name}), ${contacts.id}) > (${c.n}, ${c.i}::uuid)`);
      }
      const rows = await tx
        .select({ id: contacts.id, name: contacts.name, email: contacts.email })
        .from(contactCompanies)
        .innerJoin(contacts, and(eq(contacts.organizationId, contactCompanies.organizationId), eq(contacts.id, contactCompanies.contactId)))
        .where(and(...where))
        .orderBy(sql`lower(${contacts.name})`, asc(contacts.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const phones = await this.contactsRepo.phonesOf(tx, page.map((r) => r.id));
      const last = page.at(-1);
      return {
        items: page.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: phones.get(r.id)?.[0]?.e164 ?? null })),
        next_cursor: rows.length > q.limit && last ? encode({ n: last.name.toLowerCase(), i: last.id }) : null,
      };
    });
  }

  /** Vincula contactos a una empresa. Los que la persona no ve, los que ya estaban y los que llegaron al tope no entran (sin error: se informa cuántos). */
  async link(scope: ContactScope, id: string, contactIds: readonly string[]): Promise<{ added: number; skipped: number }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, id);
      const out = await this.linkIn(tx, sc, id, contactIds);
      return { added: out.added.length, skipped: contactIds.length - out.added.length };
    });
  }

  /** Vincula UN contacto (desde su ficha): si no lo ve, 404; si ya llegó al tope, 409. Vincular dos veces es inocuo. */
  async linkOne(scope: ContactScope, contactId: string, companyId: string): Promise<{ linked: true }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, companyId);
      const out = await this.linkIn(tx, sc, companyId, [contactId]);
      if (out.hidden.length > 0) throw new NotFoundError();
      if (out.limited.length > 0) throw new ConflictError('COMPANY_LIMIT', `Un contacto puede pertenecer a ${MAX_COMPANIES_PER_CONTACT} empresas como máximo`);
      return { linked: true as const };
    });
  }

  async unlink(scope: ContactScope, id: string, contactIds: readonly string[]): Promise<{ removed: number }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, id);
      return { removed: (await this.unlinkIn(tx, sc, id, contactIds)).length };
    });
  }

  async unlinkOne(scope: ContactScope, contactId: string, companyId: string): Promise<{ unlinked: true }> {
    const sc = this.scope(scope);
    return this.db.withTenant(async (tx) => {
      await this.byId(tx, companyId);
      if ((await this.contactsRepo.visibleIds(tx, sc, [contactId])).length === 0) throw new NotFoundError();
      await this.unlinkIn(tx, sc, companyId, [contactId]);
      return { unlinked: true as const };
    });
  }

  /** Empresas vigentes de estos contactos, para mostrarlas en su ficha. Sin alcance propio: el que llama ya filtró los contactos. */
  async forContacts(tx: TenantTx, contactIds: readonly string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const out = new Map<string, Array<{ id: string; name: string }>>();
    if (contactIds.length === 0) return out;
    const rows = await tx
      .select({ contactId: contactCompanies.contactId, id: companies.id, name: companies.name })
      .from(contactCompanies)
      .innerJoin(companies, and(eq(companies.organizationId, contactCompanies.organizationId), eq(companies.id, contactCompanies.companyId)))
      .where(and(inArray(contactCompanies.contactId, [...contactIds]), isNull(companies.deletedAt)))
      .orderBy(sql`lower(${companies.name})`, asc(companies.id));
    for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), { id: r.id, name: r.name }]);
    return out;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async linkIn(tx: TenantTx, sc: Scope, companyId: string, contactIds: readonly string[]): Promise<LinkOutcome> {
    const visible = new Set(await this.contactsRepo.visibleIds(tx, sc, contactIds));
    const out: LinkOutcome = { added: [], already: [], limited: [], hidden: contactIds.filter((c) => !visible.has(c)) };
    if (visible.size === 0) return out;
    const have = await tx.select({ contactId: contactCompanies.contactId }).from(contactCompanies).where(and(eq(contactCompanies.companyId, companyId), inArray(contactCompanies.contactId, [...visible])));
    const linked = new Set(have.map((r) => r.contactId));
    out.already = [...visible].filter((c) => linked.has(c));
    const todo = [...visible].filter((c) => !linked.has(c));
    if (todo.length === 0) return out;
    const counts = await tx
      .select({ contactId: contactCompanies.contactId, n: sql<number>`count(*)::int` })
      .from(contactCompanies)
      .innerJoin(companies, and(eq(companies.organizationId, contactCompanies.organizationId), eq(companies.id, contactCompanies.companyId)))
      .where(and(inArray(contactCompanies.contactId, todo), isNull(companies.deletedAt)))
      .groupBy(contactCompanies.contactId);
    const full = new Set(counts.filter((r) => r.n >= MAX_COMPANIES_PER_CONTACT).map((r) => r.contactId));
    out.limited = todo.filter((c) => full.has(c));
    out.added = todo.filter((c) => !full.has(c));
    if (out.added.length === 0) return out;
    await tx.insert(contactCompanies).values(out.added.map((contactId) => ({ contactId, companyId, addedBy: sc.userId }))).onConflictDoNothing();
    await writeAudit(tx, { entityType: AUDIT, entityId: companyId, field: 'contacts_linked', newValue: { count: out.added.length, contact_ids: out.added }, source: 'manual' });
    for (const contactId of out.added) await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'company_linked', newValue: { company_id: companyId }, source: 'manual' });
    return out;
  }

  private async unlinkIn(tx: TenantTx, sc: Scope, companyId: string, contactIds: readonly string[]): Promise<string[]> {
    const visible = await this.contactsRepo.visibleIds(tx, sc, contactIds);
    if (visible.length === 0) return [];
    const gone = await tx.delete(contactCompanies).where(and(eq(contactCompanies.companyId, companyId), inArray(contactCompanies.contactId, visible))).returning({ contactId: contactCompanies.contactId });
    const ids = gone.map((r) => r.contactId);
    if (ids.length === 0) return [];
    await writeAudit(tx, { entityType: AUDIT, entityId: companyId, field: 'contacts_unlinked', newValue: { count: ids.length, contact_ids: ids }, source: 'manual' });
    for (const contactId of ids) await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'company_unlinked', newValue: { company_id: companyId }, source: 'manual' });
    return ids;
  }

  /** Contactos vinculados que este alcance puede ver, por empresa. */
  private async counts(tx: TenantTx, sc: Scope, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ companyId: contactCompanies.companyId, n: sql<number>`count(*)::int` })
      .from(contactCompanies)
      .innerJoin(contacts, and(eq(contacts.organizationId, contactCompanies.organizationId), eq(contacts.id, contactCompanies.contactId)))
      .where(and(inArray(contactCompanies.companyId, [...ids]), this.contactsRepo.visible(sc)))
      .groupBy(contactCompanies.companyId);
    return new Map(rows.map((r) => [r.companyId, r.n]));
  }

  /** La empresa vigente; 404 si no existe (o es de otra organización: la RLS ya la hizo invisible). */
  async byId(tx: TenantTx, id: string): Promise<CompanyRow> {
    const [row] = await tx.select().from(companies).where(and(eq(companies.id, id), isNull(companies.deletedAt))).limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  private view(r: CompanyRow, contactCount: number): CompanyView {
    return { id: r.id, name: r.name, website: r.website, phone: r.phone, email: r.email, contact_count: contactCount, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString() };
  }

  private scope(s: ContactScope): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll: s.viewAll };
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'companies_org_name_uq' ? new ConflictError('COMPANY_EXISTS', 'Ya existe una empresa con ese nombre') : undefined;
  }
}
