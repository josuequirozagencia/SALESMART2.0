import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { contactPhones, contacts, Database, opportunities, type TenantTx } from '../../db';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CustomValuesService, type CustomValues } from '../custom-fields';
import { OrgMembersService, type OrgPerson } from '../organizations';
import { ContactTaggingService, SystemTagsService, type TagView } from '../tags';
import { checkCfValue, mergeFilters, parseCf, type ContactFilters, type ResolvedCf } from './contact-filters';
import { MAX_EXPORT_ROWS, type ExportDto } from './contact-export';
import { ContactListsRepository } from './contact-lists.repository';
import { savedFilters } from './contact-lists.service';
import type { CreateContactDto, ListContactsQuery, UpdateContactDto } from './contacts.dto';
import { CompaniesService } from './companies.service';
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
  /** Campos personalizados (M3.2): `{ variable: valor }`, solo los no vacíos de campos no archivados. */
  custom_fields: CustomValues;
  /** Etiquetas del contacto (M3.3): las del sistema las pone el sistema. */
  tags: TagView[];
  /** Empresas a las que pertenece (M3.6, ADR-48). */
  companies: Array<{ id: string; name: string }>;
  /** Origen del lead por Click-to-WhatsApp (M3.3, ADR-45); null si el contacto no llegó por un anuncio. */
  attribution: ContactAttribution | null;
  created_at: string;
  updated_at: string;
}
export interface Touch {
  at: string;
  source: string | null;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
}
export interface ContactAttribution {
  ctwa_cl_id: string | null;
  first_touch: Touch | null;
  last_touch: Touch | null;
  /** Último evento Purchase hacia Meta (null si nunca se creó uno). */
  capi: { status: string; sent_at: string | null } | null;
}
/** Datos de un clic de Click-to-WhatsApp (el webhook de atribución). */
export interface TouchInput {
  ctwaClId: string;
  source: string;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  at: Date;
}
interface Extras {
  custom: Map<string, CustomValues>;
  tags: Map<string, TagView[]>;
  capi: Map<string, { status: string; sentAt: Date | null }>;
  /** Empresas vigentes del contacto (M3.6). */
  companies: Map<string, Array<{ id: string; name: string }>>;
}
/** Lo leído para una exportación, aún sin los nombres de los responsables (esos viven en identidad y se resuelven FUERA de la transacción del tenant). */
export interface ExportBundle {
  rows: ContactRow[];
  phones: Map<string, PhoneRow[]>;
  extras: Extras;
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
const touchOf = (at: Date | null, source: string | null, campaign: string | null, adset: string | null, ad: string | null): Touch | null => (at ? { at: at.toISOString(), source, campaign, adset, ad } : null);
const attributionOf = (r: ContactRow, capi: { status: string; sentAt: Date | null } | undefined): ContactAttribution | null =>
  r.ctwaClId === null && r.firstTouchAt === null
    ? null
    : {
        ctwa_cl_id: r.ctwaClId,
        first_touch: touchOf(r.firstTouchAt, r.firstTouchSource, r.firstTouchCampaign, r.firstTouchAdset, r.firstTouchAd),
        last_touch: touchOf(r.lastTouchAt, r.lastTouchSource, r.lastTouchCampaign, r.lastTouchAdset, r.lastTouchAd),
        capi: capi ? { status: capi.status, sent_at: capi.sentAt ? capi.sentAt.toISOString() : null } : null,
      };
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
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(SystemTagsService) private readonly systemTags: SystemTagsService,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(ContactTaggingService) private readonly tagging: ContactTaggingService,
    @Inject(ContactListsRepository) private readonly lists: ContactListsRepository,
  ) {}

  async list(scope: ContactScope, q: ListContactsQuery): Promise<ContactList> {
    const sc = this.scope(scope);
    const page = await this.db.withTenant(async (tx) => {
      const p = await this.pageFor(tx, sc, q);
      const ids = p.rows.map((r) => r.id);
      return { ...p, phones: await this.repo.phonesOf(tx, ids), extras: await this.extras(tx, ids) };
    });
    return { items: await this.views(page.rows, page.phones, page.extras), next_cursor: page.next, total: page.total };
  }

  async get(scope: ContactScope, id: string): Promise<ContactView> {
    const sc = this.scope(scope);
    const found = await this.db.withTenant(async (tx) => {
      const row = await this.repo.byId(tx, sc, id);
      return row ? { row, phones: await this.repo.phonesOf(tx, [row.id]), extras: await this.extras(tx, [row.id]) } : null;
    });
    if (!found) throw new NotFoundError();
    return (await this.views([found.row], found.phones, found.extras))[0]!;
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
      // Campos personalizados: valida todo (obligatorios incluidos) y, si algo falla, la transacción entera se revierte
      const customChanges = await this.custom.apply(tx, 'contact', c.id, input.custom_fields ?? {}, { creating: true });
      const customNew = Object.fromEntries(customChanges.map((x) => [x.key, x.newValue]));
      const tagChange = input.tag_ids && input.tag_ids.length > 0 ? await this.tagging.setCustom(tx, c.id, input.tag_ids) : null;
      await writeAudit(tx, { entityType: 'contact', entityId: c.id, newValue: { name: c.name, email: c.email, owner_id: c.ownerId, consent: c.consent, phones, source: c.source, ...(customChanges.length > 0 ? { custom_fields: customNew } : {}), ...(tagChange ? { tags: tagChange.after } : {}) }, source: 'manual' });
      return { row: c, phones: await this.repo.phonesOf(tx, [c.id]), extras: await this.extras(tx, [c.id]) };
      })
      .catch((e: unknown) => {
        throw this.phoneRace(e, phones);
      });
    return (await this.views([out.row], out.phones, out.extras))[0]!;
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
      // Campos personalizados: una fila de auditoría por campo cambiado (`custom.<variable>`)
      if (input.custom_fields) {
        for (const c of await this.custom.apply(tx, 'contact', id, input.custom_fields, { creating: false })) changes.push({ field: `custom.${c.key}`, oldValue: c.oldValue, newValue: c.newValue });
      }
      if (input.tag_ids !== undefined) {
        const t = await this.tagging.setCustom(tx, id, input.tag_ids);
        if (t) changes.push({ field: 'tags', oldValue: t.before, newValue: t.after });
      }
      if (changes.length === 0) return { row, phones: current, extras: await this.extras(tx, [id]) };
      set.updatedAt = new Date();
      const [updated] = await tx.update(contacts).set(set).where(eq(contacts.id, id)).returning();
      for (const c of changes) await writeAudit(tx, { entityType: 'contact', entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      return { row: updated!, phones: await this.repo.phonesOf(tx, [id]), extras: await this.extras(tx, [id]) };
      })
      .catch((e: unknown) => {
        throw this.phoneRace(e, input.phones ?? []);
      });
    return (await this.views([out.row], out.phones, out.extras))[0]!;
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
      // Sus oportunidades dejan de existir con él (M4.2, ADR-49): si no, quedarían invisibles pero seguirían bloqueando borrar etapas y pipelines
      const gone = await tx.update(opportunities).set({ deletedAt: now, updatedAt: now }).where(and(eq(opportunities.contactId, id), isNull(opportunities.deletedAt))).returning({ id: opportunities.id });
      for (const o of gone) await writeAudit(tx, { entityType: 'opportunity', entityId: o.id, field: 'deleted', oldValue: false, newValue: { deleted: true, reason: 'contact_deleted' }, source: 'manual' });
    });
    return { id, deleted: true };
  }

  /** El contacto vigente que esta persona puede ver (id, nombre y responsable); 404 uniforme si no. Para los módulos que cuelgan de un contacto, dentro de su transacción. */
  async visibleContactIn(tx: TenantTx, scope: ContactScope, id: string): Promise<{ id: string; name: string; ownerId: string | null }> {
    const row = await this.repo.byId(tx, this.scope(scope), id);
    if (!row) throw new NotFoundError();
    return { id: row.id, name: row.name, ownerId: row.ownerId };
  }

  /** Personas a las que se puede asignar un contacto (solo con `contacts.view_all`: lo exige el controlador). */
  async owners(): Promise<{ items: OrgPerson[] }> {
    return { items: await this.members.assignable() };
  }

  /**
   * Para los canales de entrada (atribución, mensajes): el contacto de la empresa activa con ese teléfono, o uno nuevo con el origen del canal, sin consentimiento
   * y sin responsable. Un contacto nuevo se llama como su perfil (`name`) si el canal lo informa; si no, como su teléfono. Serializa por teléfono para que dos llamadas simultáneas no creen dos contactos. Va DENTRO de la transacción del que llama.
   */
  async findOrCreateByPhone(tx: TenantTx, e164: string, source: string, name?: string | null): Promise<{ id: string; created: boolean }> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended((${`contact_phone:${e164}`}::text || ':' || app_org()::text), 0))`);
    const existing = await this.repo.idByPhone(tx, e164);
    if (existing) return { id: existing, created: false };
    // El nombre del perfil lo escribe quien tiene el teléfono: sin caracteres de control y dentro del largo permitido
    const profile = (name ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 200).trim();
    const finalName = profile === '' ? e164 : profile;
    const [c] = await tx.insert(contacts).values({ name: finalName, source, consent: 'unknown', createdBy: null }).returning();
    await tx.insert(contactPhones).values({ contactId: c!.id, e164, isPrimary: true });
    await writeAudit(tx, { entityType: 'contact', entityId: c!.id, newValue: { name: finalName, source, consent: 'unknown', phones: [e164] }, source: 'meta' });
    return { id: c!.id, created: true };
  }

  /**
   * Registra un clic de Click-to-WhatsApp (ADR-45): el PRIMER toque nunca se sobrescribe; el último sí (salvo un clic más antiguo que el último registrado);
   * el mismo `ctwa_cl_id` que ya es el último no cambia nada. Devuelve qué se tocó.
   */
  async applyTouch(tx: TenantTx, id: string, t: TouchInput): Promise<{ duplicate: boolean; firstSet: boolean; lastUpdated: boolean }> {
    const row = await this.repo.lockById(tx, id);
    if (!row) throw new NotFoundError();
    if (row.ctwaClId === t.ctwaClId) return { duplicate: true, firstSet: false, lastUpdated: false };
    const set: Partial<typeof contacts.$inferInsert> = {};
    const firstSet = row.firstTouchAt === null;
    if (firstSet) Object.assign(set, { firstTouchAt: t.at, firstTouchSource: t.source, firstTouchCampaign: t.campaign, firstTouchAdset: t.adset, firstTouchAd: t.ad });
    const lastUpdated = row.lastTouchAt === null || t.at.getTime() >= row.lastTouchAt.getTime();
    if (lastUpdated) Object.assign(set, { ctwaClId: t.ctwaClId, lastTouchAt: t.at, lastTouchSource: t.source, lastTouchCampaign: t.campaign, lastTouchAdset: t.adset, lastTouchAd: t.ad });
    if (Object.keys(set).length > 0) {
      set.updatedAt = new Date();
      await tx.update(contacts).set(set).where(eq(contacts.id, id));
      await writeAudit(tx, {
        entityType: 'contact',
        entityId: id,
        field: 'attribution',
        oldValue: row.lastTouchAt ? { at: row.lastTouchAt.toISOString(), campaign: row.lastTouchCampaign } : null,
        newValue: { at: t.at.toISOString(), source: t.source, campaign: t.campaign, first: firstSet },
        source: 'meta',
      });
    }
    return { duplicate: false, firstSet, lastUpdated };
  }

  /** Teléfono principal y último clic de un contacto, para armar los eventos hacia Meta (sin alcance por persona: lo usa el sistema). */
  async channelIdentity(tx: TenantTx, id: string): Promise<{ ctwaClId: string | null; primaryPhone: string | null } | null> {
    const row = await this.repo.lockById(tx, id);
    if (!row) return null;
    const phones = (await this.repo.phonesOf(tx, [id])).get(id) ?? [];
    return { ctwaClId: row.ctwaClId, primaryPhone: phones[0]?.e164 ?? null };
  }

  /**
   * Los contactos de una exportación (ADR-47 #8), dentro de la transacción del que llama (que también audita). Respeta el alcance de la persona y, en «vista»,
   * los mismos filtros y la lista abierta del listado; en «todos» ignora filtros. Más de `MAX_EXPORT_ROWS` es un 400: hay que filtrar.
   */
  async exportRowsIn(tx: TenantTx, scope: ContactScope, q: ExportDto): Promise<ExportBundle> {
    const sc = this.scope(scope);
    const out: ExportBundle = { rows: [], phones: new Map(), extras: { custom: new Map(), tags: new Map(), capi: new Map(), companies: new Map() } };
    const push = async (rows: ContactRow[]) => {
      const ids = rows.map((r) => r.id);
      const phones = await this.repo.phonesOf(tx, ids);
      const x = await this.extras(tx, ids);
      out.rows.push(...rows);
      for (const [k, v] of phones) out.phones.set(k, v);
      for (const [k, v] of x.custom) out.extras.custom.set(k, v);
      for (const [k, v] of x.tags) out.extras.tags.set(k, v);
      for (const [k, v] of x.capi) out.extras.capi.set(k, v);
      for (const [k, v] of x.companies) out.extras.companies.set(k, v);
    };
    if (q.scope === 'selection') {
      const visible = await this.repo.visibleIds(tx, sc, q.ids ?? []);
      for (let i = 0; i < visible.length; i += 500) await push(await this.repo.byIds(tx, visible.slice(i, i + 500)));
      return out;
    }
    const filters = q.scope === 'all' ? {} : {
      ...(q.q ? { q: q.q } : {}),
      ...(q.owner ? { owner: q.owner } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.consent ? { consent: q.consent } : {}),
      ...(q.tag && q.tag.length > 0 ? { tag: q.tag } : {}),
      ...(q.cf && q.cf.length > 0 ? { cf: q.cf } : {}),
      ...(q.list ? { list: q.list } : {}),
    };
    let cursor: string | undefined;
    for (;;) {
      const p = await this.pageFor(tx, sc, { ...filters, sort: q.sort, order: q.order, limit: 100, ...(cursor ? { cursor } : {}) });
      await push(p.rows);
      if (out.rows.length > MAX_EXPORT_ROWS) throw new AppError(400, 'EXPORT_TOO_LARGE', `Son más de ${MAX_EXPORT_ROWS} contactos: aplica filtros o elige una lista para exportar menos`);
      if (!p.next) return out;
      cursor = p.next;
    }
  }

  /** Convierte lo leído en vistas de contacto (resuelve responsables en identidad; llamar FUERA de la transacción del tenant). */
  exportViews(b: ExportBundle): Promise<ContactView[]> {
    return this.views(b.rows, b.phones, b.extras);
  }

  /** Una página del listado: mezcla los filtros de la petición con los de la lista guardada (si la hay) y resuelve los filtros por campo personalizado. */
  private async pageFor(tx: TenantTx, sc: Scope, q: ListContactsQuery) {
    let filters: ContactFilters = {
      ...(q.q ? { q: q.q } : {}),
      ...(q.owner ? { owner: q.owner } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.consent ? { consent: q.consent } : {}),
      ...(q.tag && q.tag.length > 0 ? { tag: q.tag } : {}),
      ...(q.cf && q.cf.length > 0 ? { cf: q.cf } : {}),
    };
    let memberOf: string | undefined;
    if (q.list) {
      const l = await this.lists.visibleById(tx, sc.userId, q.list);
      if (!l) throw new NotFoundError();
      if (l.kind === 'fixed') memberOf = l.id;
      else filters = mergeFilters(savedFilters(l), filters);
    }
    const cf = await this.resolveCf(tx, filters.cf ?? []);
    return this.repo.page(tx, sc, { sort: q.sort, order: q.order, limit: q.limit, cursor: q.cursor, q: filters.q, owner: filters.owner, source: filters.source, consent: filters.consent, tag: filters.tag }, { cf, memberOf });
  }

  /** `variable:operador[:valor]` → filtro contra la definición del campo. Un campo que no existe o un operador que no corresponde al tipo es un 400. */
  private async resolveCf(tx: TenantTx, raw: readonly string[]): Promise<ResolvedCf[]> {
    if (raw.length === 0) return [];
    const defs = await this.custom.definitionsByKey(tx, 'contact');
    return raw.map((r) => {
      const f = parseCf(r);
      if (!f) throw new ValidationError([{ path: 'cf', code: 'invalid', message: `Filtro de campo no válido: «${r.slice(0, 60)}»` }]);
      const def = defs.get(f.key);
      if (!def) throw new ValidationError([{ path: 'cf', code: 'unknown_field', message: `El campo «${f.key}» no existe o está archivado` }]);
      const bad = checkCfValue(def.type, f.op, f.value);
      if (bad) throw new ValidationError([{ path: 'cf', code: 'invalid', message: bad }]);
      return { definitionId: def.id, type: def.type, op: f.op, value: f.value };
    });
  }

  private async extras(tx: TenantTx, ids: readonly string[]): Promise<Extras> {
    return { custom: await this.custom.valuesFor(tx, 'contact', ids), tags: await this.systemTags.forContacts(tx, ids), capi: await this.repo.lastPurchaseEvents(tx, ids), companies: await this.companies.forContacts(tx, ids) };
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

  private async views(rows: readonly ContactRow[], phones: Map<string, PhoneRow[]>, x: Extras): Promise<ContactView[]> {
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
      custom_fields: x.custom.get(r.id) ?? {},
      tags: x.tags.get(r.id) ?? [],
      companies: x.companies.get(r.id) ?? [],
      attribution: attributionOf(r, x.capi.get(r.id)),
      created_at: iso(r.createdAt),
      updated_at: iso(r.updatedAt),
    }));
  }
}
