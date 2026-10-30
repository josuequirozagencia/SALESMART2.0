import { Injectable } from '@nestjs/common';
import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { contactCompanies, contactListMembers, contactPhones, contactTags, contacts, customFieldValues, metaEvents, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';
import { likeEscape } from '../organizations';
import type { ResolvedCf } from './contact-filters';
import type { ContactSort, ListContactsQuery } from './contacts.dto';

export type ContactRow = typeof contacts.$inferSelect;
export interface PhoneRow {
  contactId: string;
  e164: string;
  isPrimary: boolean;
}

/**
 * Alcance de visibilidad de quien consulta (ADR-32 #2 / ADR-43): con `viewAll` ve todos los contactos de su organización; sin él, solo los que tiene
 * ASIGNADOS. Lo construye el controlador desde los permisos verificados y SE EXIGE en cada consulta: no hay forma de leer contactos sin pasarlo.
 * El aislamiento entre ORGANIZACIONES no depende de esto: lo da la RLS de la BD.
 */
export interface Scope {
  readonly userId: string;
  readonly viewAll: boolean;
}

interface Cursor {
  s: ContactSort;
  o: 'asc' | 'desc';
  k: string;
  id: string;
}
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(raw: string, sort: ContactSort, order: 'asc' | 'desc'): Cursor {
  const bad = (): never => {
    throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  };
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch {
    return bad();
  }
  if (c.s !== sort || c.o !== order || typeof c.k !== 'string' || c.k.length === 0 || c.k.length > 100 || typeof c.id !== 'string' || !UUID_RE.test(c.id)) return bad();
  if (sort !== 'name' && Number.isNaN(Date.parse(c.k))) return bad();
  return { s: sort, o: order, k: c.k, id: c.id };
}

/** Lo que el listado necesita: orden, página y los filtros ya mezclados con los de la lista (si la hay). */
export type PageFilter = Pick<ListContactsQuery, 'sort' | 'order' | 'limit'> & {
  cursor?: string | undefined;
  q?: string | undefined;
  owner?: string | undefined;
  source?: string | undefined;
  consent?: string | undefined;
  company?: string | undefined;
  tag?: readonly string[] | undefined;
};
export interface PageExtras {
  /** Filtros por campo personalizado ya resueltos contra sus definiciones. */
  cf: readonly ResolvedCf[];
  /** Lista FIJA: solo sus miembros. */
  memberOf?: string | undefined;
}

const SET_ROW = sql`num_nonnulls(${customFieldValues.valueText}, ${customFieldValues.valueNumber}, ${customFieldValues.valueBool}, ${customFieldValues.valueDate}, ${customFieldValues.valueDatetime}, ${customFieldValues.valueJson}) = 1`;
const TEXTLIKE = new Set(['text', 'long_text', 'email', 'phone', 'url']);

/** Condición «este contacto cumple el filtro de campo personalizado» (subconsulta correlacionada; la RLS acota por empresa). */
function cfCondition(tx: TenantTx, r: ResolvedCf): SQL {
  const v = customFieldValues;
  const mine = and(eq(v.entity, 'contact'), eq(v.entityId, contacts.id), eq(v.definitionId, r.definitionId)) as SQL;
  const some = (extra?: SQL): SQL => exists(tx.select({ one: sql`1` }).from(v).where(extra ? (and(mine, SET_ROW, extra)) : (and(mine, SET_ROW))));
  if (r.op === 'is_set') return some();
  if (r.op === 'is_empty') return sql`NOT ${some()}`;
  const val = r.value ?? '';
  if (r.type === 'multiselect') return some(sql`${v.valueJson} @> ${JSON.stringify([val])}::jsonb`);
  if (r.type === 'boolean') return some(eq(v.valueBool, val === 'true'));
  if (r.type === 'number' || r.type === 'currency' || r.type === 'percent') return some(r.op === 'eq' ? sql`${v.valueNumber} = ${val}::numeric` : r.op === 'gte' ? sql`${v.valueNumber} >= ${val}::numeric` : sql`${v.valueNumber} <= ${val}::numeric`);
  if (r.type === 'date') return some(r.op === 'eq' ? sql`${v.valueDate} = ${val}::date` : r.op === 'gte' ? sql`${v.valueDate} >= ${val}::date` : sql`${v.valueDate} <= ${val}::date`);
  if (r.type === 'datetime') return some(r.op === 'gte' ? sql`${v.valueDatetime} >= ${val}::timestamptz` : sql`${v.valueDatetime} <= ${val}::timestamptz`);
  if (r.op === 'contains') return some(sql`${v.valueText} ILIKE ${`%${likeEscape(val)}%`} ESCAPE '!'`);
  return some(TEXTLIKE.has(r.type) ? sql`lower(${v.valueText}) = lower(${val})` : eq(v.valueText, val)); // select: exacto
}

/** Consultas de contactos. TODAS pasan por `withTenant` (el llamador abre la transacción): sin TenantContext no hay conexión. */
@Injectable()
export class ContactsRepository {
  /** Contactos vigentes y visibles para este alcance. */
  visible(scope: Scope): SQL {
    return scope.viewAll ? isNull(contacts.deletedAt) : (and(isNull(contacts.deletedAt), eq(contacts.ownerId, scope.userId)) as SQL);
  }

  /** Una página de contactos con su clave de orden (para el cursor) y, en la primera, el total. */
  async page(tx: TenantTx, scope: Scope, f: PageFilter, x: PageExtras = { cf: [] }): Promise<{ rows: ContactRow[]; next: string | null; total: number | null }> {
    const where: SQL[] = [this.visible(scope)];
    if (scope.viewAll && f.owner) {
      if (f.owner === 'me') where.push(eq(contacts.ownerId, scope.userId));
      else if (f.owner === 'none') where.push(isNull(contacts.ownerId));
      else where.push(eq(contacts.ownerId, f.owner));
    }
    if (f.source) where.push(eq(contacts.source, f.source));
    if (f.consent) where.push(eq(contacts.consent, f.consent));
    if (f.company) where.push(exists(tx.select({ one: sql`1` }).from(contactCompanies).where(and(eq(contactCompanies.contactId, contacts.id), eq(contactCompanies.companyId, f.company)))));
    for (const t of f.tag ?? []) where.push(exists(tx.select({ one: sql`1` }).from(contactTags).where(and(eq(contactTags.contactId, contacts.id), eq(contactTags.tagId, t)))));
    for (const c of x.cf) where.push(cfCondition(tx, c));
    if (x.memberOf) where.push(exists(tx.select({ one: sql`1` }).from(contactListMembers).where(and(eq(contactListMembers.listId, x.memberOf), eq(contactListMembers.contactId, contacts.id)))));
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      const digits = f.q.replace(/\D/g, '');
      const byPhone =
        digits.length >= 3
          ? exists(tx.select({ one: sql`1` }).from(contactPhones).where(and(eq(contactPhones.contactId, contacts.id), isNull(contactPhones.deletedAt), sql`${contactPhones.e164} LIKE ${`%${digits}%`}`)))
          : undefined;
      where.push(or(sql`${contacts.name} ILIKE ${like} ESCAPE '!'`, sql`${contacts.email} ILIKE ${like} ESCAPE '!'`, byPhone) as SQL);
    }
    const base = and(...where) as SQL;

    const text = f.sort === 'name';
    const key: SQL = f.sort === 'name' ? sql`lower(${contacts.name})` : f.sort === 'updated_at' ? sql`${contacts.updatedAt}` : sql`${contacts.createdAt}`;
    const asc = f.order === 'asc';
    let after: SQL | undefined;
    if (f.cursor) {
      const c = decodeCursor(f.cursor, f.sort, f.order);
      if (text) after = asc ? sql`(${key}, ${contacts.id}) > (${c.k}::text, ${c.id}::uuid)` : sql`(${key}, ${contacts.id}) < (${c.k}::text, ${c.id}::uuid)`;
      else after = asc ? sql`(${key}, ${contacts.id}) > (${c.k}::timestamptz, ${c.id}::uuid)` : sql`(${key}, ${contacts.id}) < (${c.k}::timestamptz, ${c.id}::uuid)`;
    }
    const rows = await tx
      .select({ c: contacts, sortKey: sql<string>`(${key})::text` })
      .from(contacts)
      .where(after ? and(base, after) : base)
      .orderBy(asc ? sql`${key} ASC` : sql`${key} DESC`, asc ? sql`${contacts.id} ASC` : sql`${contacts.id} DESC`)
      .limit(f.limit + 1);
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    const next = rows.length > f.limit && last ? encodeCursor({ s: f.sort, o: f.order, k: last.sortKey, id: last.c.id }) : null;
    let total: number | null = null;
    if (!f.cursor) {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(contacts).where(base);
      total = n?.n ?? 0;
    }
    return { rows: page.map((r) => r.c), next, total };
  }

  /** Un contacto visible para este alcance (con `lock`, bloquea la fila: dos ediciones del mismo contacto no se pisan). */
  async byId(tx: TenantTx, scope: Scope, id: string, lock = false): Promise<ContactRow | undefined> {
    const q = tx.select().from(contacts).where(and(eq(contacts.id, id), this.visible(scope)));
    const [row] = await (lock ? q.for('update') : q).limit(1);
    return row;
  }

  /** De estos ids, los contactos vigentes que este alcance puede ver (los demás se ignoran). */
  async visibleIds(tx: TenantTx, scope: Scope, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.select({ id: contacts.id }).from(contacts).where(and(inArray(contacts.id, [...ids]), this.visible(scope)));
    return rows.map((r) => r.id);
  }

  /** Contactos vigentes por id (ya filtrados por alcance), del más reciente al más antiguo. */
  byIds(tx: TenantTx, ids: readonly string[]): Promise<ContactRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.select().from(contacts).where(and(inArray(contacts.id, [...ids]), isNull(contacts.deletedAt))).orderBy(sql`${contacts.createdAt} DESC`, sql`${contacts.id} DESC`);
  }

  /** Contacto (vigente) de la empresa activa que tiene ese teléfono. Para los canales de entrada, que no tienen alcance por persona. */
  async idByPhone(tx: TenantTx, e164: string): Promise<string | undefined> {
    const [r] = await tx
      .select({ id: contacts.id })
      .from(contactPhones)
      .innerJoin(contacts, and(eq(contacts.organizationId, contactPhones.organizationId), eq(contacts.id, contactPhones.contactId)))
      .where(and(eq(contactPhones.e164, e164), isNull(contactPhones.deletedAt), isNull(contacts.deletedAt)))
      .limit(1);
    return r?.id;
  }

  /** Bloquea la fila de un contacto vigente (sin alcance por persona: lo usa el sistema, no una persona). */
  async lockById(tx: TenantTx, id: string): Promise<ContactRow | undefined> {
    const [row] = await tx.select().from(contacts).where(and(eq(contacts.id, id), isNull(contacts.deletedAt))).for('update').limit(1);
    return row;
  }

  /** Estado del último evento Purchase de cada contacto (para mostrar en la ficha). */
  async lastPurchaseEvents(tx: TenantTx, ids: readonly string[]): Promise<Map<string, { status: string; sentAt: Date | null }>> {
    const out = new Map<string, { status: string; sentAt: Date | null }>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ contactId: metaEvents.contactId, status: metaEvents.status, sentAt: metaEvents.sentAt })
      .from(metaEvents)
      .where(and(inArray(metaEvents.contactId, [...ids]), eq(metaEvents.type, 'Purchase')))
      .orderBy(desc(metaEvents.createdAt), desc(metaEvents.id));
    for (const r of rows) if (!out.has(r.contactId)) out.set(r.contactId, { status: r.status, sentAt: r.sentAt });
    return out;
  }

  /** Teléfonos vigentes de varios contactos (el principal primero). */
  async phonesOf(tx: TenantTx, ids: readonly string[]): Promise<Map<string, PhoneRow[]>> {
    const out = new Map<string, PhoneRow[]>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ contactId: contactPhones.contactId, e164: contactPhones.e164, isPrimary: contactPhones.isPrimary })
      .from(contactPhones)
      .where(and(inArray(contactPhones.contactId, [...ids]), isNull(contactPhones.deletedAt)))
      .orderBy(sql`${contactPhones.isPrimary} DESC`, contactPhones.createdAt, contactPhones.id);
    for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), r]);
    return out;
  }

  /** ¿Cuáles de estos teléfonos ya están vigentes en la organización (en otro contacto)? */
  async takenPhones(tx: TenantTx, e164s: readonly string[], exceptContactId?: string): Promise<Set<string>> {
    if (e164s.length === 0) return new Set();
    const rows = await tx
      .select({ e164: contactPhones.e164 })
      .from(contactPhones)
      .where(and(inArray(contactPhones.e164, [...e164s]), isNull(contactPhones.deletedAt), exceptContactId ? sql`${contactPhones.contactId} <> ${exceptContactId}` : undefined));
    return new Set(rows.map((r) => r.e164));
  }
}
