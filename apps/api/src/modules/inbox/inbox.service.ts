import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { channelAccounts, contactPhones, contactTags, contacts, conversationParticipants, conversations, Database, messages, queues, responseTimers, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { likeEscape, OrgDirectoryService, OrgMembersService } from '../organizations';
import { SlaService, type TimerContext } from '../sla';
import { SystemTagsService, type TagView } from '../tags';
import { abilities, channelState, collabColumn, loadConversation, scopeOf, visibleTo, type Collab, type InboxAccess, type InboxScope } from './inbox.access';
import type { InboxTab, ListConversationsQuery, MessagesQuery } from './inbox.dto';
import { conversationView, messageView, type ConversationParts, type ConversationView, type MessageView, type ParticipantView } from './inbox.views';

export interface ConversationList {
  items: ConversationView[];
  next_cursor: string | null;
  /** Solo en la primera página (sin cursor): cuántas conversaciones hay en cada pestaña con los filtros puestos. */
  counts: { working: number; pending: number; closed: number; unread: number } | null;
}

export interface MessageList {
  /** De la más antigua a la más reciente. */
  items: MessageView[];
  /** Para pedir los mensajes más antiguos; null si ya no hay más. */
  next_cursor: string | null;
}

export interface InboxOptions {
  queues: Array<{ id: string; name: string; color: string }>;
  channels: Array<{ id: string; name: string; state: 'active' | 'disabled' }>;
  /** Solo para quien ve todas las conversaciones: a quién se puede filtrar. */
  owners: Array<{ id: string; name: string }>;
  tags: TagView[];
}

/** Hora de la última actividad: la del último mensaje o, si aún no hay, la de creación. */
const ACTIVITY = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
/** Esa hora como texto con microsegundos: el cursor la devuelve EXACTA (un `Date` de JavaScript solo llega a milisegundos). */
const KEY = sql<string>`to_char(${ACTIVITY} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const MSG_KEY = sql<string>`to_char(${messages.sentAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  k: string;
  id: string;
}
const encode = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(raw: string): Cursor {
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch {
    c = {};
  }
  if (typeof c.k !== 'string' || !KEY_RE.test(c.k) || typeof c.id !== 'string' || !UUID_RE.test(c.id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  return { k: c.k, id: c.id };
}

/** Conversaciones con un cronómetro de respuesta ABIERTO que cumple `extra` (la RLS acota por empresa). */
const openTimer = (extra: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM ${responseTimers} t WHERE t.organization_id = ${conversations.organizationId} AND t.conversation_id = ${conversations.id} AND t.stopped_at IS NULL AND ${extra})`;

/** El filtro «SLA»: vencido, en riesgo (faltan `riskMinutes` o menos) o al día (sin cronómetro abierto, o lejos de vencer). */
function slaCondition(kind: 'late' | 'risk' | 'ok', now: Date, riskMinutes: number): SQL {
  const at = now.toISOString();
  const soon = new Date(now.getTime() + riskMinutes * 60_000).toISOString();
  const late = openTimer(sql`t.due_at < ${at}::timestamptz`);
  const risk = openTimer(sql`t.due_at >= ${at}::timestamptz AND t.due_at <= ${soon}::timestamptz`);
  if (kind === 'late') return late;
  if (kind === 'risk') return risk;
  return sql`NOT (${late}) AND NOT (${risk})`;
}

const TAB_STATUSES: Readonly<Record<InboxTab, readonly string[]>> = { working: ['working', 'waiting'], pending: ['pending', 'unassigned'], closed: ['closed'] };

interface Row {
  c: typeof conversations.$inferSelect;
  contactName: string;
  channelName: string;
  channelStatus: string;
  channelDeletedAt: Date | null;
  queueName: string | null;
  queueColor: string | null;
  key: string;
  collab: Collab;
}

/** Lo que la transacción reúne de cada conversación; los nombres (identidad) se ponen después, fuera de ella. */
type Hydrated = Omit<ConversationParts, 'owner' | 'participants'> & { participantRows: Array<{ userId: string; permission: string; addedBy: string | null; addedAt: Date }> };

/**
 * La bandeja de conversaciones (M5.4, ADR-16/50): listado con pestañas, filtros y conteos; detalle; hilo de mensajes; y las acciones de estado (aceptar, tomar,
 * finalizar, marcar como leída). Escribir al cliente y las notas viven en `OutboundService`.
 *  - La EMPRESA sale del TenantContext y la aísla la RLS. Dentro de ella, quien no tiene `inbox.view_all` solo ve las conversaciones que tiene asignadas: lo demás
 *    responde 404 igual que lo inexistente.
 *  - Las conversaciones de un contacto borrado no aparecen.
 *  - Cada cambio de estado o de dueño queda en la auditoría (misma transacción). El texto de los mensajes nunca va a la auditoría.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(SystemTagsService) private readonly tags: SystemTagsService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async list(access: InboxAccess, q: ListConversationsQuery): Promise<ConversationList> {
    const scope = scopeOf(access);
    const now = new Date();
    const ctx: TimerContext = { now, timeZone: (await this.directory.current()).timeZone };
    const cursor = q.cursor ? decode(q.cursor) : null;
    const data = await this.db.withTenant(async (tx) => {
      const slaCtx = { now, riskMinutes: (await this.sla.policy(tx)).riskMinutes };
      const where: SQL[] = [...this.filters(tx, scope, q, slaCtx), this.tabCondition(q.tab)];
      if (q.unread) where.push(sql`${conversations.unreadCount} > 0`);
      if (cursor) where.push(sql`(${ACTIVITY}, ${conversations.id}) < (${cursor.k}::timestamptz, ${cursor.id}::uuid)`);
      const rows = await this.fetchRows(tx, scope, and(...where) as SQL, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const next = rows.length > q.limit ? encode({ k: page[page.length - 1]!.key, id: page[page.length - 1]!.c.id }) : null;
      return { parts: await this.hydrate(tx, scope, page, ctx), next, counts: cursor ? null : await this.counts(tx, scope, q, slaCtx) };
    });
    return { items: await this.views(data.parts, scope, now), next_cursor: data.next, counts: data.counts };
  }

  async get(access: InboxAccess, id: string): Promise<ConversationView> {
    const scope = scopeOf(access);
    const now = new Date();
    const ctx: TimerContext = { now, timeZone: (await this.directory.current()).timeZone };
    const part = await this.db.withTenant(async (tx) => {
      const [row] = await this.fetchRows(tx, scope, and(eq(conversations.id, id), visibleTo(scope), isNull(contacts.deletedAt)) as SQL, 1);
      if (!row) throw new NotFoundError();
      return (await this.hydrate(tx, scope, [row], ctx))[0]!;
    });
    return (await this.views([part], scope, now))[0]!;
  }

  /** Mensajes y notas de la conversación, los más recientes primero por página (el arreglo sale de más antiguo a más reciente). */
  async messages(access: InboxAccess, id: string, q: MessagesQuery): Promise<MessageList> {
    const scope = scopeOf(access);
    const cursor = q.cursor ? decode(q.cursor) : null;
    const data = await this.db.withTenant(async (tx) => {
      await loadConversation(tx, scope, id);
      const where: SQL[] = [eq(messages.conversationId, id)];
      if (cursor) where.push(sql`(${messages.sentAt}, ${messages.id}) < (${cursor.k}::timestamptz, ${cursor.id}::uuid)`);
      const rows = await tx
        .select({ m: messages, key: MSG_KEY })
        .from(messages)
        .where(and(...where))
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const next = rows.length > q.limit ? encode({ k: page[page.length - 1]!.key, id: page[page.length - 1]!.m.id }) : null;
      return { page: page.map((r) => r.m).reverse(), next };
    });
    const authors = await this.members.labels(data.page.map((m) => m.createdBy).filter((x): x is string => x !== null));
    return { items: data.page.map((m) => messageView(m, m.createdBy ? (authors.get(m.createdBy) ?? { id: m.createdBy, name: 'Persona desconocida' }) : null)), next_cursor: data.next };
  }

  /** Lo que la pantalla necesita para sus filtros. */
  async options(access: InboxAccess): Promise<InboxOptions> {
    const scope = scopeOf(access);
    const base = await this.db.withTenant(async (tx) => ({
      queues: await tx.select({ id: queues.id, name: queues.name, color: queues.color }).from(queues).where(isNull(queues.deletedAt)).orderBy(asc(queues.name), asc(queues.id)),
      channels: await tx.select({ id: channelAccounts.id, name: channelAccounts.name, status: channelAccounts.status }).from(channelAccounts).where(isNull(channelAccounts.deletedAt)).orderBy(asc(channelAccounts.name), asc(channelAccounts.id)),
    }));
    const tagList = (await this.tags.list()).items;
    const owners = scope.viewAll ? (await this.members.assignable()).map((p) => ({ id: p.id, name: p.name })) : [];
    return { queues: base.queues, channels: base.channels.map((c) => ({ id: c.id, name: c.name, state: c.status === 'disabled' ? ('disabled' as const) : ('active' as const) })), owners, tags: tagList };
  }

  // ── acciones de estado ────────────────────────────────────────────────────

  /** El asesor acepta una conversación que le asignaron: pasa a «trabajando». Repetirlo no cambia nada. */
  async accept(access: InboxAccess, id: string): Promise<ConversationView> {
    const scope = scopeOf(access);
    this.requireReply(scope);
    await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, id, true);
      if (c.ownerId !== scope.userId) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación puede aceptarla');
      if (c.status === 'working' || c.status === 'waiting') return; // ya aceptada
      if (c.status !== 'pending') throw new ConflictError('CONVERSATION_STATE', 'La conversación no está pendiente de aceptar');
      await tx.update(conversations).set({ status: 'working', updatedAt: new Date() }).where(eq(conversations.id, id));
      await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'status', oldValue: 'pending', newValue: 'working' });
    });
    return this.get(access, id);
  }

  /**
   * Quien ve todo toma una conversación SIN asignar: queda a su nombre y «trabajando». Si el contacto no tenía responsable, se lo queda (igual que el primer reparto).
   * Pasar una conversación de un asesor a otra persona es transferir (M5.5), no tomar.
   */
  async take(access: InboxAccess, id: string): Promise<ConversationView> {
    const scope = scopeOf(access);
    this.requireReply(scope);
    if (!scope.viewAll) throw new ForbiddenError();
    // Quien actúa debe poder recibir trabajo (un administrador o un asesor de la empresa; no un acceso de soporte). Es identidad: se lee ANTES de la transacción
    if (!(await this.members.canBeAssigned(scope.userId))) throw new ForbiddenError('NOT_ASSIGNABLE', 'Tu usuario no puede recibir conversaciones en esta empresa');
    const timeZone = (await this.directory.current({ fresh: true })).timeZone;
    await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, id, true);
      if (c.status !== 'unassigned') {
        if (c.ownerId === scope.userId && c.status !== 'closed') return; // ya es suya
        throw new ConflictError('CONVERSATION_STATE', 'La conversación ya tiene asesor o está finalizada');
      }
      const now = new Date();
      await tx.update(conversations).set({ ownerId: scope.userId, assignedAt: now, assignmentSource: 'manual', status: 'working', rotations: 0, triedOwners: [], updatedAt: now }).where(eq(conversations.id, id));
      // El cronómetro de primera respuesta corre desde que la toma
      await this.sla.startFirst(tx, { id, ownerId: scope.userId, queueId: c.queueId }, { now, timeZone });
      await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'owner_id', oldValue: null, newValue: scope.userId });
      await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'status', oldValue: 'unassigned', newValue: 'working' });
      await this.contacts.assignOwnerIfNone(tx, c.contactId, scope.userId);
    });
    return this.get(access, id);
  }

  /** Finaliza la conversación (su dueño o quien ve todo). Un mensaje nuevo del cliente abrirá otra. Repetirlo no cambia nada. */
  async close(access: InboxAccess, id: string): Promise<ConversationView> {
    const scope = scopeOf(access);
    this.requireReply(scope);
    await this.db.withTenant(async (tx) => {
      const { c, channel, collab } = await loadConversation(tx, scope, id, true);
      if (c.status === 'closed') return;
      if (!abilities(scope, c, channel.state, collab).close) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación puede finalizarla');
      const now = new Date();
      await tx.update(conversations).set({ status: 'closed', closedAt: now, unreadCount: 0, updatedAt: now }).where(eq(conversations.id, id));
      await this.sla.stopOpen(tx, id, 'closed', now);
      await writeAudit(tx, { entityType: 'conversation', entityId: id, field: 'status', oldValue: c.status, newValue: 'closed' });
    });
    return this.get(access, id);
  }

  /** Pone en cero los no leídos. Solo cuenta si quien la abre es su dueño: un administrador que la mira no borra los pendientes del asesor. */
  async markRead(access: InboxAccess, id: string): Promise<ConversationView> {
    const scope = scopeOf(access);
    this.requireReply(scope);
    await this.db.withTenant(async (tx) => {
      const { c } = await loadConversation(tx, scope, id, true);
      if (c.ownerId === scope.userId && c.unreadCount > 0) await tx.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, id));
    });
    return this.get(access, id);
  }

  // ── consultas ─────────────────────────────────────────────────────────────

  private requireReply(scope: InboxScope): void {
    if (!scope.canReply) throw new ForbiddenError();
  }

  /** Condiciones que comparten el listado y los conteos (todas menos pestaña, cursor y «no leídas»). */
  private filters(tx: TenantTx, scope: InboxScope, q: ListConversationsQuery, sla: { now: Date; riskMinutes: number }): SQL[] {
    const where: SQL[] = [isNull(contacts.deletedAt)];
    const visible = visibleTo(scope);
    if (visible) where.push(visible);
    if (q.owner) where.push(eq(conversations.ownerId, q.owner));
    if (q.queue) where.push(eq(conversations.queueId, q.queue));
    if (q.channel) where.push(eq(conversations.channelAccountId, q.channel));
    if (q.sla) where.push(slaCondition(q.sla, sla.now, sla.riskMinutes));
    if (q.tag) where.push(exists(tx.select({ one: sql`1` }).from(contactTags).where(and(eq(contactTags.contactId, conversations.contactId), eq(contactTags.tagId, q.tag)))));
    if (q.q) {
      const like = `%${likeEscape(q.q)}%`;
      const digits = q.q.replace(/\D/g, '');
      const byPhone = digits.length >= 3 ? exists(tx.select({ one: sql`1` }).from(contactPhones).where(and(eq(contactPhones.contactId, contacts.id), isNull(contactPhones.deletedAt), sql`${contactPhones.e164} LIKE ${`%${digits}%`}`))) : undefined;
      where.push(or(sql`${contacts.name} ILIKE ${like} ESCAPE '!'`, byPhone) as SQL);
    }
    return where;
  }

  private tabCondition(tab: InboxTab): SQL {
    return inArray(conversations.status, [...TAB_STATUSES[tab]]);
  }

  private async counts(tx: TenantTx, scope: InboxScope, q: ListConversationsQuery, sla: { now: Date; riskMinutes: number }): Promise<NonNullable<ConversationList['counts']>> {
    const unread = q.unread ? sql`${conversations.unreadCount} > 0` : sql`true`;
    const inTab = (tab: InboxTab): SQL => sql`${conversations.status} in (${sql.join(TAB_STATUSES[tab].map((s) => sql`${s}`), sql`, `)}) and ${unread}`;
    const [n] = await tx
      .select({
        working: sql<number>`(count(*) filter (where ${inTab('working')}))::int`,
        pending: sql<number>`(count(*) filter (where ${inTab('pending')}))::int`,
        closed: sql<number>`(count(*) filter (where ${inTab('closed')}))::int`,
        unread: sql<number>`(count(*) filter (where ${conversations.unreadCount} > 0 and ${conversations.status} <> 'closed'))::int`,
      })
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
      .where(and(...this.filters(tx, scope, q, sla)));
    return { working: n?.working ?? 0, pending: n?.pending ?? 0, closed: n?.closed ?? 0, unread: n?.unread ?? 0 };
  }

  private fetchRows(tx: TenantTx, scope: InboxScope, where: SQL, limit: number): Promise<Row[]> {
    return tx
      .select({ c: conversations, contactName: contacts.name, channelName: channelAccounts.name, channelStatus: channelAccounts.status, channelDeletedAt: channelAccounts.deletedAt, queueName: queues.name, queueColor: queues.color, key: KEY, collab: collabColumn(scope) })
      .from(conversations)
      .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
      .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
      .leftJoin(queues, and(eq(queues.organizationId, conversations.organizationId), eq(queues.id, conversations.queueId)))
      .where(where)
      .orderBy(desc(ACTIVITY), desc(conversations.id))
      .limit(limit);
  }

  /** Teléfono principal, etiquetas y último mensaje real de cada conversación de la página. El responsable (identidad) lo pone quien llama, fuera de la transacción. */
  private async hydrate(tx: TenantTx, scope: InboxScope, rows: readonly Row[], ctx: TimerContext): Promise<Hydrated[]> {
    if (rows.length === 0) return [];
    const contactIds = [...new Set(rows.map((r) => r.c.contactId))];
    const convIds = rows.map((r) => r.c.id);
    const phones = new Map<string, string>(
      (await tx.select({ contactId: contactPhones.contactId, e164: contactPhones.e164 }).from(contactPhones).where(and(inArray(contactPhones.contactId, contactIds), isNull(contactPhones.deletedAt), eq(contactPhones.isPrimary, true)))).map((p) => [p.contactId, p.e164]),
    );
    const tagsByContact = await this.tags.forContacts(tx, contactIds);
    const lastRows = await tx
      .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, direction: messages.direction, kind: messages.kind, body: messages.body, status: messages.status, sentAt: messages.sentAt })
      .from(messages)
      .where(and(inArray(messages.conversationId, convIds), sql`${messages.kind} <> 'note'`))
      .orderBy(messages.conversationId, desc(messages.sentAt), desc(messages.id));
    const last = new Map(lastRows.map((m) => [m.conversationId, m]));
    const partRows = await tx
      .select({ conversationId: conversationParticipants.conversationId, userId: conversationParticipants.userId, permission: conversationParticipants.permission, addedBy: conversationParticipants.addedBy, addedAt: conversationParticipants.addedAt })
      .from(conversationParticipants)
      .where(and(inArray(conversationParticipants.conversationId, convIds), isNull(conversationParticipants.revokedAt)))
      .orderBy(asc(conversationParticipants.addedAt), asc(conversationParticipants.id));
    const slaViews = await this.sla.views(tx, rows.map((r) => ({ id: r.c.id, queueId: r.c.queueId })), ctx);
    const participants = new Map<string, Hydrated['participantRows']>();
    for (const p of partRows) participants.set(p.conversationId, [...(participants.get(p.conversationId) ?? []), { userId: p.userId, permission: p.permission, addedBy: p.addedBy, addedAt: p.addedAt }]);
    return rows.map((r) => ({
      c: r.c,
      contactName: r.contactName,
      phone: phones.get(r.c.contactId) ?? null,
      channelName: r.channelName,
      channelState: channelState(r.channelStatus, r.channelDeletedAt),
      queue: r.c.queueId && r.queueName !== null ? { id: r.c.queueId, name: r.queueName, color: r.queueColor ?? '#7c5cfa' } : null,
      tags: tagsByContact.get(r.c.contactId) ?? [],
      last: last.get(r.c.id) ?? null,
      sla: slaViews.get(r.c.id) ?? null,
      collab: r.c.ownerId === scope.userId ? null : r.collab,
      participantRows: participants.get(r.c.id) ?? [],
    }));
  }

  /** Pone los nombres (identidad, fuera de la transacción) a lo reunido y arma las vistas. */
  private async views(parts: readonly Hydrated[], scope: InboxScope, now: Date): Promise<ConversationView[]> {
    const ids = new Set<string>();
    for (const p of parts) {
      if (p.c.ownerId) ids.add(p.c.ownerId);
      for (const r of p.participantRows) {
        ids.add(r.userId);
        if (r.addedBy) ids.add(r.addedBy);
      }
    }
    const labels = await this.members.labels([...ids]);
    const who = (id: string): { id: string; name: string } => labels.get(id) ?? { id, name: 'Persona desconocida' };
    return parts.map((p) => {
      const participants: ParticipantView[] = p.participantRows.map((r) => ({ user: who(r.userId), permission: r.permission === 'reply' ? 'reply' : 'view', added_by: r.addedBy ? who(r.addedBy) : null, added_at: r.addedAt.toISOString() }));
      return conversationView({ ...p, owner: p.c.ownerId ? who(p.c.ownerId) : null, participants }, scope, now);
    });
  }
}
