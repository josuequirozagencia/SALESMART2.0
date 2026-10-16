import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { Database } from '../../db';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { APP_CONFIG } from '../../tokens';

/** Debe coincidir con el tamaño de lote de la función SQL (migración 0014): un lote lleno significa que puede haber más. */
export const IDENTITY_CLEANUP_BATCH = 5000;

/**
 * Limpieza de las tablas de identidad (ADR-35). Llama a la ÚNICA función con privilegios de borrado
 * (`purge_expired_identity_rows`, SECURITY DEFINER sin parámetros): app_identity no tiene DELETE. Se repite mientras algún
 * lote venga lleno, de modo que un atraso grande se pone al día en una sola pasada sin transacciones largas.
 */
@Injectable()
export class IdentityCleanupJob implements ScheduledJob {
  readonly name = 'identity-cleanup';
  readonly intervalMs: number;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.intervalMs = cfg.jobs.identityCleanupIntervalMs;
  }

  async run(): Promise<number> {
    // Antes de purgar sesiones: se cierran las entradas de `access_sessions` cuya sesión ya terminó (ADR-41). La historia no depende de que la sesión exista.
    let total = await this.closeDeadAccessSessions();
    for (let guard = 0; guard < 1000; guard++) {
      const res = await this.db.withIdentity((tx) => tx.execute<{ table_name: string; purged: number }>(sql`SELECT table_name, purged FROM public.purge_expired_identity_rows()`));
      const purged = res.rows.map((r) => Number(r.purged));
      total += purged.reduce((a, b) => a + b, 0);
      if (!purged.some((n) => n >= IDENTITY_CLEANUP_BATCH)) return total;
    }
    return total; // tope de seguridad: la siguiente pasada continúa
  }

  /**
   * Cierra las entradas abiertas cuya sesión está revocada o vencida (fin = cuándo terminó la sesión) o ya no existe. Solo escribe `ended_at` y
   * `end_reason` (las únicas columnas que `app_identity` puede actualizar en `access_sessions`). Idempotente.
   */
  async closeDeadAccessSessions(): Promise<number> {
    const res = await this.db.withIdentity((tx) =>
      tx.execute<{ id: string }>(sql`
        UPDATE access_sessions a
           SET ended_at = GREATEST(a.started_at, COALESCE(s.revoked_at, LEAST(s.refresh_expires_at, s.absolute_expires_at), now())),
               end_reason = 'session_ended'
          FROM access_sessions x
          LEFT JOIN sessions s ON s.id = x.session_id
         WHERE a.id = x.id AND a.ended_at IS NULL
           AND (s.id IS NULL OR s.revoked_at IS NOT NULL OR s.refresh_expires_at <= now() OR s.absolute_expires_at <= now())
        RETURNING a.id`),
    );
    return res.rows.length;
  }
}
