import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { conversationParticipants, conversations, Database, messages, queueMembers, queues, type TenantTx } from '../../db';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { OpportunitiesService } from '../opportunities';
import { OrgMembersService, type OrgPerson } from '../organizations';
import { abilities, loadConversation, scopeOf, type ConversationRow, type InboxAccess, type InboxScope } from './inbox.access';
import { InboxService } from './inbox.service';
import type { ConversationStatus, ConversationView } from './inbox.views';
import { MAX_PARTICIPANTS, type ShareDto, type TransferDto } from './sharing.dto';

/** Una persona a la que se puede transferir o con la que se puede compartir, con lo que ayuda a elegir (F10). */
export interface PersonOption {
  id: string;
  name: string;
  role: string;
  /** Conversaciones abiertas que atiende hoy (pendientes, trabajando o esperando al cliente). */
  open_count: number;
  /** ¿Es asesora activa de la cola de esta conversación? Null si la conversación no tiene cola. Fuera de la cola es una advertencia, no un bloqueo. */
  in_queue: boolean | null;
  is_owner: boolean;
  is_self: boolean;
  /** Si ya tiene acceso como colaboradora, con qué permiso. */
  collaborator: 'reply' | 'view' | null;
}
export interface TransferOptions {
  items: PersonOption[];
  queue: { id: string; name: string } | null;
  can: { transfer: boolean; share: boolean };
}
export interface TransferResult {
  id: string;
  status: ConversationStatus;
  owner: { id: string; name: string };
  /** ¿Quien la transfirió sigue viéndola? (Si no, la pantalla vuelve a la lista.) */
  still_visible: boolean;
}
export interface RevokeResult {
  id: string;
  user_id: string;
  revoked: true;
  still_visible: boolean;
}

const OPEN = ['pending', 'working', 'waiting'] as const;
const permText = (p: 'reply' | 'view'): string => (p === 'reply' ? 'puede responder' : 'solo ver y dejar notas');

/**
 * Transferir y compartir una conversación (M5.5a, ADR-14/50; flujo F10).
 *  - **Transferir** cambia el dueño: la conversación queda a nombre de la otra persona como «pendiente» (debe aceptarla) y con ella se mueve el lead (el contacto y sus
 *    oportunidades abiertas que eran del anterior dueño). Puede dejar al anterior como colaborador. Lo hace su dueño o quien ve todo (también sobre una sin asignar, que así queda
 *    asignada). No consume el tope diario de la cola.
 *  - **Compartir** da acceso a otra persona SIN cambiar el dueño, con permiso de responder (cuando el dueño ya la aceptó) o solo de ver y dejar notas. Repetirlo con otro permiso lo cambia.
 *  - **Revocar** quita el acceso: lo hace el dueño, quien ve todo o la propia persona.
 * Todo queda en la auditoría y como NOTA INTERNA automática en el historial (nunca sale al cliente). Las personas salen de la identidad, leída ANTES de la transacción.
 */
