import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { contactFiltersSchema } from './contact-filters';
import { ContactListsRepository, type ListRow } from './contact-lists.repository';
import { MAX_LIST_MEMBERS, MAX_LISTS_PER_OWNER, type CreateListDto, type MembersDto, type UpdateListDto } from './contact-lists.dto';
import { ContactsRepository, type Scope } from './contacts.repository';

export interface ListView {
  id: string;
  name: string;
  kind: 'dynamic' | 'fixed';
  filters: Record<string, unknown>;
  columns: string[] | null;
  sort: { key: string; order: 'asc' | 'desc' } | null;
  shared: boolean;
  /** ¿Es mía? (si no, es una compartida por otra persona). */
  mine: boolean;
  /** Contactos de una lista fija que YO puedo ver; null en las dinámicas (se calculan al abrirlas). */
  member_count: number | null;
  created_at: string;
  updated_at: string;
}

const AUDIT = 'contact_list';
const view = (r: ListRow, userId: string, count: number | null): ListView => ({
  id: r.id,
  name: r.name,
  kind: r.kind as ListView['kind'],
  filters: r.filters,
  columns: r.columns ?? null,
  sort: r.sort ?? null,
  shared: r.shared,
  mine: r.ownerId === userId,
  member_count: r.kind === 'fixed' ? (count ?? 0) : null,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

/**
 * Listas de contactos (M3.4, ADR-46). Personales por defecto; compartir exige `contacts.view_all`. Se ve la propia o una compartida; se cambia la propia
 * o una compartida con `contacts.view_all`. Una lista NUNCA amplía lo que la persona puede ver: el alcance del ADR-43 manda siempre.
 */
@Injectable()
export class ContactListsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactListsRepository) private readonly repo: ContactListsRepository,
    @Inject(ContactsRepository) private readonly contacts: ContactsRepository,
  ) {}

  async list(viewAll: boolean): Promise<{ items: ListView[] }> {
    const sc = this.scope(viewAll);
    return this.db.withTenant(async (tx) => {
      const rows = await this.repo.visible(tx, sc.userId);
      const counts = await this.repo.visibleCounts(tx, sc, rows.filter((r) => r.kind === 'fixed').map((r) => r.id));
      return { items: rows.map((r) => view(r, sc.userId, counts.get(r.id) ?? 0)) };
    });
  }

  async create(viewAll: boolean, input: CreateListDto): Promise<ListView> {
    const sc = this.scope(viewAll);
    if (input.shared && !sc.viewAll) throw this.noShare();
    const row = await this.db
      .withTenant(async (tx) => {
        if ((await this.repo.countOwned(tx, sc.userId)) >= MAX_LISTS_PER_OWNER) throw new ConflictError('LIST_LIMIT', `Se alcanzó el máximo de ${MAX_LISTS_PER_OWNER} listas. Borra alguna para crear otra`);
        const created = await this.repo.insert(tx, {
          name: input.name,
          kind: input.kind,
          filters: input.filters ?? {},
          columns: input.columns ?? null,
          sort: input.sort ?? null,
          ownerId: sc.userId,
          shared: input.shared ?? false,
        });
        let added = 0;
        if (input.kind === 'fixed' && input.contact_ids) added = await this.repo.addMembers(tx, created.id, await this.contacts.visibleIds(tx, sc, input.contact_ids), sc.userId);
        await writeAudit(tx, { entityType: AUDIT, entityId: created.id, newValue: { name: created.name, kind: created.kind, shared: created.shared, members: added }, source: 'manual' });
        return { created, added };
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return view(row.created, sc.userId, row.added);
  }

  async update(viewAll: boolean, id: string, input: UpdateListDto): Promise<ListView> {
    const sc = this.scope(viewAll);
    if (input.shared && !sc.viewAll) throw this.noShare();
    const out = await this.db
      .withTenant(async (tx) => {
        const cur = await this.editable(tx, sc, id);
        const set: Partial<ListRow> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (input.name !== undefined && input.name !== cur.name) {
          set.name = input.name;
          changes.push({ field: 'name', oldValue: cur.name, newValue: input.name });
        }
        if (input.shared !== undefined && input.shared !== cur.shared) {
          set.shared = input.shared;
          changes.push({ field: 'shared', oldValue: cur.shared, newValue: input.shared });
        }
        if (input.filters !== undefined) {
          if (cur.kind !== 'dynamic') throw new ConflictError('LIST_NOT_DYNAMIC', 'Solo las listas dinámicas tienen filtros');
          if (JSON.stringify(input.filters) !== JSON.stringify(cur.filters)) {
            set.filters = input.filters;
            changes.push({ field: 'filters', oldValue: cur.filters, newValue: input.filters });
          }
        }
        if (input.columns !== undefined && JSON.stringify(input.columns) !== JSON.stringify(cur.columns)) {
          set.columns = input.columns;
          changes.push({ field: 'columns', oldValue: cur.columns, newValue: input.columns });
        }
        if (input.sort !== undefined && JSON.stringify(input.sort) !== JSON.stringify(cur.sort)) {
          set.sort = input.sort;
          changes.push({ field: 'sort', oldValue: cur.sort, newValue: input.sort });
        }
        const row = changes.length === 0 ? cur : await this.repo.update(tx, id, set);
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        const counts = await this.repo.visibleCounts(tx, sc, row.kind === 'fixed' ? [row.id] : []);
        return { row, count: counts.get(row.id) ?? 0 };
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return view(out.row, sc.userId, out.count);
  }

  /** Borrado lógico: los contactos no se tocan. */
  async remove(viewAll: boolean, id: string): Promise<{ id: string; deleted: true }> {
    const sc = this.scope(viewAll);
    await this.db.withTenant(async (tx) => {
      const cur = await this.editable(tx, sc, id);
      await this.repo.update(tx, id, { deletedAt: new Date() });
      await writeAudit(tx, { entityType: AUDIT, entityId: id, oldValue: { name: cur.name, kind: cur.kind }, source: 'manual' });
    });
    return { id, deleted: true };
  }

  /** Agrega contactos a una lista FIJA. Solo entran los que la persona puede ver; el resto se ignora. */
  async addMembers(viewAll: boolean, id: string, input: MembersDto): Promise<{ added: number; skipped: number }> {
    const sc = this.scope(viewAll);
    return this.db.withTenant(async (tx) => {
      const list = await this.editable(tx, sc, id);
      if (list.kind !== 'fixed') throw new ConflictError('LIST_NOT_FIXED', 'Solo las listas fijas tienen contactos elegidos a mano');
      const visible = await this.contacts.visibleIds(tx, sc, input.contact_ids);
      if ((await this.repo.memberTotal(tx, id)) + visible.length > MAX_LIST_MEMBERS) throw new ConflictError('LIST_FULL', `Una lista fija admite hasta ${MAX_LIST_MEMBERS} contactos`);
      const added = await this.repo.addMembers(tx, id, visible, sc.userId);
      if (added > 0) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'members_added', newValue: added, source: 'manual' });
      return { added, skipped: input.contact_ids.length - added };
    });
  }

  async removeMembers(viewAll: boolean, id: string, input: MembersDto): Promise<{ removed: number }> {
    const sc = this.scope(viewAll);
    return this.db.withTenant(async (tx) => {
      const list = await this.editable(tx, sc, id);
      if (list.kind !== 'fixed') throw new ConflictError('LIST_NOT_FIXED', 'Solo las listas fijas tienen contactos elegidos a mano');
      // Solo puede quitar los que ve (un asesor no toca los contactos ajenos de una lista compartida)
      const removed = await this.repo.removeMembers(tx, id, await this.contacts.visibleIds(tx, sc, input.contact_ids));
      if (removed > 0) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'members_removed', newValue: removed, source: 'manual' });
      return { removed };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** La lista (bloqueada) si la persona puede VERLA; 404 si no existe o no es suya ni compartida; 403 si la ve pero no puede cambiarla. */
  private async editable(tx: Parameters<ContactListsRepository['visibleById']>[0], sc: Scope, id: string): Promise<ListRow> {
    const row = await this.repo.visibleById(tx, sc.userId, id, true);
    if (!row) throw new NotFoundError();
    if (row.ownerId !== sc.userId && !(row.shared && sc.viewAll)) throw new ForbiddenError('LIST_NOT_YOURS', 'Esta lista es de otra persona: solo puedes usarla');
    return row;
  }

  private scope(viewAll: boolean): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll };
  }

  private noShare(): ForbiddenError {
    return new ForbiddenError('LIST_SHARE_NOT_ALLOWED', 'Solo quien ve todos los contactos puede compartir listas');
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'contact_lists_org_owner_name_uq' ? new ConflictError('LIST_EXISTS', 'Ya tienes una lista con ese nombre') : undefined;
  }
}

/** Filtros guardados de una lista, validados otra vez (por si el esquema de filtros cambió desde que se guardaron). */
export const savedFilters = (row: Pick<ListRow, 'filters'>) => {
  const r = contactFiltersSchema.safeParse(row.filters);
  return r.success ? r.data : {};
};
