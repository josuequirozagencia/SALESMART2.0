import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { contactPhones, contacts, Database, type TenantTx } from '../../db';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgMembersService, type OrgPerson } from '../organizations';
import type { CreateContactDto, ListContactsQuery, UpdateContactDto } from './contacts.dto';
import { ContactsRepository, type ContactRow, type PhoneRow, type Scope } from './contacts.repository';

export interface ContactView {
  id: string;
  name: string;
  email: string | null;
  /** El primero es el principal. */
  phones: Array<{ e164: string; primary: boolean }>;
  owner: { id: string; name: string } | null;
  source: string;
  consent: 'unknown' | 'granted' | 'revoked';
  consent_updated_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ContactList {
  items: ContactView[];
  next_cursor: string | null;
  /** Solo en la primera página (sin cursor). */
  total: number | null;
}

/** Lo que el controlador sabe del que pregunta (de sus permisos verificados). El id de la persona sale de TenantContext. */
export interface ContactScope {
  readonly viewAll: boolean;
}

const iso = (d: Date): string => d.toISOString();
const asConsent = (v: string): ContactView['consent'] => (v === 'granted' || v === 'revoked' ? v : 'unknown');

/**
 * Contactos (M3.1, ADR-43; ADR-32 #2/#3).
 *  - La ORGANIZACIÓN siempre sale de TenantContext y la aísla la RLS. Dentro de la organización, quien no tiene `contacts.view_all` solo ve y toca los
 *    contactos que tiene asignados: uno ajeno responde 404 igual que uno inexistente.
 *  - El asesor crea contactos asignados a sí mismo; asignar a otra persona o cambiar el dueño exige `contacts.view_all` y que la persona pueda recibir trabajo.
 *  - El teléfono (E.164) es único por organización entre los contactos vigentes. Borrar un contacto es LÓGICO y libera sus teléfonos.
 *  - Cada cambio queda en la auditoría del cliente (misma transacción), con la marca «actuando como» si lo hace una agencia o el Súper Admin.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsRepository) private readonly repo: ContactsRepository,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  async list(scope: ContactScope, q: ListContactsQuery): Promise<ContactList> {
    const sc = this.scope(scope);
    const page = await this.db.withTenant(async (tx) => {
      const p = await this.repo.page(tx, sc, q);
      return { ...p, phones: await this.repo.phonesOf(tx, p.rows.map((r) => r.id)) };
    });
    return { items: await this.views(page.rows, page.phones), next_cursor: page.next, total: page.total };
  }

  async get(scope: ContactScope, id: string): Promise<ContactView> {
    const sc = this.scope(scope);
    const found = await this.db.withTenant(async (tx) => {
      const row = await this.repo.byId(tx, sc, id);
      return row ? { row, phones: await this.repo.phonesOf(tx, [row.id]) } : null;
    });
    if (!found) throw new NotFoundError();
    return (await this.views([found.row], found.phones))[0]!;
  }

  async create(scope: ContactScope, input: CreateContactDto): Promise<ContactView> {
    const sc = this.scope(scope);
    const owner = await this.ownerFor(sc, input.owner_id, true);
    const consent = input.consent ?? 'unknown';
    const phones = input.phones ?? [];
    const now = new Date();
    const out = await this.db
      .withTenant(async (tx) => {
      await this.assertPhonesFree(tx, phones);
      const [row] = await tx
        .insert(contacts)
        .values({ name: input.name, email: input.email ?? null, ownerId: owner, source: 'manual', consent, consentUpdatedAt: consent === 'unknown' ? null : now, createdBy: sc.userId })
        .returning();
      const c = row!;
      if (phones.length > 0) await tx.insert(contactPhones).values(phones.map((e164, i) => ({ contactId: c.id, e164, isPrimary: i === 0 })));
      await writeAudit(tx, { entityType: 'contact', entityId: c.id, newValue: { name: c.name, email: c.email, owner_id: c.ownerId, consent: c.consent, phones, source: c.source }, source: 'manual' });
      return { row: c, phones: await this.repo.phonesOf(tx, [c.id]) };
      })
      .catch((e: unknown) => {
        throw this.phoneRace(e, phones);
      });
    return (await this.views([out.row], out.phones))[0]!;
  }

  async update(scope: ContactScope, id: string, input: UpdateContactDto): Promise<ContactView> {
    const sc = this.scope(scope);
    let owner: string | null | undefined;
    if (input.owner_id !== undefined) owner = await this.ownerFor(sc, input.owner_id, false);
    const out = await this.db
      .withTenant(async (tx) => {
      const row = await this.repo.byId(tx, sc, id, true);
      if (!row) throw new NotFoundError();
      const current = await this.repo.phonesOf(tx, [id]);
      const before = (current.get(id) ?? []).map((p) => p.e164);
      const set: Partial<typeof contacts.$inferInsert> = {};
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
      if (input.name !== undefined && input.name !== row.name) {
        set.name = input.name;
        changes.push({ field: 'name', oldValue: row.name, newValue: input.name });
      }
      if (input.email !== undefined && (input.email ?? null) !== row.email) {
        set.email = input.email ?? null;
        changes.push({ field: 'email', oldValue: row.email, newValue: input.email ?? null });
      }
      if (owner !== undefined && owner !== row.ownerId) {
        set.ownerId = owner;
        changes.push({ field: 'owner_id', oldValue: row.ownerId, newValue: owner });
      }
      if (input.consent !== undefined && input.consent !== row.consent) {
        set.consent = input.consent;
        set.consentUpdatedAt = new Date();
        changes.push({ field: 'consent', oldValue: row.consent, newValue: input.consent });
      }
      const phonesChanged = input.phones !== undefined && JSON.stringify(input.phones) !== JSON.stringify(before);
      if (phonesChanged && input.phones) {
        await this.assertPhonesFree(tx, input.phones, id);
        await this.replacePhones(tx, id, current.get(id) ?? [], input.phones);
        changes.push({ field: 'phones', oldValue: before, newValue: input.phones });
      }
      if (changes.length === 0) return { row, phones: current };
      set.updatedAt = new Date();
      const [updated] = await tx.update(contacts).set(set).where(eq(contacts.id, id)).returning();
      for (const c of changes) await writeAudit(tx, { entityType: 'contact', entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      return { row: updated!, phones: await this.repo.phonesOf(tx, [id]) };
      })
      .catch((e: unknown) => {
        throw this.phoneRace(e, input.phones ?? []);
      });
    return (await this.views([out.row], out.phones))[0]!;
  }

  /** Borrado LÓGICO: el contacto y sus teléfonos quedan marcados y los números vuelven a estar libres. Los datos se conservan (auditoría, historial). */
  async remove(scope: ContactScope, id: string): Promise<{ id: string; deleted: true }> {
    const sc = this.scope(scope);
    await this.db.withTenant(async (tx) => {
      const row = await this.repo.byId(tx, sc, id, true);
      if (!row) throw new NotFoundError();
      const now = new Date();
      const phones = (await this.repo.phonesOf(tx, [id])).get(id) ?? [];
      await tx.update(contactPhones).set({ deletedAt: now, isPrimary: false }).where(and(eq(contactPhones.contactId, id), isNull(contactPhones.deletedAt)));
      await tx.update(contacts).set({ deletedAt: now, updatedAt: now }).where(eq(contacts.id, id));
      await writeAudit(tx, { entityType: 'contact', entityId: id, oldValue: { name: row.name, email: row.email, owner_id: row.ownerId, phones: phones.map((p) => p.e164) }, source: 'manual' });
    });
    return { id, deleted: true };
  }