@Injectable()
export class SharingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(InboxService) private readonly inbox: InboxService,
  ) {}

  /** A quién se puede transferir o compartir, con su carga y si está en la cola. Solo para quien puede hacer alguna de las dos cosas con esta conversación. */
  async options(access: InboxAccess, id: string): Promise<TransferOptions> {
    const scope = scopeOf(access);
    const people = await this.members.assignable();
    const data = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, id);
      const can = abilities(scope, c, channel.state, collab);
      if (!can.transfer && !can.share) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación (o un administrador) puede transferirla o compartirla');
      const ids = people.map((p) => p.id);
      const queue = c.queueId ? ((await tx.select({ id: queues.id, name: queues.name }).from(queues).where(eq(queues.id, c.queueId)).limit(1))[0] ?? null) : null;
      const inQueue = new Set(queue ? (await tx.select({ userId: queueMembers.userId }).from(queueMembers).where(and(eq(queueMembers.queueId, queue.id), eq(queueMembers.active, true)))).map((r) => r.userId) : []);
      const open = new Map<string, number>();
      if (ids.length > 0) {
        const rows = await tx
          .select({ userId: conversations.ownerId, n: sql<number>`count(*)::int` })
          .from(conversations)
          .where(and(inArray(conversations.ownerId, ids), inArray(conversations.status, [...OPEN])))
          .groupBy(conversations.ownerId);
        for (const r of rows) if (r.userId) open.set(r.userId, r.n);
      }
      const collabs = new Map((await tx.select({ userId: conversationParticipants.userId, permission: conversationParticipants.permission }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, id), isNull(conversationParticipants.revokedAt)))).map((r) => [r.userId, r.permission === 'reply' ? ('reply' as const) : ('view' as const)]));
      return { c, can, queue, inQueue, open, collabs };
    });
    const items: PersonOption[] = people.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      open_count: data.open.get(p.id) ?? 0,
      in_queue: data.queue ? data.inQueue.has(p.id) : null,
      is_owner: p.id === data.c.ownerId,
      is_self: p.id === scope.userId,
      collaborator: data.collabs.get(p.id) ?? null,
    }));
    return { items, queue: data.queue, can: { transfer: data.can.transfer, share: data.can.share } };
  }

  async transfer(access: InboxAccess, id: string, dto: TransferDto): Promise<TransferResult> {
    const scope = scopeOf(access);
    if (!scope.canTransfer) throw new ForbiddenError();
    const { people, names } = await this.people(scope);
    const target = people.get(dto.to_user_id);
    if (!target) {
      await this.mustSee(scope, id); // lo que la persona no ve responde 404 antes que cualquier otro motivo (también con un destino de otra empresa)
      throw new AppError(400, 'TRANSFER_TARGET_NOT_ALLOWED', 'Esa persona no puede recibir conversaciones en esta empresa');
    }
    const nameOf = (uid: string): string => people.get(uid)?.name ?? names.get(uid)?.name ?? 'otra persona';
    const now = new Date();
    const prev = await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, id, true);
      if (!abilities(scope, c, channel.state, collab).transfer) throw this.notAllowed(c, 'transferirla');
      if (c.ownerId === target.id) throw new ConflictError('ALREADY_OWNER', 'Esa persona ya es quien tiene asignada la conversación');
      const before = c.ownerId;
      // Quien recibe la conversación deja de ser colaborador: ahora es la dueña
      await this.revokeActive(tx, id, target.id, scope.userId, now);
      await tx.update(conversations).set({ ownerId: target.id, assignedAt: now, assignmentSource: 'manual', status: 'pending', updatedAt: now }).where(eq(conversations.id, id));
      await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'owner_id', oldValue: before, newValue: target.id });
      if (c.status !== 'pending') await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'status', oldValue: c.status, newValue: 'pending' });
      // El anterior dueño puede seguir como colaborador (solo si todavía es de la empresa)
      const keep = dto.keep_as && before && people.has(before) ? dto.keep_as : null;
      if (keep && before) await this.setParticipant(tx, id, before, keep, scope.userId, now);
      // El lead se mueve con la conversación
      await this.contacts.reassignOwner(tx, c.contactId, target.id);
      await this.opportunities.reassignOpenOwner(tx, c.contactId, before, target.id);
      const actor = nameOf(scope.userId);
      let text = before === null ? `${actor} asignó la conversación a ${target.name}.` : before === scope.userId ? `${actor} transfirió la conversación a ${target.name}.` : `${actor} transfirió la conversación de ${nameOf(before)} a ${target.name}.`;
      if (keep && before) text += ` ${nameOf(before)} sigue como colaborador (${permText(keep)}).`;
      if (dto.note) text += ` Nota: ${dto.note}`;
      await this.systemNote(tx, c, scope.userId, text, now);
      return { before, kept: keep !== null };
    });
    return { id, status: 'pending', owner: { id: target.id, name: target.name }, still_visible: scope.viewAll || scope.userId === target.id || (prev.kept && prev.before === scope.userId) };
  }

  async share(access: InboxAccess, id: string, dto: ShareDto): Promise<ConversationView> {
    const scope = scopeOf(access);
    if (!scope.canShare) throw new ForbiddenError();
    const { people, names } = await this.people(scope);
    const target = people.get(dto.user_id);
    if (!target) {
      await this.mustSee(scope, id);
      throw new AppError(400, 'SHARE_TARGET_NOT_ALLOWED', 'Esa persona no puede recibir conversaciones en esta empresa');
    }
    const actor = people.get(scope.userId)?.name ?? names.get(scope.userId)?.name ?? 'Alguien';
    const now = new Date();
    await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, id, true);
      if (!abilities(scope, c, channel.state, collab).share) throw this.notAllowed(c, 'compartirla');
      if (c.ownerId === target.id) throw new ConflictError('ALREADY_OWNER', 'Esa persona ya es quien tiene asignada la conversación');
      const [existing] = await tx.select({ permission: conversationParticipants.permission }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, id), eq(conversationParticipants.userId, target.id), isNull(conversationParticipants.revokedAt))).for('update').limit(1);
      if (existing?.permission === dto.permission) return; // ya la tenía así: no cambia nada ni deja nota
      if (!existing) {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, id), isNull(conversationParticipants.revokedAt)));
        if ((n?.n ?? 0) >= MAX_PARTICIPANTS) throw new ConflictError('PARTICIPANT_LIMIT', `Una conversación admite hasta ${MAX_PARTICIPANTS} colaboradores: quita el acceso a alguien para compartirla con otra persona`);
      }
      await this.setParticipant(tx, id, target.id, dto.permission, scope.userId, now);
      let text = existing ? `${actor} cambió el acceso de ${target.name}: ${permText(dto.permission)}.` : `${actor} compartió la conversación con ${target.name} (${permText(dto.permission)}).`;
      if (dto.note) text += ` Nota: ${dto.note}`;
      await this.systemNote(tx, c, scope.userId, text, now);
    });
    return this.inbox.get(access, id);
  }

  /** Quita el acceso de un colaborador. Lo hace el dueño, quien ve todo o la propia persona (dejar de participar). */
  async revoke(access: InboxAccess, id: string, userId: string): Promise<RevokeResult> {
    const scope = scopeOf(access);
    if (!scope.canShare) throw new ForbiddenError();
    const names = await this.members.labels([scope.userId, userId]);
    const nameOf = (uid: string): string => names.get(uid)?.name ?? 'otra persona';
    const now = new Date();
    const self = userId === scope.userId;
    const owner = await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, id, true);
      const [row] = await tx.select({ permission: conversationParticipants.permission }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, id), eq(conversationParticipants.userId, userId), isNull(conversationParticipants.revokedAt))).for('update').limit(1);
      if (!row) throw new NotFoundError();
      if (!(c.ownerId === scope.userId || scope.viewAll || self)) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación, un administrador o la propia persona pueden quitar el acceso');
      await this.revokeActive(tx, id, userId, scope.userId, now);
      await this.systemNote(tx, c, scope.userId, self ? `${nameOf(userId)} dejó de participar en la conversación.` : `${nameOf(scope.userId)} quitó el acceso de ${nameOf(userId)}.`, now);
      return c.ownerId;
    });
    return { id, user_id: userId, revoked: true, still_visible: scope.viewAll || owner === scope.userId || !self };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Las personas que pueden recibir trabajo (por id) y el nombre de quien actúa aunque no esté entre ellas (una agencia o el soporte). Identidad: antes de la transacción. */
  private async people(scope: InboxScope): Promise<{ people: Map<string, OrgPerson>; names: Map<string, { id: string; name: string }> }> {
    const list = await this.members.assignable();
    const people = new Map(list.map((p) => [p.id, p]));
    return { people, names: people.has(scope.userId) ? new Map() : await this.members.labels([scope.userId]) };
  }

  /** 404 si la persona no ve la conversación (la misma regla que todo el Inbox). */
  private async mustSee(scope: InboxScope, id: string): Promise<void> {
    await this.db.withTenant((tx) => loadConversation(tx, scope, id));
  }

  /** Por qué no se puede, con el mensaje que ve la persona. */
  private notAllowed(c: Pick<ConversationRow, 'status'>, what: string): Error {
    if (c.status === 'closed') return new ConflictError('CONVERSATION_CLOSED', 'La conversación está finalizada');
    if (c.status === 'unassigned' && what === 'compartirla') return new ConflictError('CONVERSATION_UNASSIGNED', 'La conversación aún no tiene asesor: asígnala antes de compartirla');
    return new ForbiddenError('NOT_OWNER', `Solo quien tiene asignada la conversación (o un administrador) puede ${what}`);
  }

  /** Da o cambia el acceso vigente de una persona (un solo acceso vigente por persona y conversación), con su auditoría. */
  private async setParticipant(tx: TenantTx, conversationId: string, userId: string, permission: 'reply' | 'view', actor: string, now: Date): Promise<void> {
    const [cur] = await tx.select({ id: conversationParticipants.id, permission: conversationParticipants.permission }).from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId), isNull(conversationParticipants.revokedAt))).for('update').limit(1);
    if (cur) {
      await tx.update(conversationParticipants).set({ permission }).where(eq(conversationParticipants.id, cur.id));
      await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'participant', oldValue: { user_id: userId, permission: cur.permission }, newValue: { user_id: userId, permission } });
      return;
    }
    await tx.insert(conversationParticipants).values({ conversationId, userId, permission, addedBy: actor, addedAt: now });
    await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'participant', oldValue: null, newValue: { user_id: userId, permission } });
  }

  /** Revoca el acceso vigente de una persona, si lo tiene (no falla si no). */
  private async revokeActive(tx: TenantTx, conversationId: string, userId: string, actor: string, now: Date): Promise<void> {
    const rows = await tx
      .update(conversationParticipants)
      .set({ revokedAt: now, revokedBy: actor })
      .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, userId), isNull(conversationParticipants.revokedAt)))
      .returning({ permission: conversationParticipants.permission });
    if (rows[0]) await writeAudit(tx, { entityType: 'conversation', entityId: conversationId, field: 'participant', oldValue: { user_id: userId, permission: rows[0].permission }, newValue: null });
  }

  /** Aviso automático en el historial: nota INTERNA del sistema (nunca sale al cliente, no mueve la conversación). */
  private async systemNote(tx: TenantTx, c: Pick<ConversationRow, 'id' | 'channelAccountId'>, actor: string, text: string, now: Date): Promise<void> {
    await tx.insert(messages).values({ conversationId: c.id, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: text.slice(0, 2000), status: 'internal', sentAt: now, createdBy: actor });
  }
}

