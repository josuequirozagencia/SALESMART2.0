import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { Database, type IdentityTx, organizations, sessions, trials, users } from '../../db';
import type { AppConfig } from '../../config';
import { isAccessLevel, type AccessLevel } from '../../rbac';
import { APP_CONFIG } from '../../tokens';
import { isTrialExpired } from '../organizations';
import { newToken, parseToken, sameHash } from './tokens';

/** Quién actúa dentro de una organización que no es la suya (ADR-41): el Súper Admin (soporte) o una persona de agencia en un cliente de su cartera. */
export type ActingAs = 'super_admin' | 'agency';

/**
 * ¿Quien tiene este rol, dentro de una organización de este tipo, está ACTUANDO en el contexto de otra? Se deriva siempre del rol verificado
 * y del tipo de organización (no se guarda ni se acepta del cliente): el Súper Admin fuera de la plataforma, y la agencia dentro de un cliente.
 */
export function actingFor(role: string, orgKind: string): ActingAs | null {
  if (role === 'super_admin' && orgKind !== 'platform') return 'super_admin';
  if (role === 'agency' && orgKind === 'client') return 'agency';
  return null;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  user: { email: string; fullName: string | null };
  organizationId: string;
  orgName: string;
  orgKind: 'platform' | 'agency' | 'client';
  role: string;
  /** Nivel de acceso de la membresía (solo las de agencia en un cliente lo tienen). */
  accessLevel: AccessLevel | null;
  /** Contexto de otra organización (ADR-41): el rol efectivo es el de la membresía (agencia) o el de soporte (Súper Admin, sin membresía). */
  actingAs: ActingAs | null;
  /** Organización con la que empezó la sesión: a ella se vuelve y de ella sale `acting_org_id`. */
  home: { id: string; name: string; kind: 'platform' | 'agency' | 'client' };
  /** Ajustes de permisos de ESTA persona en la organización activa (M10.3, ADR-56): lo concedido y lo quitado sobre la plantilla de su rol. Vacío si no tiene. */
  overrides: { grant: string[]; deny: string[] };
  /** Prueba gratuita vencida (por la hora, no por el estado materializado): la cuenta está en pausa (ADR-23 #5). */
  trialExpired: boolean;
  /** Quien actúa en una empresa en pausa o con nivel «lectura» solo puede ver (ADR-41). */
  readOnly: boolean;
}
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}
export type RefreshResult = { ok: true; tokens: IssuedTokens; ctx: AuthContext } | { ok: false };

const trimUa = (ua: string | undefined) => (ua ? ua.slice(0, 200) : null);

