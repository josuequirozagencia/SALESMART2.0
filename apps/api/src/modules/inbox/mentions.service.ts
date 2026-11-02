import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { conversationParticipants, conversations, Database, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';
import { OrgMembersService, type OrgPerson } from '../organizations';
import { loadConversation, scopeOf, type InboxAccess } from './inbox.access';

/** Hasta cuántas personas se pueden mencionar en una nota. */
export const MAX_MENTIONS = 10;

/** Lo que se lee de identidad ANTES de abrir la transacción de negocio: quién es de la empresa, quién ve todo y quién puede leer el Inbox. */
export interface MentionDirectory {
  people: OrgPerson[];
  viewAll: ReadonlySet<string>;
  readers: ReadonlySet<string>;
}

export interface MentionOption {
  id: string;
  name: string;
  /** ¿Ya puede abrir esta conversación? Quien no puede se muestra desactivado: mencionar NO da acceso (ADR-57 #3). */
  can_view: boolean;
}

/**
 * Menciones «@» en notas internas (F1, ADR-57). Quién se puede mencionar en una conversación = las personas activas de la empresa que YA pueden abrirla: su dueño, quienes la comparten y
 * quienes ven todo, siempre con permiso de leer el Inbox (la misma regla que los avisos en vivo del Inbox). Mencionar nunca amplía quién ve a un cliente. Lo que se lee de identidad se
 * lee antes de la transacción de negocio (`directory`).
 */
@Injectable()
export class MentionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  async directory(): Promise<MentionDirectory> {
    const [people, viewAll, readers] = await Promise.all([this.members.assignable(), this.members.withPermission('inbox.view_all'), this.members.withPermission('inbox.read')]);
    return { people, viewAll: new Set(viewAll), readers: new Set(readers) };
  }

  /** Quién ve esta conversación por ser su dueño o colaborador vigente (sin contar a quien ve todo). Dentro de la transacción de negocio. */
  private async seers(tx: TenantTx, conversationId: string, ownerId: string | null): Promise<Set<string>> {
    const rows = await tx.select({ userId: conversationParticipants.userId }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, conversationId), isNull(conversationParticipants.revokedAt)));
    const set = new Set(rows.map((r) => r.userId));
    if (ownerId) set.add(ownerId);
    return set;
  }

  private canView(dir: MentionDirectory, seers: ReadonlySet<string>, userId: string): boolean {
    return dir.readers.has(userId) && (seers.has(userId) || dir.viewAll.has(userId));
  }

  /** Las personas que se pueden mencionar en esta conversación (sin quien consulta), las que ya la ven primero. 404 si la persona no puede ver la conversación. */
  async options(access: InboxAccess, conversationId: string): Promise<{ items: MentionOption[] }> {
    const scope = scopeOf(access);
    const dir = await this.directory();
    const seers = await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, conversationId);
      return this.seers(tx, conversationId, c.ownerId);
    });
    const items = dir.people.filter((p) => p.id !== scope.userId).map((p) => ({ id: p.id, name: p.name, can_view: this.canView(dir, seers, p.id) }));
    items.sort((a, b) => Number(b.can_view) - Number(a.can_view) || a.name.localeCompare(b.name, 'es'));
    return { items };
  }

  /**
   * Valida las menciones de una nota dentro de su transacción: sin repetir, hasta `MAX_MENTIONS`, cada una persona activa de la empresa que ya puede abrir la conversación. Devuelve los ids
   * ordenados y sin duplicados. Cualquier otra cosa responde 400 con el detalle (no se guarda la nota).
   */
  async validate(tx: TenantTx, c: Pick<typeof conversations.$inferSelect, 'id' | 'ownerId'>, ids: readonly string[], dir: MentionDirectory): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_MENTIONS) throw new ValidationError([{ path: 'mentions', code: 'too_many', message: `Puedes mencionar hasta ${MAX_MENTIONS} personas en una nota` }]);
    if (unique.length === 0) return [];
    const known = new Set(dir.people.map((p) => p.id));
    const seers = await this.seers(tx, c.id, c.ownerId);
    for (const id of unique) {
      if (!known.has(id)) throw new ValidationError([{ path: 'mentions', code: 'not_in_team', message: 'Una de las personas mencionadas no es del equipo' }]);
      if (!this.canView(dir, seers, id)) throw new ValidationError([{ path: 'mentions', code: 'cannot_view', message: 'Una de las personas mencionadas no ve esta conversación: compártela primero' }]);
    }
    return unique;
  }
}
