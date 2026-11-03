import { and, asc, eq, isNull } from 'drizzle-orm';
import { organizationMembers, users, type IdentityTx } from '../../../db';

export interface DeletionRecipient {
  email: string;
  audience: 'owner' | 'agency';
}

/**
 * A quién se le avisa de lo que le pasa a una empresa eliminada (F3a eliminar y recuperar, F3c «24 horas antes»): al dueño (`owner_user_id`; si no consta, al primer administrador vigente) y al personal activo
 * de la agencia que la administraba. Solo cuentas activas.
 */
export async function deletionRecipients(tx: IdentityTx, orgId: string, agencyId: string | null, ownerUserId: string | null): Promise<DeletionRecipient[]> {
  const out: DeletionRecipient[] = [];
  const seen = new Set<string>();
  const add = (email: string | undefined, audience: 'owner' | 'agency'): void => {
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push({ email, audience });
    }
  };
  if (ownerUserId) {
    const [o] = await tx.select({ email: users.email }).from(users).where(and(eq(users.id, ownerUserId), eq(users.status, 'active'), isNull(users.deletedAt))).limit(1);
    add(o?.email, 'owner');
  }
  if (out.length === 0) {
    const [a] = await tx
      .select({ email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)))
      .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.id))
      .limit(1);
    add(a?.email, 'owner');
  }
  if (agencyId) {
    const staff = await tx
      .select({ email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, agencyId), eq(organizationMembers.role, 'agency'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)));
    for (const s of staff) add(s.email, 'agency');
  }
  return out;
}
