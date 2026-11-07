import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { conversationParticipants, conversations } from '../../db';

/**
 * Condición de visibilidad de una conversación para UNA persona (ninguna si lo ve todo): es su dueña o tiene un acceso vigente como colaboradora. Una sola fuente para la bandeja
 * (`InboxService`, programados) y para los avisos (F1, ADR-57): lo que una persona no puede abrir tampoco aparece en sus avisos. La RLS ya acota por empresa.
 */
export const conversationVisibleTo = (userId: string, viewAll: boolean): SQL | undefined =>
  and(
    // Una conversación eliminada (ADR-63) no la ve nadie, ni quien lo ve todo
    isNull(conversations.deletedAt),
    viewAll
      ? undefined
      : or(
          eq(conversations.ownerId, userId),
          sql`EXISTS (SELECT 1 FROM ${conversationParticipants} p WHERE p.organization_id = ${conversations.organizationId} AND p.conversation_id = ${conversations.id} AND p.user_id = ${userId} AND p.revoked_at IS NULL)`,
        ),
  );
