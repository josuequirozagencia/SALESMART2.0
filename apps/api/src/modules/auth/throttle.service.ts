import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { authThrottle, Database } from '../../db';
import { APP_CONFIG } from '../../tokens';

/**
 * Limitación de intentos de acceso en PostgreSQL (sin Redis, ver M1_PLAN). Las claves son HMAC del correo/IP:
 * funciona igual para correos inexistentes (no revela cuentas) y no guarda datos personales en claro.
 */
@Injectable()
export class ThrottleService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  keyFor(kind: 'e' | 'i', value: string): string {
    return `${kind}:${createHmac('sha256', this.cfg.auth.throttleKey).update(`${kind}|${value.trim().toLowerCase()}`).digest('hex')}`;
  }

  /** Segundos de espera restantes (0 = puede intentar). */
  async waitSeconds(keys: readonly string[], now = new Date()): Promise<number> {
    const rows = await this.db.withIdentity((tx) => tx.select({ lockedUntil: authThrottle.lockedUntil }).from(authThrottle).where(inArray(authThrottle.key, [...keys])));
    const max = Math.max(0, ...rows.map((r) => (r.lockedUntil ? r.lockedUntil.getTime() - now.getTime() : 0)));
    return max > 0 ? Math.ceil(max / 1000) : 0;
  }

  /** Registra un fallo de forma atómica (UPSERT) y calcula el bloqueo. */
  async recordFailure(key: string, now = new Date()): Promise<void> {
    const a = this.cfg.auth;
    const threshold = key.startsWith('i:') ? a.ipLockThreshold : a.accountLockThreshold;
    await this.db.withIdentity(async (tx) => {
      // fila nueva o ventana vencida → reinicia el contador; si no, suma 1
      const [row] = await tx
        .insert(authThrottle)
        .values({ key, failures: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: authThrottle.key,
          set: {
            failures: sql`CASE WHEN ${authThrottle.updatedAt} < ${new Date(now.getTime() - a.failureWindowMs)} THEN 1 ELSE ${authThrottle.failures} + 1 END`,
            updatedAt: now,
          },
        })
        .returning({ failures: authThrottle.failures });
      const failures = row?.failures ?? 0;
      const wait = failures < threshold ? 0 : Math.min(a.lockBaseMs * 2 ** (failures - threshold), a.lockMaxMs);
      if (wait > 0) await tx.update(authThrottle).set({ lockedUntil: new Date(now.getTime() + wait) }).where(eq(authThrottle.key, key));
    });
  }

  async reset(key: string): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(authThrottle).set({ failures: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(authThrottle.key, key)));
  }
}