  /** Personas a las que se puede asignar un contacto (solo con `contacts.view_all`: lo exige el controlador). */
  async owners(): Promise<{ items: OrgPerson[] }> {
    return { items: await this.members.assignable() };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private scope(s: ContactScope): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll: s.viewAll };
  }

  /**
   * Dueño efectivo. Sin `contacts.view_all`: siempre uno mismo (al CREAR se asigna a quien lo crea; mandar otro es 403; cambiarlo en una edición también).
   * Con él: el pedido (null = sin asignar), que debe poder recibir trabajo. Al crear sin pedirlo, queda sin asignar.
   */
  private async ownerFor(sc: Scope, requested: string | null | undefined, creating: boolean): Promise<string | null> {
    if (!sc.viewAll) {
      if (creating) {
        if (requested !== undefined && requested !== sc.userId) throw new ForbiddenError('OWNER_NOT_ALLOWED', 'Solo puedes crear contactos asignados a ti');
        return sc.userId;
      }
      if (requested !== undefined && requested !== sc.userId) throw new ForbiddenError('OWNER_NOT_ALLOWED', 'No puedes cambiar a quién está asignado un contacto');
      return requested ?? sc.userId;
    }
    if (requested === undefined || requested === null) return null;
    if (!(await this.members.canBeAssigned(requested))) throw new ValidationError([{ path: 'owner_id', code: 'invalid_owner', message: 'Esa persona no puede recibir contactos' }]);
    return requested;
  }

  /** Dos altas simultáneas del mismo número: gana una y la otra choca con el índice único (la BD es la última palabra). */
  private phoneRace(e: unknown, phones: readonly string[]): unknown {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    if (cause?.code === '23505' && cause.constraint === 'contact_phones_org_e164_uq') {
      return new AppError(409, 'PHONE_TAKEN', 'Ese teléfono ya está registrado en otro contacto', phones.map((_, i) => ({ path: `phones.${i}`, code: 'duplicate', message: 'Ya existe un contacto con este teléfono' })));
    }
    return e;
  }

  private async assertPhonesFree(tx: TenantTx, e164s: readonly string[], exceptContactId?: string): Promise<void> {
    const taken = await this.repo.takenPhones(tx, e164s, exceptContactId);
    if (taken.size === 0) return;
    throw new AppError(409, 'PHONE_TAKEN', 'Ese teléfono ya está registrado en otro contacto', e164s.flatMap((p, i) => (taken.has(p) ? [{ path: `phones.${i}`, code: 'duplicate', message: 'Ya existe un contacto con este teléfono' }] : [])));
  }

  /** Deja EXACTAMENTE `desired` como teléfonos vigentes (el primero, principal) sin chocar con el índice de «un solo principal». */
  private async replacePhones(tx: TenantTx, contactId: string, current: readonly PhoneRow[], desired: readonly string[]): Promise<void> {
    const now = new Date();
    const keep = new Set(desired);
    await tx.update(contactPhones).set({ isPrimary: false }).where(and(eq(contactPhones.contactId, contactId), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true)));
    for (const p of current) {
      if (!keep.has(p.e164)) await tx.update(contactPhones).set({ deletedAt: now }).where(and(eq(contactPhones.contactId, contactId), eq(contactPhones.e164, p.e164), isNull(contactPhones.deletedAt)));
    }
    const have = new Set(current.map((p) => p.e164));
    const fresh = desired.filter((p) => !have.has(p));
    if (fresh.length > 0) await tx.insert(contactPhones).values(fresh.map((e164) => ({ contactId, e164, isPrimary: false })));
    if (desired[0]) await tx.update(contactPhones).set({ isPrimary: true }).where(and(eq(contactPhones.contactId, contactId), eq(contactPhones.e164, desired[0]), isNull(contactPhones.deletedAt)));
  }

  private async views(rows: readonly ContactRow[], phones: Map<string, PhoneRow[]>): Promise<ContactView[]> {
    const labels = await this.members.labels(rows.flatMap((r) => (r.ownerId ? [r.ownerId] : [])));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phones: (phones.get(r.id) ?? []).map((p) => ({ e164: p.e164, primary: p.isPrimary })),
      owner: r.ownerId ? (labels.get(r.ownerId) ?? { id: r.ownerId, name: 'Persona desconocida' }) : null,
      source: r.source,
      consent: asConsent(r.consent),
      consent_updated_at: r.consentUpdatedAt ? iso(r.consentUpdatedAt) : null,
      created_at: iso(r.createdAt),
      updated_at: iso(r.updatedAt),
    }));
  }
}
