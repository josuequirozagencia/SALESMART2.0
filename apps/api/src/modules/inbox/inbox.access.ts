import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { channelAccounts, contacts, conversationParticipants, conversations, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';

/**
 * Quién consulta y qué puede hacer (M5.4/M5.5, ADR-14/16/50). Lo arma el controlador con los permisos VERIFICADOS del principal; la persona sale de TenantContext.
 *  - `viewAll` (`inbox.view_all`): ve todas las conversaciones de la empresa, también las sin asignar. Sin él: las que tiene asignadas y las que le compartieron.
 *  - `canReply` (`inbox.reply`): puede aceptar, responder, escribir notas y finalizar.
 *  - `canTransfer` (`inbox.transfer`) y `canShare` (`inbox.share`): pasar la conversación a otra persona o darle acceso (el asesor, solo en las suyas).
 * El aislamiento entre EMPRESAS no depende de esto: lo da la RLS. Aquí solo se decide qué ve cada persona DENTRO de su empresa; lo que no ve responde 404, igual que lo inexistente.
 */
export interface InboxAccess {
  readonly viewAll: boolean;
  readonly canReply: boolean;
  readonly canTransfer: boolean;
  readonly canShare: boolean;
}
export interface InboxScope extends InboxAccess {
  readonly userId: string;
}

export function scopeOf(access: InboxAccess): InboxScope {
  const userId = TenantContext.current().userId;
  if (!userId) throw new ForbiddenError();
  return { ...access, userId };
}

/** Permiso de un colaborador de la conversación: responder, o solo ver y dejar notas. Null = no es colaborador. */
export type Collab = 'reply' | 'view' | null;

/** El acceso VIGENTE de esta persona a la conversación como colaboradora (subconsulta correlacionada; la RLS ya acota por empresa). */
const collabOf = (userId: string): SQL<Collab> =>
  sql<Collab>`(SELECT p.permission FROM ${conversationParticipants} p WHERE p.organization_id = ${conversations.organizationId} AND p.conversation_id = ${conversations.id} AND p.user_id = ${userId} AND p.revoked_at IS NULL LIMIT 1)`;

/** Para consultas de varias conversaciones: el permiso de colaboradora de la persona en cada una. */
export const collabColumn = (scope: InboxScope): SQL<Collab> => collabOf(scope.userId);

/**
 * Condición de visibilidad de la conversación para esta persona (ninguna si lo ve todo): es su dueña o tiene un acceso vigente como colaboradora.
 */
export const visibleTo = (scope: InboxScope): SQL | undefined =>
  scope.viewAll
    ? undefined
    : or(
        eq(conversations.ownerId, scope.userId),
        sql`EXISTS (SELECT 1 FROM ${conversationParticipants} p WHERE p.organization_id = ${conversations.organizationId} AND p.conversation_id = ${conversations.id} AND p.user_id = ${scope.userId} AND p.revoked_at IS NULL)`,
      );

export type ConversationRow = typeof conversations.$inferSelect;

/** Estado de la conexión por la que se habla. */
export type ChannelState = 'active' | 'disabled' | 'removed';

export interface Loaded {
  c: ConversationRow;
  channel: { name: string; state: ChannelState; provider: string };
  contactName: string;
  /** Si la persona NO es la dueña, su permiso como colaboradora. */
  collab: Collab;
}

export const channelState = (status: string, deletedAt: Date | null): ChannelState => (deletedAt ? 'removed' : status === 'disabled' ? 'disabled' : 'active');

/**
 * La conversación visible para esta persona (con su conexión y el contacto, que no esté borrado); 404 si no existe, es de otra persona sin permiso para verla
 * o su contacto fue borrado. `lock` la bloquea (acciones que cambian su estado).
 */
export async function loadConversation(tx: TenantTx, scope: InboxScope, id: string, lock = false): Promise<Loaded> {
  const q = tx
    .select({ c: conversations, channelName: channelAccounts.name, channelStatus: channelAccounts.status, channelDeletedAt: channelAccounts.deletedAt, channelProvider: channelAccounts.provider, contactName: contacts.name, collab: collabOf(scope.userId) })
    .from(conversations)
    .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
    .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
    .where(and(eq(conversations.id, id), visibleTo(scope), isNull(contacts.deletedAt)))
    .limit(1);
  const [row] = await (lock ? q.for('update', { of: conversations }) : q);
  if (!row) throw new NotFoundError();
  return { c: row.c, channel: { name: row.channelName, state: channelState(row.channelStatus, row.channelDeletedAt), provider: row.channelProvider }, contactName: row.contactName, collab: row.c.ownerId === scope.userId ? null : row.collab };
}

/** Lo que esta persona puede hacer con una conversación en su estado actual. Una sola fuente para la interfaz (`can`) y para las acciones. */
export interface Abilities {
  /** Escribir al cliente: su dueño, o quien la comparte con permiso de responder (esa persona, solo cuando el dueño ya la aceptó); con la conversación abierta y la conexión activa. */
  reply: boolean;
  /** Nota interna: cualquiera con permiso que pueda verla. */
  note: boolean;
  /** Aceptar una conversación asignada a mí y aún pendiente. */
  accept: boolean;
  /** Tomar una conversación sin asignar (solo quien ve todo). */
  take: boolean;
  /** Finalizar: su dueño o quien ve todo. */
  close: boolean;
  /** Pasarla a otra persona: su dueño o quien ve todo (también una sin asignar, que así queda asignada). */
  transfer: boolean;
  /** Darle acceso a otra persona sin cambiar el dueño: su dueño o quien ve todo (la conversación debe tener dueño). */
  share: boolean;
}

const OPEN_OWNED = new Set(['pending', 'working', 'waiting']);

export function abilities(scope: InboxScope, c: Pick<ConversationRow, 'status' | 'ownerId'>, channel: ChannelState, collab: Collab = null): Abilities {
  const mine = c.ownerId === scope.userId;
  // viewAll (administrador/super_admin) puede responder cualquier conversación abierta, igual que el dueño
  const speaks = mine || scope.viewAll ? OPEN_OWNED.has(c.status) : collab === 'reply' && (c.status === 'working' || c.status === 'waiting');
  const open = c.status !== 'closed';
  return {
    reply: scope.canReply && speaks && channel === 'active',
    note: scope.canReply,
    accept: scope.canReply && (mine || scope.viewAll) && c.status === 'pending',
    take: scope.canReply && scope.viewAll && c.status === 'unassigned',
    close: scope.canReply && open && (mine || scope.viewAll),
    transfer: scope.canTransfer && open && (mine || scope.viewAll),
    share: scope.canShare && open && c.status !== 'unassigned' && (mine || scope.viewAll),
  };
}

/** Por qué no puede responder, con el mensaje que ve la persona; no hace nada si puede. */
export function assertCanReply(scope: InboxScope, c: Pick<ConversationRow, 'status' | 'ownerId'>, channel: ChannelState, collab: Collab = null, provider = 'meta_cloud'): void {
  if (c.status === 'closed') throw new ConflictError('CONVERSATION_CLOSED', 'La conversación está finalizada');
  if (c.status === 'unassigned') throw new ConflictError('CONVERSATION_UNASSIGNED', 'La conversación aún no tiene asesor: asígnala o tómala antes de responder');
  if (c.ownerId !== scope.userId && !scope.viewAll) {
    if (collab === 'view') throw new ForbiddenError('NOT_OWNER', 'Te compartieron esta conversación solo para ver y dejar notas: no puedes escribirle al cliente');
    if (collab !== 'reply') throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación, o quien la comparte con permiso para responder, puede responder');
    if (c.status === 'pending') throw new ConflictError('CONVERSATION_NOT_ACCEPTED', 'Quien tiene asignada la conversación aún no la acepta: podrás responder cuando lo haga');
  }
  if (channel !== 'active') throw new ConflictError('CHANNEL_DISABLED', provider === 'evolution' ? 'La conexión de WhatsApp por QR está desactivada o fue borrada: el administrador debe revisarla en Configuración › Conexiones' : provider === 'ghl' ? 'La conexión con GoHighLevel está desconectada o su token fue rechazado: el administrador debe revisarla en Configuración › GoHighLevel' : 'La conexión de WhatsApp de esta conversación está desactivada o desconectada');
}

/** Cómo se relaciona la persona con la conversación (para la interfaz). */
export type MyAccess = 'owner' | 'collaborator_reply' | 'collaborator_view' | 'supervisor';
export function myAccessOf(scope: InboxScope, c: Pick<ConversationRow, 'ownerId'>, collab: Collab): MyAccess {
  if (c.ownerId === scope.userId) return 'owner';
  if (collab === 'reply') return 'collaborator_reply';
  if (collab === 'view') return 'collaborator_view';
  return 'supervisor';
}

/** WhatsApp oficial solo admite mensajes libres dentro de las 24 h siguientes al último mensaje del cliente. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  expires_at: string | null;
}

/** ¿El canal tiene la ventana de 24 h de WhatsApp oficial? GoHighLevel no (cada canal de GHL tiene sus propias reglas y GHL las aplica). */
export const hasWindow = (provider: string): boolean => provider !== 'ghl' && provider !== 'evolution';

export function windowOf(lastInboundAt: Date | null, now: Date, provider = 'meta_cloud'): WindowState {
  if (!hasWindow(provider)) return { open: true, expires_at: null };
  if (!lastInboundAt) return { open: false, expires_at: null };
  const end = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: end.getTime() > now.getTime(), expires_at: end.toISOString() };
}

export function assertWindowOpen(lastInboundAt: Date | null, now: Date, provider = 'meta_cloud'): void {
  if (!windowOf(lastInboundAt, now, provider).open) throw new ConflictError('WINDOW_CLOSED', 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada');
}
