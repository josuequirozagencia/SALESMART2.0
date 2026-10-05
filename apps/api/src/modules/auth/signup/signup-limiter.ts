import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../../config';
import { Database, signupAttempts } from '../../../db';
import { APP_CONFIG } from '../../../tokens';

export type LimitKind = 's' | 'v' | 'm' | 'f' | 'r' | 'x';
const HOUR_MS = 3_600_000;

/**
 * Contadores de ventana fija (1 h) en PostgreSQL para el registro. Claves HMAC (nunca IP/correo en claro):
 *  s = registros y reenvíos por IP · v = intentos de verificación por IP · m = solicitudes por correo ·
 *  f = «olvidé mi contraseña» por IP · r = ídem por correo · x = intentos de /reset por IP.
 */
@Injectable()
export class SignupLimiter {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  keyFor(kind: LimitKind, value: string): string {
    return `${kind}:${createHmac('sha256', this.cfg.auth.throttleKey).update(`limit|${kind}|${value.trim().toLowerCase()}`).digest('hex')}`;
  }

  /** Cuenta un intento (atómico). allowed=false cuando se supera `limit` dentro de la ventana. */
  async hit(key: string, limit: number, now = new Date()): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const cutoff = new Date(now.getTime() - HOUR_MS);
    const [row] = await this.db.withIdentity((tx) =>
      tx
        .insert(signupAttempts)
        .values({ key, count: 1, windowStartedAt: now })
        .onConflictDoUpdate({
          target: signupAttempts.key,
          set: {
            count: sql`CASE WHEN ${signupAttempts.windowStartedAt} < ${cutoff} THEN 1 ELSE ${signupAttempts.count} + 1 END`,
            windowStartedAt: sql`CASE WHEN ${signupAttempts.windowStartedAt} < ${cutoff} THEN ${now} ELSE ${signupAttempts.windowStartedAt} END`,
          },
        })
        .returning({ count: signupAttempts.count, windowStartedAt: signupAttempts.windowStartedAt }),
    );
    const count = row?.count ?? 1;
    const started = row?.windowStartedAt ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((started.getTime() + HOUR_MS - now.getTime()) / 1000));
    return { allowed: count <= limit, retryAfterSeconds };
  }
}
