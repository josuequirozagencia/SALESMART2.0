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
    let total = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const res = await this.db.withIdentity((tx) => tx.execute<{ table_name: string; purged: number }>(sql`SELECT table_name, purged FROM public.purge_expired_identity_rows()`));
      const purged = res.rows.map((r) => Number(r.purged));
      total += purged.reduce((a, b) => a + b, 0);
      if (!purged.some((n) => n >= IDENTITY_CLEANUP_BATCH)) return total;
    }
    return total; // tope de seguridad: la siguiente pasada continúa
  }
}
