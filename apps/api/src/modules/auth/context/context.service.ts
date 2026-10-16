import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { accessSessions, Database, organizationMembers, organizations, sessions, type IdentityTx } from '../../../db';
import { NotFoundError, UnauthorizedError } from '../../../errors';
import { likeEscape } from '../../organizations';
import { toMeView, type MeView } from '../me-view';
import { actingFor, SessionService, type ActingAs } from '../session.service';
import { ThrottleService } from '../throttle.service';

export interface ContextOption {
  id: string;
  name: string;
  /** Rol de la persona en esa organización (`agency` = es un cliente de su cartera). */
  role: string;
  access_level: string | null;
}

/**
 * Cambio de contexto sin cerrar sesión (ADR-11/21/41, flujo F02). El contexto es `sessions.active_org_id`; los tokens no cambian. Cambiarlo NO
 * concede nada por sí mismo: el servidor vuelve a validar el derecho en CADA petición (membresía vigente, o Súper Admin vigente en la plataforma).
 *  - Se puede entrar a una organización donde se tiene una membresía VIGENTE (una agencia, a los clientes de su cartera) o, siendo Súper Admin,
 *    a cualquier organización activa que no sea la plataforma (soporte, sin membresía). Cualquier otro destino → 404 uniforme: no revela si existe.
 *  - Cada entrada como Súper Admin o agencia se anota en `access_sessions` (solo la lee el Súper Admin) y se cierra al salir.
 *  - La sesión se bloquea (FOR UPDATE) mientras cambia: dos cambios o un refresh simultáneos no se pisan.
 */
@Injectable()
export class ContextService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
  ) {}

  async switch(input: { sessionId: string; userId: string; target: string | null; ip?: string }, now = new Date()): Promise<MeView> {
    const ctx = await this.db.withIdentity(async (tx) => {
      const [s] = await tx.select().from(sessions).where(eq(sessions.id, input.sessionId)).for('update').limit(1);
      if (!s || s.revokedAt !== null || s.userId !== input.userId) throw new UnauthorizedError();
      const toHome = input.target === null || input.target === s.homeOrgId;
      const targetId = toHome ? s.homeOrgId : (input.target as string);

      let acting: ActingAs | null = null;
      if (targetId !== s.activeOrgId) {
        if (!toHome) acting = await this.authorize(tx, input.userId, targetId);
        // Se cierran las entradas abiertas de ESTA sesión (salir de un cliente) y, si el destino es uno ajeno, se abre la nueva
        await tx
          .update(accessSessions)
          .set({ endedAt: now, endReason: toHome ? 'return' : 'switch' })
          .where(and(eq(accessSessions.sessionId, s.id), isNull(accessSessions.endedAt)));
        await tx.update(sessions).set({ activeOrgId: targetId }).where(eq(sessions.id, s.id));
        if (acting) {
          await tx.insert(accessSessions).values({
            sessionId: s.id,
            actorUserId: input.userId,
            actorRole: acting,
            organizationId: targetId,
            startedAt: now,
            ipHash: input.ip ? this.throttle.keyFor('i', input.ip).slice(2) : null,
          });
        }
      }
      // Se relee con la misma validación de cada petición: si el destino no es válido (p. ej. el origen ya no tiene membresía), se deshace todo
      const c = await this.sessions.contextIn(tx, s.id, now);
      if (!c) throw new UnauthorizedError();
      return c;
    });
    return toMeView(ctx);
  }

  /** Otras organizaciones (clientes) a las que la persona puede entrar con una membresía vigente: el selector de «Administrando X». */
  async options(sessionId: string, q?: string, now = new Date()): Promise<{ items: ContextOption[] }> {
    return this.db.withIdentity(async (tx) => {
      const cur = await this.sessions.contextIn(tx, sessionId, now);
      if (!cur) throw new UnauthorizedError();
      const where = [
        eq(organizationMembers.userId, cur.userId),
        isNull(organizationMembers.revokedAt),
        eq(organizations.status, 'active'),
        isNull(organizations.deletedAt),
        eq(organizations.kind, 'client'),
        ne(organizations.id, cur.organizationId),
      ];
      if (q) where.push(sql`${organizations.name} ILIKE ${`%${likeEscape(q)}%`} ESCAPE '!'`);
      const rows = await tx
        .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role, accessLevel: organizationMembers.accessLevel })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(and(...where))
        .orderBy(asc(organizations.name), asc(organizations.id))
        .limit(50);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, access_level: r.accessLevel })) };
    });
  }

  /** Verifica el derecho a entrar al destino y devuelve si ahí se ACTÚA (agencia o soporte) o es una membresía propia. 404 uniforme si no. */
  private async authorize(tx: IdentityTx, userId: string, targetId: string): Promise<ActingAs | null> {
    const [org] = await tx.select({ kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, targetId)).limit(1);
    if (!org || org.deletedAt !== null || org.status !== 'active' || org.kind === 'platform') throw new NotFoundError();
    const [m] = await tx
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, targetId), isNull(organizationMembers.revokedAt)))
      .limit(1);
    if (m) return actingFor(m.role, org.kind);
    // Sin membresía en el destino, solo el Súper Admin VIGENTE entra (soporte)
    const [sa] = await tx
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, 'super_admin'), isNull(organizationMembers.revokedAt), eq(organizations.kind, 'platform'), eq(organizations.status, 'active'), isNull(organizations.deletedAt)))
      .limit(1);
    if (!sa) throw new NotFoundError();
    return 'super_admin';
  }
}
