import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Database, memberHistory, memberPermissions, organizationMembers, sessions, users, type IdentityTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { isOverrideRole, isPermissionKey, validateOverrides, type OverrideRole, type PermissionKey } from '../../rbac';
import { TenantContext } from '../../tenant';

export type TeamRole = OverrideRole;
export type TeamStatus = 'active' | 'deactivated';

export interface TeamMember {
  /** Identificador de la PERSONA (el usuario), el mismo en toda la API de equipo. */
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  role: TeamRole;
  status: TeamStatus;
  joined_at: string;
  deactivated_at: string | null;
  /** ¿Tiene ajustes de permisos sobre la plantilla de su rol? */
  custom_permissions: boolean;
  last_access_at: string | null;
}
export interface TeamMemberDetail extends TeamMember {
  overrides: { grant: PermissionKey[]; deny: PermissionKey[] };
}

const ROLES: TeamRole[] = ['client_admin', 'advisor'];
const keysOf = (rows: Array<{ k: string; e: string }>, effect: 'grant' | 'deny'): PermissionKey[] => rows.filter((r) => r.e === effect && isPermissionKey(r.k)).map((r) => r.k as PermissionKey);

/**
 * Equipo de la empresa del CONTEXTO en identidad (M10.3, ADR-56 B3): quién es miembro, su rol, sus ajustes de permisos, activarlo y desactivarlo. La organización sale SIEMPRE de
 * `TenantContext` (nunca de la petición) y todo cambio escribe su historia (`member_history`) en la MISMA transacción. Lo que es de negocio (conversaciones, departamentos) lo
 * orquesta el módulo de equipo con los servicios de cada módulo: aquí solo se toca identidad.
 * Reglas: una persona es un miembro VIGENTE (activo) o uno DESACTIVADO (se puede reactivar); «quitar» la saca para siempre (solo vuelve con una invitación). Las membresías de
 * agencia y de soporte NO son del equipo (solo cuentan `client_admin` y `advisor`). Nunca se queda la empresa sin administrador: el último no se baja de rol, desactiva ni quita
 * (409 `LAST_ADMIN`), con las membresías de administrador bloqueadas para que dos cambios simultáneos no lo burlen.
 */
