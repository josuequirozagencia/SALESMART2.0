import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { auditLogs, conversationParticipants, Database, queues } from '../../db';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { byPerson, kindOf, type AssignmentKind } from './assignment-steps';
import { loadConversation, scopeOf, type InboxAccess } from './inbox.access';

/** Cuántos pasos del historial se devuelven como mucho. */
export const MAX_ASSIGNMENT_STEPS = 100;

export interface PersonRef {
  id: string;
  name: string;
}
export interface AssignmentStep {
  at: string;
  kind: AssignmentKind;
  from: PersonRef | null;
  to: PersonRef | null;
  by: PersonRef | null;
}
export interface AssignmentView {
  owner: PersonRef | null;
  assigned_at: string | null;
  /** Cómo llegó a quien la tiene hoy (null si no hay dueño o no quedó registro). */
  how: AssignmentKind | null;
  how_by: PersonRef | null;
  queue: { id: string; name: string } | null;
  shared: Array<{ user: PersonRef; permission: 'reply' | 'view'; added_by: PersonRef | null; added_at: string | null }>;
  /** Del más reciente al más antiguo. */
  history: AssignmentStep[];
  /** `own`: solo los pasos en los que participa quien consulta. */
  history_scope: 'all' | 'own';
  /** Zona horaria de la empresa, para mostrar las fechas. */
  time_zone: string;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * «Asignación» de una conversación (V24): quién la tiene y cómo le llegó, con quién está compartida y quién la tuvo antes. La visibilidad es la de siempre (quien no la ve, 404).
 * Sin `inbox.view_all`, la persona ve el dueño, los nombres y permisos de los colaboradores y SOLO sus propios pasos: no quién compartió con otros ni cuándo. Nunca salen correos;
 * quien actúa desde fuera de la empresa se muestra como «Soporte» o «Agencia».
 */
@Injectable()
export class AssignmentViewService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async get(access: InboxAccess, id: string): Promise<AssignmentView> {
    const scope = scopeOf(access);
    const timeZone = (await this.directory.current()).timeZone;
    const data = await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, id);
      const [queue] = c.queueId ? await tx.select({ id: queues.id, name: queues.name }).from(queues).where(eq(queues.id, c.queueId)).limit(1) : [];
      const shared = await tx
        .select({ userId: conversationParticipants.userId, permission: conversationParticipants.permission, addedBy: conversationParticipants.addedBy, addedAt: conversationParticipants.addedAt })
        .from(conversationParticipants)
        .where(and(eq(conversationParticipants.conversationId, id), isNull(conversationParticipants.revokedAt)))
        .orderBy(asc(conversationParticipants.addedAt), asc(conversationParticipants.id));
      const changes = await tx
        .select({ from: auditLogs.oldValue, to: auditLogs.newValue, actorId: auditLogs.actorUserId, actingAs: auditLogs.actingAs, source: auditLogs.source, at: auditLogs.at })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'conversation'), eq(auditLogs.entityId, id), eq(auditLogs.field, 'owner_id')))
        .orderBy(asc(auditLogs.at), asc(auditLogs.id));
      return { c, queue: queue ?? null, shared, changes };
    });

    const steps = data.changes
      .map((r) => {
        const change = { from: idOf(r.from), to: idOf(r.to), actorId: r.actorId, source: r.source };
        const kind = kindOf(change);
        return { ...change, kind, at: r.at, actorId: byPerson(kind) ? r.actorId : null, actingAs: r.actingAs };
      })
      .reverse();
    const ownerId = data.c.ownerId;
    const current = ownerId ? steps.find((s) => s.to === ownerId) : undefined;
    const involvesMe = (s: (typeof steps)[number]): boolean => s.from === scope.userId || s.to === scope.userId;
    const visible = (scope.viewAll ? steps : steps.filter(involvesMe)).slice(0, MAX_ASSIGNMENT_STEPS);
    const showCurrentBy = current !== undefined && (scope.viewAll || involvesMe(current));

    const ids = new Set<string>();
    const add = (x: string | null | undefined): void => {
      if (x) ids.add(x);
    };
    add(ownerId);
    for (const s of data.shared) {
      add(s.userId);
      add(s.addedBy);
    }
    for (const s of visible) {
      add(s.from);
      add(s.to);
      add(s.actorId);
    }
    if (showCurrentBy) add(current.actorId);
    const labels = await this.members.labels([...ids]);
    // `labels` cae al correo cuando la persona no tiene nombre: aquí nunca sale un correo
    const who = (uid: string): PersonRef => {
      const name = labels.get(uid)?.name;
      return { id: uid, name: !name ? 'Persona desconocida' : name.includes('@') ? 'Asesor' : name };
    };
    const actor = (s: { actorId: string | null; actingAs: string | null }): PersonRef | null =>
      !s.actorId ? null : s.actingAs === 'super_admin' ? { id: s.actorId, name: 'Soporte' } : s.actingAs === 'agency' ? { id: s.actorId, name: 'Agencia' } : who(s.actorId);

    return {
      owner: ownerId ? who(ownerId) : null,
      assigned_at: ownerId ? (data.c.assignedAt?.toISOString() ?? null) : null,
      how: current?.kind ?? null,
      how_by: showCurrentBy ? actor(current) : null,
      queue: data.queue,
      shared: data.shared.map((s) => {
        const detail = scope.viewAll || s.userId === scope.userId;
        return { user: who(s.userId), permission: s.permission === 'reply' ? 'reply' : 'view', added_by: detail && s.addedBy ? who(s.addedBy) : null, added_at: detail ? s.addedAt.toISOString() : null };
      }),
      history: visible.map((s) => ({ at: s.at.toISOString(), kind: s.kind, from: s.from ? who(s.from) : null, to: s.to ? who(s.to) : null, by: actor(s) })),
      history_scope: scope.viewAll ? 'all' : 'own',
      time_zone: timeZone,
    };
  }
}
