import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { accessSessions, organizationMembers, organizations, sessions, users, type IdentityTx } from '../../db';

/** Nivel con el que el personal de una agencia entra a un cliente de su cartera si el Súper Admin no fijó otro (ADR-40 #3). Se fija por cliente en `organizations.agency_access_level` (ADR-41). */
export const AGENCY_DEFAULT_ACCESS_LEVEL = 'admin';

export interface ReconcileResult {
  granted: number;
  revoked: number;
}

/**
 * Mantiene UNA invariante (ADR-11/22/40): cada persona ACTIVA de una agencia ACTIVA tiene una membresía `agency` vigente en cada cliente de su
 * cartera (`parent_agency_id`), y nadie más tiene una membresía `agency` en ese cliente. Es idempotente: se llama tras cualquier cambio que la
 * pueda alterar (mover un cliente, suspender o reactivar una agencia, aceptar la invitación de un miembro de la agencia).
 *  - Revocar la membresía corta el acceso al instante: la sesión se valida en cada petición contra una membresía VIGENTE (SessionService).
 *  - Además, las sesiones cuyo contexto activo era ese cliente VUELVEN a su organización de origen (la persona sigue con su sesión, ahora en su agencia)
 *    y se cierran sus entradas en `access_sessions` (ADR-41). Solo si el origen era el propio cliente la sesión se revoca.
 *  - Quien ya tiene otra membresía vigente en el cliente (p. ej. es también su administrador) no recibe una segunda: el índice único lo impide.
 * Todo el acceso a datos va por el `tx` de identidad que recibe: la llamada se hace DENTRO de la transacción del cambio.
 */
@Injectable()
export class AgencyAccessService {
  async reconcileClient(tx: IdentityTx, clientId: string, grantedBy: string | null, now = new Date()): Promise<ReconcileResult> {
    const [client] = await tx.select({ parent: organizations.parentAgencyId, level: organizations.agencyAccessLevel }).from(organizations).where(eq(organizations.id, clientId)).limit(1);
    let desired: string[] = [];
    if (client?.parent) {
      const [agency] = await tx.select({ kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, client.parent)).limit(1);
      if (agency && agency.kind === 'agency' && agency.status === 'active' && agency.deletedAt === null) {
        const rows = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.organizationId, client.parent), eq(organizationMembers.role, 'agency'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)));
        desired = rows.map((r) => r.userId);
      }
    }
    const active = await tx.select({ id: organizationMembers.id, userId: organizationMembers.userId, role: organizationMembers.role }).from(organizationMembers).where(and(eq(organizationMembers.organizationId, clientId), isNull(organizationMembers.revokedAt)));
    const want = new Set(desired);
    const revoke = active.filter((m) => m.role === 'agency' && !want.has(m.userId));
    const have = new Set(active.map((m) => m.userId));
    const grant = desired.filter((u) => !have.has(u));

    if (revoke.length > 0) {
      const revoked = revoke.map((m) => m.userId);
      await tx.update(organizationMembers).set({ revokedAt: now }).where(inArray(organizationMembers.id, revoke.map((m) => m.id)));
      const inClient = and(eq(sessions.activeOrgId, clientId), inArray(sessions.userId, revoked), isNull(sessions.revokedAt));
      await tx.update(sessions).set({ activeOrgId: sql`${sessions.homeOrgId}` }).where(and(inClient, ne(sessions.homeOrgId, clientId)));
      await tx.update(sessions).set({ revokedAt: now, revokeReason: 'access_removed' }).where(and(inClient, eq(sessions.homeOrgId, clientId)));
      await tx
        .update(accessSessions)
        .set({ endedAt: now, endReason: 'access_removed' })
        .where(and(eq(accessSessions.organizationId, clientId), inArray(accessSessions.actorUserId, revoked), isNull(accessSessions.endedAt)));
    }
    if (grant.length > 0) {
      await tx.insert(organizationMembers).values(grant.map((userId) => ({ userId, organizationId: clientId, role: 'agency', accessLevel: client?.level ?? AGENCY_DEFAULT_ACCESS_LEVEL, grantedBy })));
    }
    return { granted: grant.length, revoked: revoke.length };
  }

  /** Reconcilia todos los clientes de la cartera de una agencia. */
  async reconcileAgency(tx: IdentityTx, agencyId: string, grantedBy: string | null, now = new Date()): Promise<ReconcileResult> {
    const clients = await tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.parentAgencyId, agencyId), isNull(organizations.deletedAt)));
    const total: ReconcileResult = { granted: 0, revoked: 0 };
    for (const c of clients) {
      const r = await this.reconcileClient(tx, c.id, grantedBy, now);
      total.granted += r.granted;
      total.revoked += r.revoked;
    }
    return total;
  }
}
