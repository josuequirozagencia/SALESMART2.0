import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Database, notes, type TenantTx } from '../../db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgMembersService } from '../organizations';
import { CompaniesService } from './companies.service';
import type { ListNotesQuery, NoteBodyDto } from './crm-extras.dto';
import { ContactsRepository, type Scope } from './contacts.repository';
import type { ContactScope } from './contacts.service';

type NoteRow = typeof notes.$inferSelect;

/** Quién consulta: su alcance sobre los contactos y si puede borrar notas ajenas (`contacts.delete`). */
export interface NoteActor extends ContactScope {
  canDelete: boolean;
}
export type NoteTarget = { kind: 'contact'; id: string } | { kind: 'company'; id: string };

export interface NoteView {
  id: string;
  body: string;
  author: { id: string; name: string };
  edited_at: string | null;
  created_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

const AUDIT = 'note';

/**
 * Notas internas de un contacto o una empresa (M3.6, ADR-48). Solo del equipo: nada de aquí sale hacia el cliente. Se ven con el alcance del contacto;
 * las edita solo quien las escribió y las borra quien las escribió o `contacts.delete`. La auditoría guarda la longitud, nunca el texto.
 */
@Injectable()
export class NotesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsRepository) private readonly contactsRepo: ContactsRepository,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  async list(actor: NoteActor, target: NoteTarget, q: ListNotesQuery): Promise<{ items: NoteView[]; next_cursor: string | null }> {
    const sc = this.scope(actor);
    const page = await this.db.withTenant(async (tx) => {
      await this.assertTarget(tx, sc, target);
      const where = [isNull(notes.deletedAt), target.kind === 'contact' ? eq(notes.contactId, target.id) : eq(notes.companyId, target.id)];
      if (q.cursor) {
        const c = this.decode(q.cursor);
        where.push(sql`(${notes.createdAt}, ${notes.id}) < (${c.t}::timestamptz, ${c.i}::uuid)`);
      }
      const rows = await tx
        .select({ row: notes, key: sql<string>`${notes.createdAt}::text` })
        .from(notes)
        .where(and(...where))
        .orderBy(desc(notes.createdAt), desc(notes.id))
        .limit(q.limit + 1);
      const rest = rows.slice(0, q.limit);
      const last = rest.at(-1);
      return { rows: rest.map((r) => r.row), next: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ t: last.key, i: last.row.id })).toString('base64url') : null };
    });
    const views = await this.views(actor, sc, page.rows);
    return { items: views, next_cursor: page.next };
  }

  async create(actor: NoteActor, target: NoteTarget, input: NoteBodyDto): Promise<NoteView> {
    const sc = this.scope(actor);
    const row = await this.db.withTenant(async (tx) => {
      await this.assertTarget(tx, sc, target);
      const [created] = await tx
        .insert(notes)
        .values({ body: input.body, authorId: sc.userId, ...(target.kind === 'contact' ? { contactId: target.id } : { companyId: target.id }) })
        .returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: created!.id, newValue: { ...(target.kind === 'contact' ? { contact_id: target.id } : { company_id: target.id }), length: input.body.length }, source: 'manual' });
      return created!;
    });
    return (await this.views(actor, sc, [row]))[0]!;
  }

  async update(actor: NoteActor, id: string, input: NoteBodyDto): Promise<NoteView> {
    const sc = this.scope(actor);
    const row = await this.db.withTenant(async (tx) => {
      const cur = await this.lockOwned(tx, sc, id);
      if (cur.authorId !== sc.userId) throw new ForbiddenError('NOTE_NOT_YOURS', 'Solo quien escribió la nota puede editarla');
      if (cur.body === input.body) return cur;
      const now = new Date();
      const [updated] = await tx.update(notes).set({ body: input.body, editedAt: now, updatedAt: now }).where(eq(notes.id, id)).returning();
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'body', oldValue: { length: cur.body.length }, newValue: { length: input.body.length }, source: 'manual' });
      return updated!;
    });
    return (await this.views(actor, sc, [row]))[0]!;
  }

  async remove(actor: NoteActor, id: string): Promise<{ id: string; deleted: true }> {
    const sc = this.scope(actor);
    return this.db.withTenant(async (tx) => {
      const cur = await this.lockOwned(tx, sc, id);
      if (cur.authorId !== sc.userId && !actor.canDelete) throw new ForbiddenError('NOTE_NOT_YOURS', 'Solo quien escribió la nota o un administrador puede borrarla');
      const now = new Date();
      await tx.update(notes).set({ deletedAt: now, updatedAt: now }).where(eq(notes.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** La nota vigente, bloqueada, cuyo contacto o empresa la persona puede ver; si no, 404 uniforme. */
  private async lockOwned(tx: TenantTx, sc: Scope, id: string): Promise<NoteRow> {
    const [row] = await tx.select().from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    await this.assertTarget(tx, sc, row.contactId ? { kind: 'contact', id: row.contactId } : { kind: 'company', id: row.companyId! });
    return row;
  }

  private async assertTarget(tx: TenantTx, sc: Scope, target: NoteTarget): Promise<void> {
    if (target.kind === 'contact') {
      if ((await this.contactsRepo.visibleIds(tx, sc, [target.id])).length === 0) throw new NotFoundError();
    } else {
      await this.companies.byId(tx, target.id);
    }
  }

  private async views(actor: NoteActor, sc: Scope, rows: readonly NoteRow[]): Promise<NoteView[]> {
    const labels = await this.members.labels(rows.map((r) => r.authorId));
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      author: labels.get(r.authorId) ?? { id: r.authorId, name: 'Persona desconocida' },
      edited_at: r.editedAt ? r.editedAt.toISOString() : null,
      created_at: r.createdAt.toISOString(),
      can_edit: r.authorId === sc.userId,
      can_delete: r.authorId === sc.userId || actor.canDelete,
    }));
  }

  private decode(raw: string): { t: string; i: string } {
    try {
      const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
      if (typeof c.t === 'string' && typeof c.i === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/.test(c.t) && /^[0-9a-f-]{36}$/i.test(c.i)) return { t: c.t, i: c.i };
    } catch {
      /* cae al error de abajo */
    }
    throw new ValidationError([{ path: 'cursor', code: 'invalid_cursor', message: 'El cursor no es válido' }]);
  }

  private scope(s: ContactScope): Scope {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    return { userId, viewAll: s.viewAll };
  }
}