@Injectable()
export class TeamMembersService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private ctx(): { orgId: string; actor: string } {
    const c = TenantContext.current();
    if (!c.userId) throw new NotFoundError();
    return { orgId: c.organizationId, actor: c.userId };
  }

  /** Los miembros del equipo: activos y desactivados (los quitados ya no figuran), por nombre. */
  async list(): Promise<TeamMember[]> {
    const { orgId } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const rows = await tx
        .select({ m: organizationMembers, userId: users.id, fullName: users.fullName, email: users.email, phone: users.phone, userStatus: users.status })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, orgId), inArray(organizationMembers.role, ROLES), isNull(users.deletedAt)));
      // Una fila por persona: la vigente; si no hay, la última desactivada (las quitadas no aparecen)
      const pick = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const cur = pick.get(r.userId);
        const rank = (x: typeof r): number => (x.m.revokedAt === null ? 2 : x.m.revokedReason === 'deactivated' ? 1 : 0);
        if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && r.m.createdAt > cur.m.createdAt)) pick.set(r.userId, r);
      }
      const kept = [...pick.values()].filter((r) => r.m.revokedAt === null || r.m.revokedReason === 'deactivated');
      if (kept.length === 0) return [];
      const ids = kept.map((r) => r.m.id);
      const withOverrides = new Set((await tx.select({ id: memberPermissions.membershipId }).from(memberPermissions).where(and(inArray(memberPermissions.membershipId, ids), isNull(memberPermissions.revokedAt)))).map((r) => r.id));
      const access = await tx
        .select({ userId: sessions.userId, at: sql<Date | null>`max(coalesce(${sessions.lastRefreshedAt}, ${sessions.createdAt}))` })
        .from(sessions)
        .where(and(inArray(sessions.userId, kept.map((r) => r.userId)), eq(sessions.activeOrgId, orgId)))
        .groupBy(sessions.userId);
      const last = new Map(access.map((a) => [a.userId, a.at]));
      return kept
        .map((r): TeamMember => ({
          user_id: r.userId,
          name: r.fullName ?? r.email,
          email: r.email,
          phone: r.phone,
          role: r.m.role as TeamRole,
          status: r.m.revokedAt === null ? 'active' : 'deactivated',
          joined_at: r.m.createdAt.toISOString(),
          deactivated_at: r.m.revokedAt?.toISOString() ?? null,
          custom_permissions: withOverrides.has(r.m.id),
          last_access_at: last.get(r.userId) ? new Date(last.get(r.userId)!).toISOString() : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
  }

  /** Una persona del equipo con sus ajustes. 404 si no es de la empresa (o fue quitada): no se distingue de una que no existe. */
  async get(userId: string): Promise<TeamMemberDetail> {
    const { orgId } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const m = await this.load(tx, orgId, userId, false);
      return this.detail(tx, m);
    });
  }

  private async load(tx: IdentityTx, orgId: string, userId: string, lock: boolean, status: 'active' | 'deactivated' | 'any' = 'any') {
    const q = tx
      .select({ m: organizationMembers, fullName: users.fullName, email: users.email, phone: users.phone })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId), inArray(organizationMembers.role, ROLES), isNull(users.deletedAt)))
      .orderBy(desc(organizationMembers.createdAt));
    const rows = await (lock ? q.for('update', { of: organizationMembers }) : q);
    const active = rows.find((r) => r.m.revokedAt === null);
    const found = active ?? rows.find((r) => r.m.revokedReason === 'deactivated');
    if (!found || (status === 'active' && !active) || (status === 'deactivated' && active)) throw new NotFoundError();
    return found;
  }

  private activeOverrides(tx: IdentityTx, membershipId: string) {
    return tx.select({ k: memberPermissions.permissionKey, e: memberPermissions.effect }).from(memberPermissions).where(and(eq(memberPermissions.membershipId, membershipId), isNull(memberPermissions.revokedAt)));
  }

  /** Reemplazar o reiniciar los ajustes = marcar los vigentes como revocados (sin DELETE en identidad). */
  private async revokeOverrides(tx: IdentityTx, membershipId: string): Promise<void> {
    await tx.update(memberPermissions).set({ revokedAt: sql`now()` }).where(and(eq(memberPermissions.membershipId, membershipId), isNull(memberPermissions.revokedAt)));
  }

  private async detail(tx: IdentityTx, r: { m: typeof organizationMembers.$inferSelect; fullName: string | null; email: string; phone: string | null }): Promise<TeamMemberDetail> {
    const rows = await this.activeOverrides(tx, r.m.id);
    const overrides = { grant: keysOf(rows, 'grant'), deny: keysOf(rows, 'deny') };
    return {
      user_id: r.m.userId,
      name: r.fullName ?? r.email,
      email: r.email,
      phone: r.phone,
      role: r.m.role as TeamRole,
      status: r.m.revokedAt === null ? 'active' : 'deactivated',
      joined_at: r.m.createdAt.toISOString(),
      deactivated_at: r.m.revokedAt?.toISOString() ?? null,
      custom_permissions: rows.length > 0,
      last_access_at: null,
      overrides,
    };
  }

  /** Bloquea a los administradores vigentes y falla si `userId` es el último: ni bajarlo de rol, ni desactivarlo, ni quitarlo. */
  private async guardLastAdmin(tx: IdentityTx, orgId: string, userId: string): Promise<void> {
    const admins = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)))
      .for('update', { of: organizationMembers });
    const others = admins.filter((a) => a.userId !== userId).length;
    if (admins.some((a) => a.userId === userId) && others === 0) throw new ConflictError('LAST_ADMIN', 'Es el único administrador de la empresa: nombra a otro administrador antes de cambiarle el rol, desactivarlo o quitarlo');
  }

  /** Cambia el rol. Los ajustes de permisos se reinician (eran de la plantilla anterior). El último administrador no puede bajar de rol. */
  async changeRole(userId: string, role: TeamRole): Promise<{ before: TeamRole; after: TeamRole; name: string }> {
    const { orgId, actor } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const r = await this.load(tx, orgId, userId, true, 'active');
      const before = r.m.role as TeamRole;
      if (before === role) throw new ConflictError('ROLE_UNCHANGED', 'Esa persona ya tiene ese rol');
      if (before === 'client_admin') await this.guardLastAdmin(tx, orgId, userId);
      await tx.update(organizationMembers).set({ role }).where(eq(organizationMembers.id, r.m.id));
      await this.revokeOverrides(tx, r.m.id);
      await tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind: 'role_changed', before: { role: before }, after: { role } });
      return { before, after: role, name: r.fullName ?? r.email };
    });
  }

  /**
   * Guarda los ajustes de permisos de una persona (reemplaza los anteriores). Validados contra el techo de su rol y contra lo que tiene QUIEN los otorga (`holder`): nunca más
   * permisos que el administrador que los da. Devuelve lo de antes y lo de ahora para la auditoría.
   */
  async setOverrides(userId: string, overrides: { grant: PermissionKey[]; deny: PermissionKey[] }, holder: ReadonlySet<PermissionKey>): Promise<{ before: TeamMemberDetail['overrides']; after: TeamMemberDetail['overrides']; name: string }> {
    const { orgId, actor } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const r = await this.load(tx, orgId, userId, true, 'active');
      if (!isOverrideRole(r.m.role)) throw new NotFoundError();
      const issues = validateOverrides(r.m.role, overrides, holder);
      if (issues.length > 0) throw new ValidationError(issues.map((i) => ({ path: `permissions.${i.key}`, code: i.code.toLowerCase(), message: i.message })));
      const before = (await this.detail(tx, r)).overrides;
      await this.revokeOverrides(tx, r.m.id);
      const rows = [...overrides.grant.map((k) => ({ membershipId: r.m.id, permissionKey: k, effect: 'grant', grantedBy: actor })), ...overrides.deny.map((k) => ({ membershipId: r.m.id, permissionKey: k, effect: 'deny', grantedBy: actor }))];
      if (rows.length > 0) await tx.insert(memberPermissions).values(rows);
      await tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind: 'permissions_changed', before, after: overrides });
      return { before, after: overrides, name: r.fullName ?? r.email };
    });
  }

  /**
   * Saca a una persona del equipo: `deactivated` se puede reactivar; `removed` es definitivo (solo vuelve con una invitación nueva). Revoca sus sesiones en esta empresa. No se
   * puede a uno mismo ni al último administrador. La persona conserva su cuenta (puede pertenecer a otras empresas). Devuelve su nombre para el aviso en las conversaciones.
   */
  async leave(userId: string, reason: 'deactivated' | 'removed'): Promise<{ name: string; email: string; role: TeamRole; sessionsRevoked: number }> {
    const { orgId, actor } = this.ctx();
    if (userId === actor) throw new ConflictError('SELF_NOT_ALLOWED', 'No puedes hacerlo contigo mismo: pídeselo a otro administrador');
    return this.db.withIdentity(async (tx) => {
      // Quitar también sirve para una persona ya desactivada; desactivar, solo para una activa
      const r = await this.load(tx, orgId, userId, true, reason === 'deactivated' ? 'active' : 'any');
      if (r.m.role === 'client_admin' && r.m.revokedAt === null) await this.guardLastAdmin(tx, orgId, userId);
      const now = new Date();
      await tx.update(organizationMembers).set({ revokedAt: r.m.revokedAt ?? now, revokedReason: reason }).where(eq(organizationMembers.id, r.m.id));
      const revoked = await this.revokeSessionsIn(tx, orgId, userId, now, reason === 'removed' ? 'member_removed' : 'member_deactivated');
      await tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind: reason, before: { role: r.m.role }, after: { sessions_revoked: revoked } });
      return { name: r.fullName ?? r.email, email: r.email, role: r.m.role as TeamRole, sessionsRevoked: revoked };
    });
  }

  /** Reactiva a una persona desactivada: membresía nueva con su rol anterior y sus ajustes (la anterior queda como historia). */
  async reactivate(userId: string): Promise<{ name: string; role: TeamRole }> {
    const { orgId, actor } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const r = await this.load(tx, orgId, userId, true, 'deactivated');
      const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
      if (u?.status !== 'active') throw new ConflictError('ACCOUNT_INACTIVE', 'La cuenta de esa persona no está activa');
      const old = await this.activeOverrides(tx, r.m.id);
      const [m] = await tx.insert(organizationMembers).values({ userId, organizationId: orgId, role: r.m.role, grantedBy: actor }).returning({ id: organizationMembers.id });
      if (old.length > 0) await tx.insert(memberPermissions).values(old.map((o) => ({ membershipId: m!.id, permissionKey: o.k, effect: o.e, grantedBy: actor })));
      await tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind: 'reactivated', before: null, after: { role: r.m.role } });
      return { name: r.fullName ?? r.email, role: r.m.role as TeamRole };
    });
  }

  /** Cierra todas las sesiones de la persona en esta empresa (no las que tenga en otras). */
  async revokeSessions(userId: string): Promise<{ revoked: number; name: string }> {
    const { orgId, actor } = this.ctx();
    return this.db.withIdentity(async (tx) => {
      const r = await this.load(tx, orgId, userId, false);
      const revoked = await this.revokeSessionsIn(tx, orgId, userId, new Date(), 'admin_revoked');
      await tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind: 'sessions_revoked', before: null, after: { revoked } });
      return { revoked, name: r.fullName ?? r.email };
    });
  }

  private async revokeSessionsIn(tx: IdentityTx, orgId: string, userId: string, now: Date, reason: string): Promise<number> {
    const rows = await tx.update(sessions).set({ revokedAt: now, revokeReason: reason }).where(and(eq(sessions.userId, userId), eq(sessions.activeOrgId, orgId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
    return rows.length;
  }

  /**
   * Comprueba, SIN cambiar nada, que se puede sacar a esta persona (no es uno mismo ni el último administrador) y devuelve su nombre y rol. Sirve para decidir antes de tocar el
   * trabajo de la persona (sus conversaciones): `leave` vuelve a comprobarlo dentro de su transacción, con las filas bloqueadas.
   */
  async checkCanLeave(userId: string, reason: 'deactivated' | 'removed'): Promise<{ name: string; role: TeamRole; active: boolean }> {
    const { orgId, actor } = this.ctx();
    if (userId === actor) throw new ConflictError('SELF_NOT_ALLOWED', 'No puedes hacerlo contigo mismo: pídeselo a otro administrador');
    return this.db.withIdentity(async (tx) => {
      const r = await this.load(tx, orgId, userId, false, reason === 'deactivated' ? 'active' : 'any');
      const active = r.m.revokedAt === null;
      if (r.m.role === 'client_admin' && active && (await this.activeAdminCountIn(tx, orgId)) <= 1) throw new ConflictError('LAST_ADMIN', 'Es el único administrador de la empresa: nombra a otro administrador antes de cambiarle el rol, desactivarlo o quitarlo');
      return { name: r.fullName ?? r.email, role: r.m.role as TeamRole, active };
    });
  }

  private async activeAdminCountIn(tx: IdentityTx, orgId: string): Promise<number> {
    const rows = await tx.select({ id: organizationMembers.id }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)));
    return rows.length;
  }

  /** Anota un cambio del equipo que se hizo en otro módulo (p. ej. los departamentos de la persona) en la historia. */
  async log(kind: 'queues_changed', userId: string, before: unknown, after: unknown): Promise<void> {
    const { orgId, actor } = this.ctx();
    await this.db.withIdentity((tx) => tx.insert(memberHistory).values({ organizationId: orgId, userId, changedBy: actor, kind, before, after }));
  }

  /** Para las pruebas y para el aviso: ¿cuántos administradores vigentes tiene la empresa? */
  async activeAdminCount(): Promise<number> {
    const { orgId } = this.ctx();
    const rows = await this.db.withIdentity((tx) =>
      tx.select({ id: organizationMembers.id }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'))),
    );
    return rows.length;
  }

  /** Historia del equipo (más reciente primero), con paginación simple por número de filas. */
  async history(limit = 50): Promise<Array<{ at: string; kind: string; user_id: string | null; changed_by: string | null; before: unknown; after: unknown }>> {
    const { orgId } = this.ctx();
    const rows = await this.db.withIdentity((tx) => tx.select().from(memberHistory).where(eq(memberHistory.organizationId, orgId)).orderBy(desc(memberHistory.createdAt)).limit(limit));
    return rows.map((r) => ({ at: r.createdAt.toISOString(), kind: r.kind, user_id: r.userId, changed_by: r.changedBy, before: r.before, after: r.after }));
  }
}
