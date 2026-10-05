import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { AppConfig } from '../../../config';
import { Database, disposableDomains, emailVerifications, organizationMembers, organizations, users } from '../../../db';
import { AppError, InvalidVerificationCodeError, ServiceUnavailableError, TooManyAttemptsError, ValidationError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import type { PasswordHasher } from '../../../security';
import { APP_CONFIG, APP_LOGGER } from '../../../tokens';
import { PASSWORD_HASHER } from '../auth.tokens';
import { CAPTCHA_VERIFIER, MAIL_PROVIDER, type CaptchaVerifier, type MailProvider } from './ports';
import { requireCaptcha } from './captcha-check';
import { SignupLimiter } from './signup-limiter';

export interface SignupInput {
  email: string;
  password: string;
  organizationName: string;
  timezone?: string;
  captchaToken: string;
  ip?: string;
}

/**
 * Registro y verificación de correo (M1.2).
 *  - Respuesta UNIFORME: signup/resend no revelan si el correo existe (misma respuesta, sin correo si ya hay cuenta).
 *  - La organización y la membresía `client_admin` se crean SOLO al verificar, en una transacción (nada de organizaciones huérfanas).
 *  - Código de 6 dígitos: se guarda su HMAC, caduca, tiene máximo de intentos y se invalida al agotarlos.
 *  - Correo y CAPTCHA son puertos; sin proveedor configurado el servicio responde 503 (no simula éxito).
 */
@Injectable()
export class SignupService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    @Inject(SignupLimiter) private readonly limiter: SignupLimiter,
  ) {}

  async signup(input: SignupInput): Promise<void> {
    this.assertAvailable();
    const s = this.cfg.signup;
    if (input.password.length < s.passwordMinLength) {
      throw new ValidationError([{ path: 'password', code: 'too_short', message: `Debe tener al menos ${s.passwordMinLength} caracteres` }]);
    }
    await this.guardIp(input.ip);
    await this.requireCaptcha(input.captchaToken, input.ip);
    await this.rejectDisposable(input.email);

    const passwordHash = await this.hasher.hash(input.password); // siempre se calcula: tiempo similar exista o no la cuenta
    if (!(await this.emailAllowed(input.email))) return;

    const code = this.newCode();
    const sent = await this.db.withIdentity(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id, status: users.status, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.email, input.email))
        .for('update');
      let userId: string;
      if (existing) {
        if (existing.status !== 'pending' || existing.verifiedAt !== null) return false; // cuenta ya real: no se toca ni se envía nada
        const [v] = await tx.select({ lastSentAt: emailVerifications.lastSentAt }).from(emailVerifications).where(eq(emailVerifications.userId, existing.id)).for('update');
        if (v && Date.now() - v.lastSentAt.getTime() < s.resendCooldownMs) return false;
        await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, existing.id));
        userId = existing.id;
      } else {
        const [created] = await tx.insert(users).values({ email: input.email, passwordHash, status: 'pending' }).onConflictDoNothing({ target: users.email }).returning({ id: users.id });
        if (!created) return false; // carrera: otro registro del mismo correo ganó
        userId = created.id;
      }
      await this.upsertVerification(tx, userId, code, { orgName: input.organizationName, timezone: input.timezone ?? 'UTC' });
      return true;
    });
    if (sent) await this.deliver(input.email, code);
  }

  async resend(input: { email: string; captchaToken: string; ip?: string }): Promise<void> {
    this.assertAvailable();
    await this.guardIp(input.ip);
    await this.requireCaptcha(input.captchaToken, input.ip);
    if (!(await this.emailAllowed(input.email))) return;
    const code = this.newCode();
    const cooldown = this.cfg.signup.resendCooldownMs;
    const sent = await this.db.withIdentity(async (tx) => {
      const [row] = await tx
        .select({ id: emailVerifications.id, userId: emailVerifications.userId, lastSentAt: emailVerifications.lastSentAt, orgName: emailVerifications.pendingOrgName, tz: emailVerifications.pendingTimezone })
        .from(emailVerifications)
        .innerJoin(users, eq(users.id, emailVerifications.userId))
        .where(and(eq(users.email, input.email), eq(users.status, 'pending'), sql`${users.emailVerifiedAt} IS NULL`, sql`${emailVerifications.consumedAt} IS NULL`))
        .for('update', { of: emailVerifications });
      if (!row || Date.now() - row.lastSentAt.getTime() < cooldown) return false;
      await this.upsertVerification(tx, row.userId, code, { orgName: row.orgName, timezone: row.tz });
      return true;
    });
    if (sent) await this.deliver(input.email, code);
  }

  async verify(input: { email: string; code: string; ip?: string }): Promise<void> {
    const ipLimit = await this.limiter.hit(this.limiter.keyFor('v', input.ip ?? 'unknown'), this.cfg.signup.verifyIpMaxPerHour);
    if (!ipLimit.allowed) throw new TooManyAttemptsError(ipLimit.retryAfterSeconds);

    const maxAttempts = this.cfg.signup.codeMaxAttempts;
    const ok = await this.db.withIdentity(async (tx) => {
      const [row] = await tx
        .select({ id: emailVerifications.id, userId: emailVerifications.userId, codeHmac: emailVerifications.codeHmac, expiresAt: emailVerifications.expiresAt, attempts: emailVerifications.attempts, orgName: emailVerifications.pendingOrgName, tz: emailVerifications.pendingTimezone })
        .from(emailVerifications)
        .innerJoin(users, eq(users.id, emailVerifications.userId))
        .where(and(eq(users.email, input.email), eq(users.status, 'pending'), sql`${users.emailVerifiedAt} IS NULL`, sql`${emailVerifications.consumedAt} IS NULL`))
        .for('update', { of: [emailVerifications, users] });
      if (!row) {
        this.codeHmac('00000000-0000-4000-8000-000000000000', input.code); // trabajo equivalente para correos inexistentes
        return false;
      }
      if (row.attempts >= maxAttempts || row.expiresAt.getTime() <= Date.now()) return false;
      const match = this.sameHmac(row.codeHmac, this.codeHmac(row.userId, input.code));
      if (!match) {
        // El intento fallido se confirma (commit) aunque la respuesta sea un error
        await tx.update(emailVerifications).set({ attempts: sql`${emailVerifications.attempts} + 1` }).where(eq(emailVerifications.id, row.id));
        return false;
      }
      const now = new Date();
      // Consumo condicional: aunque fallara el bloqueo de fila, solo UNA transacción puede consumir el código (defensa en profundidad)
      const consumed = await tx
        .update(emailVerifications)
        .set({ consumedAt: now })
        .where(and(eq(emailVerifications.id, row.id), sql`${emailVerifications.consumedAt} IS NULL`))
        .returning({ id: emailVerifications.id });
      if (consumed.length === 0) return false;
      const [org] = await tx.insert(organizations).values({ kind: 'client', name: row.orgName, timezone: row.tz }).returning({ id: organizations.id });
      await tx.insert(organizationMembers).values({ userId: row.userId, organizationId: org!.id, role: 'client_admin', grantedBy: null });
      await tx.update(users).set({ status: 'active', emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, row.userId));
      return true;
    });
    if (!ok) throw new InvalidVerificationCodeError();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private assertAvailable(): void {
    if (!this.mail.available || !this.captcha.available) throw new ServiceUnavailableError('SIGNUP_UNAVAILABLE', 'El registro no está disponible por el momento');
  }

  private async guardIp(ip?: string): Promise<void> {
    const r = await this.limiter.hit(this.limiter.keyFor('s', ip ?? 'unknown'), this.cfg.signup.ipMaxPerHour);
    if (!r.allowed) throw new TooManyAttemptsError(r.retryAfterSeconds);
  }

  /** Límite por correo: al superarlo la petición se ignora en silencio (misma respuesta 202; no revela nada). */
  private async emailAllowed(email: string): Promise<boolean> {
    return (await this.limiter.hit(this.limiter.keyFor('m', email), this.cfg.signup.emailMaxPerHour)).allowed;
  }

  private requireCaptcha(token: string, ip?: string): Promise<void> {
    return requireCaptcha(this.captcha, this.log, token, ip);
  }

  private async rejectDisposable(email: string): Promise<void> {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const hit = await this.db.withIdentity((tx) => tx.select({ d: disposableDomains.domain }).from(disposableDomains).where(eq(disposableDomains.domain, domain)).limit(1));
    if (hit.length > 0) throw new AppError(400, 'EMAIL_DOMAIN_NOT_ALLOWED', 'Usa un correo de trabajo o personal permanente');
  }

  private newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** HMAC ligado al usuario (un código no sirve para otra cuenta) y con separación de dominio respecto a las claves de throttle. */
  private codeHmac(userId: string, code: string): string {
    return createHmac('sha256', this.cfg.auth.throttleKey).update(`email-verification|${userId}|${code}`).digest('hex');
  }

  private sameHmac(a: string, b: string): boolean {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }

  private async upsertVerification(tx: Parameters<Parameters<Database['withIdentity']>[0]>[0], userId: string, code: string, pending: { orgName: string; timezone: string }): Promise<void> {
    const now = new Date();
    const values = {
      codeHmac: this.codeHmac(userId, code),
      expiresAt: new Date(now.getTime() + this.cfg.signup.codeTtlMs),
      attempts: 0,
      lastSentAt: now,
      pendingOrgName: pending.orgName,
      pendingTimezone: pending.timezone,
      consumedAt: null,
    };
    await tx
      .insert(emailVerifications)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: emailVerifications.userId, set: { ...values, sentCount: sql`${emailVerifications.sentCount} + 1` } });
  }

  /** El envío ocurre DESPUÉS de confirmar la transacción. Si el proveedor falla se registra y el usuario puede reenviar. */
  private async deliver(to: string, code: string): Promise<void> {
    try {
      await this.mail.sendVerificationCode({ to, code, expiresInMinutes: Math.round(this.cfg.signup.codeTtlMs / 60_000) });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al enviar el código de verificación');
    }
  }
}
