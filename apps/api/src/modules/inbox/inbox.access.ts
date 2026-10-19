import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { channelAccounts, contacts, conversations, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';

/**
 * Quién consulta y qué puede hacer (M5.4, ADR-16/50). Lo arma el controlador con los permisos VERIFICADOS del principal; la persona sale de TenantContext.
 *  - `viewAll` (`inbox.view_all`): ve todas las conversaciones de la empresa, también las sin asignar. Sin él: solo las que tiene asignadas (M5.5 sumará las compartidas).
 *  - `canReply` (`inbox.reply`): puede aceptar, responder, escribir notas y finalizar.
 * El aislamiento entre EMPRESAS no depende de esto: lo da la RLS. Aquí solo se decide qué ve cada persona DENTRO de su empresa; lo que no ve responde 404, igual que lo inexistente.
 */
export interface InboxAccess {
  readonly viewAll: boolean;
  readonly canReply: boolean;
}
export interface InboxScope extends InboxAccess {
  readonly userId: string;
}

export function scopeOf(access: InboxAccess): InboxScope {
  const userId = TenantContext.current().userId;
  if (!userId) throw new ForbiddenError();
  return { ...access, userId };
}

/** Condición de visibilidad de la conversación para esta persona (ninguna si lo ve todo). */
export const visibleTo = (scope: InboxScope): SQL | undefined => (scope.viewAll ? undefined : eq(conversations.ownerId, scope.userId));

export type ConversationRow = typeof conversations.$inferSelect;

/** Estado de la conexión por la que se habla. */
export type ChannelState = 'active' | 'disabled' | 'removed';

export interface Loaded {
  c: ConversationRow;
  channel: { name: string; state: ChannelState };
  contactName: string;
}

export const channelState = (status: string, deletedAt: Date | null): ChannelState => (deletedAt ? 'removed' : status === 'disabled' ? 'disabled' : 'active');

/**
 * La conversación visible para esta persona (con su conexión y el contacto, que no esté borrado); 404 si no existe, es de otra persona sin permiso para verla
 * o su contacto fue borrado. `lock` la bloquea (acciones que cambian su estado).
 */
export async function loadConversation(tx: TenantTx, scope: InboxScope, id: string, lock = false): Promise<Loaded> {
  const q = tx
    .select({ c: conversations, channelName: channelAccounts.name, channelStatus: channelAccounts.status, channelDeletedAt: channelAccounts.deletedAt, contactName: contacts.name })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
    .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
    .where(and(eq(conversations.id, id), visibleTo(scope), isNull(contacts.deletedAt)))
    .limit(1);
  const [row] = await (lock ? q.for('update', { of: conversations }) : q);
  if (!row) throw new NotFoundError();
  return { c: row.c, channel: { name: row.channelName, state: channelState(row.channelStatus, row.channelDeletedAt) }, contactName: row.contactName };
}

/** Lo que esta persona puede hacer con una conversación en su estado actual. Una sola fuente para la interfaz (`can`) y para las acciones. */
export interface Abilities {
  /** Escribir al cliente: solo quien la tiene asignada, con la conversación abierta y la conexión activa. */
  reply: boolean;
  /** Nota interna: cualquiera con permiso que pueda verla. */
  note: boolean;
  /** Aceptar una conversación asignada a mí y aún pendiente. */
  accept: boolean;
  /** Tomar una conversación sin asignar (solo quien ve todo). */
  take: boolean;
  /** Finalizar: su dueño o quien ve todo. */
  close: boolean;
}

const OPEN_OWNED = new Set(['pending', 'working', 'waiting']);

export function abilities(scope: InboxScope, c: Pick<ConversationRow, 'status' | 'ownerId'>, channel: ChannelState): Abilities {
  const mine = c.ownerId === scope.userId;
  return {
    reply: scope.canReply && mine && OPEN_OWNED.has(c.status) && channel === 'active',
    note: scope.canReply,
    accept: scope.canReply && mine && c.status === 'pending',
    take: scope.canReply && scope.viewAll && c.status === 'unassigned',
    close: scope.canReply && c.status !== 'closed' && (mine || scope.viewAll),
  };
}

/** Por qué no puede responder, con el mensaje que ve la persona; no hace nada si puede. */
export function assertCanReply(scope: InboxScope, c: Pick<ConversationRow, 'status' | 'ownerId'>, channel: ChannelState): void {
  if (c.status === 'closed') throw new ConflictError('CONVERSATION_CLOSED', 'La conversación está finalizada');
  if (c.status === 'unassigned') throw new ConflictError('CONVERSATION_UNASSIGNED', 'La conversación aún no tiene asesor: asígnala o tómala antes de responder');
  if (c.ownerId !== scope.userId) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación puede responder');
  if (channel !== 'active') throw new ConflictError('CHANNEL_DISABLED', 'La conexión de WhatsApp de esta conversación está desactivada o desconectada');
}

/** WhatsApp oficial solo admite mensajes libres dentro de las 24 h siguientes al último mensaje del cliente. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  expires_at: string | null;
}

export function windowOf(lastInboundAt: Date | null, now: Date): WindowState {
  if (!lastInboundAt) return { open: false, expires_at: null };
  const end = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: end.getTime() > now.getTime(), expires_at: end.toISOString() };
}

export function assertWindowOpen(lastInboundAt: Date | null, now: Date): void {
  if (!windowOf(lastInboundAt, now).open) throw new ConflictError('WINDOW_CLOSED', 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada');
}
