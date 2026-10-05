import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import type { AppConfig } from '../../../config';
import { Database, passwordResets, sessions, users } from '../../../db';
import { AppError, InvalidResetTokenError, ServiceUnavailableError, TooManyAttemptsError, UnauthorizedError, ValidationError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import type { PasswordHasher } from '../../../security';
import { APP_CONFIG, APP_LOGGER } from '../../../tokens';
import { PASSWORD_HASHER } from '../auth.tokens';
import { requireCaptcha } from '../signup/captcha-check';
import { CAPTCHA_VERIFIER, MAIL_PROVIDER, type CaptchaVerifier, type MailProvider } from '../signup/ports';
import { SignupLimiter } from '../signup/signup-limiter';
import { ThrottleService } from '../throttle.service';
import { hashSecret, parseToken, sameHash } from '../tokens';

/**
 * Olvido / restablecimiento / cambio de contraseña (M1.3).
 *  - `forgot` responde SIEMPRE lo mismo (exista o no la cuenta; límites en silencio).
 *  - Token opaco de un solo uso con caducidad; en BD solo su SHA-256. Todo fallo de `reset` es el mismo 400.
 *  - Cambiar/restablecer la contraseña sube `users.session_version` y revoca las sesiones (las de otros dispositivos
 *    siempre; la actual se conserva solo en el cambio voluntario).
 */
@Injectable()
export class PasswordService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    @Inject(SignupLimiter) private readonly limiter: SignupLimiter,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
  ) {}

  async forgot(input: { email: string; captchaToken: string; ip?: string }): Promise<void> {
    const linkBase = this.cfg.frontend.resetLinkBase;
    if (!this.mail.available || !this.captcha.available || linkBase === undefined) throw new ServiceUnavailableError('PASSWORD_RESET_UNAVAILABLE', 'El restablecimiento de contraseña no está disponible por el momento');
    const r = this.cfg.reset;
    const ipHit = await this.limiter.hit(this.limiter.keyFor('f', input.ip ?? 'unknown'), r.ipMaxPerHour);
    if (!ipHit.allowed) throw new TooManyAttemptsError(ipHit.retryAfterSeconds);
    await requireCaptcha(this.captcha, this.log, input.captchaToken, input.ip);
    if (!(await this.limiter.hit(this.limiter.keyFor('r', input.email), r.emailMaxPerHour)).allowed) return; // en silencio

    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const token = `${id}.${secret}`;
    const sent = await this.db.withIdentity(async (tx) => {
      const [u] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, input.email), eq(users.status, 'active'), sql`${users.emailVerifiedAt} IS NOT NULL`, isNull(users.deletedAt)))
        .for('update');
      if (!u) return false; // sin cuenta utilizable: misma respuesta, sin correo
      const [prev] = await tx.select({ lastSentAt: passwordResets.lastSentAt }).from(passwordResets).where(eq(passwordResets.userId, u.id)).for('update');
      if (prev && Date.now() - prev.lastSentAt.getTime() < r.cooldownMs) return false;
      const now = new Date();
      const values = { id, tokenHash: hashSecret(secret), expiresAt: new Date(now.getTime() + r.tokenTtlMs), consumedAt: null, lastSentAt: now };
      // Al reemplazar la fila el token anterior deja de existir (id distinto)
      await tx
        .insert(passwordResets)
        .values({ userId: u.id, ...values })
        .onConflictDoUpdate({ target: passwordResets.userId, set: { ...values, sentCount: sql`${passwordResets.sentCount} + 1` } });
      return true;
    });
    if (!sent) return;
    try {
      await this.mail.sendPasswordReset({ to: input.email, resetUrl: `${linkBase}#token=${token}`, expiresInMinutes: Math.round(r.tokenTtlMs / 60_000) });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al enviar el restablecimiento');
    }
  }

  async reset(input: { token: string; newPassword: string; ip?: string }): Promise<void> {
    const ipHit = await this.limiter.hit(this.limiter.keyFor('x', input.ip ?? 'unknown'), this.cfg.reset.attemptIpMaxPerHour);
    if (!ipHit.allowed) throw new TooManyAttemptsError(ipHit.retryAfterSeconds);
    this.assertPasswordPolicy(input.newPassword);
    const parsed = parseToken(input.token);
    if (!parsed) throw new InvalidResetTokenError();

    const newHash = await this.hasher.hash(input.newPassword);
    const email = await this.db.withIdentity(async (tx): Promise<string | null> => {
      const [row] = await tx
        .select({ id: passwordResets.id, userId: passwordResets.userId, tokenHash: passwordResets.tokenHash, expiresAt: passwordResets.expiresAt, consumedAt: passwordResets.consumedAt, email: users.email, status: users.status, verifiedAt: users.emailVerifiedAt, deletedAt: users.deletedAt })
        .from(passwordResets)
        .innerJoin(users, eq(users.id, passwordResets.userId))
        .where(eq(passwordResets.id, parsed.sessionId))
        .for('update', { of: [passwordResets, users] });
      if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now() || !sameHash(row.tokenHash, parsed.hash)) return null;
      if (row.status !== 'active' || row.verifiedAt === null || row.deletedAt !== null) return null;
      const now = new Date();
      // Consumo condicional: aunque fallara el bloqueo de fila, solo una transacción puede usar el token
      const used = await tx.update(passwordResets).set({ consumedAt: now }).where(and(eq(passwordResets.id, row.id), isNull(passwordResets.consumedAt))).returning({ id: passwordResets.id });
      if (used.length === 0) return null;
      await tx.update(users).set({ passwordHash: newHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, row.userId));
      await tx.update(sessions).set({ revokedAt: now, revokeReason: 'password_reset' }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
      return row.email;
    });
    if (email === null) throw new InvalidResetTokenError();
    // Quien restablece demuestra control del correo: se levanta el bloqueo por intentos de acceso de esa cuenta
    await this.throttle.reset(this.throttle.keyFor('e', email));
  }

  /** Cambio voluntario (usuario autenticado). Conserva la sesión actual; revoca las demás. */
  async change(input: { userId: string; sessionId: string; currentPassword: string; newPassword: string }): Promise<void> {
    this.assertPasswordPolicy(input.newPassword);
    const [u] = await this.db.withIdentity((tx) => tx.select({ email: users.email, hash: users.passwordHash }).from(users).where(eq(users.id, input.userId)).limit(1));
    if (!u) throw new UnauthorizedError();
    const eKey = this.throttle.keyFor('e', u.email);
    const wait = await this.throttle.waitSeconds([eKey]);
    if (wait > 0) throw new TooManyAttemptsError(wait);
    if (!(await this.hasher.verify(u.hash, input.currentPassword))) {
      await this.throttle.recordFailure(eKey); // una sesión robada no puede adivinar la contraseña actual sin límite
      throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta');
    }
    if (input.currentPassword === input.newPassword) throw new ValidationError([{ path: 'new_password', code: 'same_as_current', message: 'La nueva contraseña debe ser distinta de la actual' }]);
    const newHash = await this.hasher.hash(input.newPassword);
    await this.db.withIdentity(async (tx) => {
      const now = new Date();
      const [bumped] = await tx
        .update(users)
        .set({ passwordHash: newHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(and(eq(users.id, input.userId), eq(users.passwordHash, u.hash))) // si cambió entre medias, no se pisa
        .returning({ v: users.sessionVersion });
      if (!bumped) throw new AppError(409, 'CONFLICT', 'La contraseña cambió mientras se procesaba la solicitud. Inténtalo de nuevo');
      await tx.update(sessions).set({ revokedAt: now, revokeReason: 'password_change' }).where(and(eq(sessions.userId, input.userId), ne(sessions.id, input.sessionId), isNull(sessions.revokedAt)));
      await tx.update(sessions).set({ userSessionVersion: bumped.v }).where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId), isNull(sessions.revokedAt)));
    });
    await this.throttle.reset(eKey);
  }

  private assertPasswordPolicy(pw: string): void {
    const min = this.cfg.signup.passwordMinLength;
    if (pw.length < min) throw new ValidationError([{ path: 'new_password', code: 'too_short', message: `Debe tener al menos ${min} caracteres` }]);
  }
}
