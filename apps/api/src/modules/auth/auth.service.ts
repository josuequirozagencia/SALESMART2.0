import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Database, organizationMembers, organizations, users } from '../../db';
import { TooManyAttemptsError, UnauthorizedError } from '../../errors';
import type { PasswordHasher } from '../../security';
import { PASSWORD_HASHER } from './auth.tokens';
import { SessionService, type AuthContext, type IssuedTokens } from './session.service';
import { ThrottleService } from './throttle.service';

export interface LoginResult {
  tokens: IssuedTokens;
  user: { id: string; email: string };
  organization: { id: string; name: string; kind: string };
  role: string;
}

/** Credencial inválida: mismo error para correo inexistente, contraseña errónea, usuario inactivo o sin organización. */
class InvalidCredentials extends UnauthorizedError {}

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async login(input: { email: string; password: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const eKey = this.throttle.keyFor('e', email);
    const iKey = this.throttle.keyFor('i', input.ip ?? 'unknown');

    // El bloqueo aplica igual exista o no la cuenta: no revela cuentas ni siquiera con la contraseña correcta
    const wait = await this.throttle.waitSeconds([eKey, iKey]);
    if (wait > 0) throw new TooManyAttemptsError(wait);

    const found = await this.db.withIdentity(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (!u) return null;
      const [m] = await tx
        .select({ orgId: organizations.id, name: organizations.name, kind: organizations.kind, role: organizationMembers.role })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(and(eq(organizationMembers.userId, u.id), isNull(organizationMembers.revokedAt), eq(organizations.status, 'active'), isNull(organizations.deletedAt)))
        .orderBy(asc(organizationMembers.createdAt))
        .limit(1);
      return { u, m };
    });

    // Siempre se ejecuta una verificación Argon2id (también para cuentas inexistentes): tiempo similar
    const hash = found?.u.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.hasher.verify(hash, input.password);
    const usable = !!found && !!found.m && found.u.status === 'active' && found.u.deletedAt === null && found.u.emailVerifiedAt !== null;

    if (!passwordOk || !usable) {
      await Promise.all([this.throttle.recordFailure(eKey), this.throttle.recordFailure(iKey)]);
      throw new InvalidCredentials();
    }
    const { u, m } = found as NonNullable<typeof found> & { m: NonNullable<NonNullable<typeof found>['m']> };
    await this.throttle.reset(eKey);
    const tokens = await this.sessions.create({ userId: u.id, organizationId: m.orgId, sessionVersion: u.sessionVersion, userAgent: input.userAgent });
    return { tokens, user: { id: u.id, email: u.email }, organization: { id: m.orgId, name: m.name, kind: m.kind }, role: m.role };
  }

  async refresh(rawRefresh: string | undefined): Promise<{ tokens: IssuedTokens; ctx: AuthContext }> {
    const r = await this.sessions.refresh(rawRefresh);
    if (!r.ok) throw new UnauthorizedError();
    return { tokens: r.tokens, ctx: r.ctx };
  }

  logout(raw: string | undefined): Promise<void> {
    return this.sessions.logoutWithToken(raw);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('contraseña-ficticia-no-valida');
    return this.dummyHash;
  }
}