/**
 * Ciclo de vida de sesiones (ADR-26). Todo el acceso a datos pasa por Database.withIdentity (rol app_identity).
 * Estado verificado en CADA petición: sesión vigente y no revocada, usuario activo, versión de sesión, organización
 * activa y membresía vigente (Build Spec §4.1.5 y §11.6).
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async create(input: { userId: string; organizationId: string; sessionVersion: number; userAgent?: string }, now = new Date()): Promise<IssuedTokens & { sessionId: string }> {
    const id = uuidv7();
    const access = newToken(id);
    const refresh = newToken(id);
    const accessExpiresAt = new Date(now.getTime() + this.cfg.auth.accessTtlMs);
    const absoluteExpiresAt = new Date(now.getTime() + this.cfg.auth.sessionAbsoluteTtlMs);
    const refreshExpiresAt = new Date(Math.min(now.getTime() + this.cfg.auth.refreshTtlMs, absoluteExpiresAt.getTime()));
    await this.db.withIdentity((tx) =>
      tx.insert(sessions).values({
        id,
        userId: input.userId,
        activeOrgId: input.organizationId,
        homeOrgId: input.organizationId,
        userSessionVersion: input.sessionVersion,
        accessHash: access.hash,
        accessExpiresAt,
        refreshHash: refresh.hash,
        refreshExpiresAt,
        absoluteExpiresAt,
        userAgent: trimUa(input.userAgent),
      }),
    );
    return { sessionId: id, accessToken: access.token, refreshToken: refresh.token, accessExpiresAt, refreshExpiresAt };
  }

  /** Devuelve el contexto verificado o null (sin distinguir el motivo: no filtra información). */
  async authenticate(rawAccess: string | undefined, now = new Date()): Promise<AuthContext | null> {
    const t = parseToken(rawAccess);
    if (!t) return null;
    const row = await this.load(t.sessionId);
    if (!row || !sameHash(row.s.accessHash, t.hash)) return null;
    if (row.s.accessExpiresAt <= now) return null;
    return this.validState(row, now) ? this.ctx(row, now) : null;
  }

  async refresh(rawRefresh: string | undefined, now = new Date()): Promise<RefreshResult> {
    const t = parseToken(rawRefresh);
    if (!t) return { ok: false };
    return this.db.withIdentity(async (tx): Promise<RefreshResult> => {
      // Bloqueo de la fila: dos refrescos simultáneos no pueden rotar ambos
      const [s] = await tx.select().from(sessions).where(eq(sessions.id, t.sessionId)).for('update').limit(1);
      if (!s || s.revokedAt) return { ok: false };
      const revoke = async (reason: string): Promise<RefreshResult> => {
        await tx.update(sessions).set({ revokedAt: now, revokeReason: reason }).where(eq(sessions.id, s.id));
        return { ok: false };
      };
      // Un refresh que no coincide (ya rotado o robado) → se revoca la sesión entera
      if (!sameHash(s.refreshHash, t.hash)) return revoke('refresh_reuse');
      if (s.refreshExpiresAt <= now || s.absoluteExpiresAt <= now) return revoke('expired');
      const row = await this.loadIn(tx, s.id);
      if (!row || !this.validState(row, now)) return revoke('invalid_state');

      const access = newToken(s.id);
      const refresh = newToken(s.id);
      const accessExpiresAt = new Date(now.getTime() + this.cfg.auth.accessTtlMs);
      const refreshExpiresAt = new Date(Math.min(now.getTime() + this.cfg.auth.refreshTtlMs, s.absoluteExpiresAt.getTime()));
      await tx
        .update(sessions)
        .set({ accessHash: access.hash, accessExpiresAt, refreshHash: refresh.hash, refreshExpiresAt, lastRefreshedAt: now })
        .where(eq(sessions.id, s.id));
      return { ok: true, tokens: { accessToken: access.token, refreshToken: refresh.token, accessExpiresAt, refreshExpiresAt }, ctx: this.ctx(row, now) };
    });
  }

  /** Cierra la sesión si el token (access o refresh) es válido para ella. Siempre idempotente. */
  async logoutWithToken(raw: string | undefined, now = new Date()): Promise<void> {
    const t = parseToken(raw);
    if (!t) return;
    await this.db.withIdentity(async (tx) => {
      const [s] = await tx.select().from(sessions).where(eq(sessions.id, t.sessionId)).for('update').limit(1);
      if (!s || s.revokedAt) return;
      if (!sameHash(s.accessHash, t.hash) && !sameHash(s.refreshHash, t.hash)) return;
      await tx.update(sessions).set({ revokedAt: now, revokeReason: 'logout' }).where(eq(sessions.id, s.id));
    });
  }

  /** Contexto VERIFICADO de una sesión (misma validación que cada petición) o null. Para `/auth/me`. */
  async contextOf(sessionId: string, now = new Date()): Promise<AuthContext | null> {
    return this.db.withIdentity((tx) => this.contextIn(tx, sessionId, now));
  }

  /** Igual que `contextOf` dentro de una transacción de identidad ya abierta (el cambio de contexto lo relee tras escribir). */
  async contextIn(tx: IdentityTx, sessionId: string, now = new Date()): Promise<AuthContext | null> {
    const row = await this.loadIn(tx, sessionId);
    return row && this.validState(row, now) ? this.ctx(row, now) : null;
  }

  private load(sessionId: string) {
    return this.db.withIdentity((tx) => this.loadIn(tx, sessionId));
  }

  private async loadIn(tx: IdentityTx, sessionId: string) {
    const [r] = await tx
      .select({
        s: sessions,
        userEmail: users.email,
        userFullName: users.fullName,
        userStatus: users.status,
        userDeletedAt: users.deletedAt,
        userVersion: users.sessionVersion,
        orgStatus: organizations.status,
        orgDeletedAt: organizations.deletedAt,
        orgKind: organizations.kind,
        orgName: organizations.name,
        orgPlanId: organizations.planId,
        // Subconsultas correlacionadas (una sola ida a la BD): drizzle tipa como never el leftJoin sobre IdentityTx.
        // Membresía VIGENTE en la organización activa: si se revoca, la sesión deja de valer al instante (ADR-40).
        memberRole: sql<string | null>`(SELECT m.role FROM organization_members m WHERE m.user_id = ${sessions.userId} AND m.organization_id = ${sessions.activeOrgId} AND m.revoked_at IS NULL LIMIT 1)`,
        memberLevel: sql<string | null>`(SELECT m.access_level FROM organization_members m WHERE m.user_id = ${sessions.userId} AND m.organization_id = ${sessions.activeOrgId} AND m.revoked_at IS NULL LIMIT 1)`,
        // Ajustes de permisos por persona (M10.3): se leen en la misma ida a la BD, así que un cambio rige desde la petición siguiente.
        memberOverrides: sql<Array<{ k: string; e: string }> | null>`(SELECT json_agg(json_build_object('k', p.permission_key, 'e', p.effect)) FROM member_permissions p WHERE p.revoked_at IS NULL AND p.membership_id = (SELECT m.id FROM organization_members m WHERE m.user_id = ${sessions.userId} AND m.organization_id = ${sessions.activeOrgId} AND m.revoked_at IS NULL LIMIT 1))`,
        // Soporte (ADR-41): el Súper Admin entra a otra organización SIN membresía en ella; su derecho es la membresía `super_admin` VIGENTE en la plataforma.
        isSuperAdmin: sql<boolean>`EXISTS (SELECT 1 FROM organization_members m JOIN organizations po ON po.id = m.organization_id WHERE m.user_id = ${sessions.userId} AND m.role = 'super_admin' AND m.revoked_at IS NULL AND po.kind = 'platform' AND po.status = 'active' AND po.deleted_at IS NULL)`,
        homeName: sql<string | null>`(SELECT h.name FROM organizations h WHERE h.id = ${sessions.homeOrgId})`,
        homeKind: sql<string | null>`(SELECT h.kind FROM organizations h WHERE h.id = ${sessions.homeOrgId})`,
        // Organizaciones sin prueba (plataforma, agencia, clientes de pago futuros) → null → nunca están en pausa.
        trialStatus: sql<string | null>`(SELECT ${trials.status} FROM ${trials} WHERE ${trials.organizationId} = ${sessions.activeOrgId})`,
        trialEndsAt: sql<Date | null>`(SELECT ${trials.endsAt} FROM ${trials} WHERE ${trials.organizationId} = ${sessions.activeOrgId})`.mapWith((v: string | Date | null) => (v === null ? null : new Date(v))),
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, sessions.activeOrgId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!r) return undefined;
    // Rol efectivo: el de la membresía vigente; sin membresía, solo el Súper Admin vigente entra (soporte), y nunca «a» la plataforma sin membresía
    const role = r.memberRole ?? (r.isSuperAdmin && r.orgKind !== 'platform' ? 'super_admin' : null);
    return { ...r, role };
  }

  private validState(r: NonNullable<Awaited<ReturnType<SessionService['load']>>>, now: Date): r is typeof r & { role: string } {
    return (
      r.role !== null &&
      r.s.revokedAt === null &&
      r.s.absoluteExpiresAt > now &&
      r.userStatus === 'active' &&
      r.userDeletedAt === null &&
      r.userVersion === r.s.userSessionVersion &&
      r.orgStatus === 'active' &&
      r.orgDeletedAt === null
    );
  }

  private ctx(r: NonNullable<Awaited<ReturnType<SessionService['load']>>> & { role: string }, now: Date): AuthContext {
    // Con un plan asignado la empresa ya no depende de la prueba (ADR-38): no se pausa aunque su prueba haya vencido
    const trialExpired = r.orgPlanId === null && r.trialStatus !== null && r.trialEndsAt !== null && isTrialExpired({ status: r.trialStatus, endsAt: r.trialEndsAt }, now);
    const actingAs = actingFor(r.role, r.orgKind);
    const accessLevel = isAccessLevel(r.memberLevel) ? r.memberLevel : null;
    // Quien actúa solo lee si su nivel es «lectura» (un nivel desconocido se trata como lectura: falla hacia lo seguro) o si la empresa está en pausa
    const readOnly = actingAs === 'agency' ? accessLevel === null || accessLevel === 'read' || trialExpired : actingAs === 'super_admin' ? r.orgKind === 'client' && trialExpired : false;
    return {
      sessionId: r.s.id,
      userId: r.s.userId,
      user: { email: r.userEmail, fullName: r.userFullName },
      organizationId: r.s.activeOrgId,
      orgName: r.orgName,
      orgKind: r.orgKind as AuthContext['orgKind'],
      role: r.role,
      accessLevel,
      actingAs,
      overrides: {
        grant: (r.memberOverrides ?? []).filter((o) => o.e === 'grant').map((o) => o.k),
        deny: (r.memberOverrides ?? []).filter((o) => o.e === 'deny').map((o) => o.k),
      },
      home: { id: r.s.homeOrgId, name: r.homeName ?? '', kind: (r.homeKind ?? 'client') as AuthContext['home']['kind'] },
      trialExpired,
      readOnly,
    };
  }
}
