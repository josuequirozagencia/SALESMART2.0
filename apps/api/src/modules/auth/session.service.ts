import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import { Database, type IdentityTx, organizationMembers, organizations, sessions, users } from '../../db';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { newToken, parseToken, sameHash } from './tokens';

export interface AuthContext {
  sessionId: string;
  userId: string;
  organizationId: string;
  orgKind: 'platform' | 'agency' | 'client';
  role: string;
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
    return this.validState(row, now) ? this.ctx(row) : null;
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
      return { ok: true, tokens: { accessToken: access.token, refreshToken: refresh.token, accessExpiresAt, refreshExpiresAt }, ctx: this.ctx(row) };
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

  private load(sessionId: string) {
    return this.db.withIdentity((tx) => this.loadIn(tx, sessionId));
  }

  private async loadIn(tx: IdentityTx, sessionId: string) {
    const [r] = await tx
      .select({
        s: sessions,
        userStatus: users.status,
        userDeletedAt: users.deletedAt,
        userVersion: users.sessionVersion,
        orgStatus: organizations.status,
        orgDeletedAt: organizations.deletedAt,
        orgKind: organizations.kind,
        role: organizationMembers.role,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, sessions.activeOrgId))
      // INNER JOIN a la membresía VIGENTE: si se revoca, la sesión deja de valer al instante
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.userId, sessions.userId), eq(organizationMembers.organizationId, sessions.activeOrgId), isNull(organizationMembers.revokedAt)),
      )
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return r;
  }

  private validState(r: NonNullable<Awaited<ReturnType<SessionService['load']>>>, now: Date): boolean {
    return (
      r.s.revokedAt === null &&
      r.s.absoluteExpiresAt > now &&
      r.userStatus === 'active' &&
      r.userDeletedAt === null &&
      r.userVersion === r.s.userSessionVersion &&
      r.orgStatus === 'active' &&
      r.orgDeletedAt === null
    );
  }

  private ctx(r: NonNullable<Awaited<ReturnType<SessionService['load']>>>): AuthContext {
    return { sessionId: r.s.id, userId: r.s.userId, organizationId: r.s.activeOrgId, orgKind: r.orgKind as AuthContext['orgKind'], role: r.role };
  }
}
