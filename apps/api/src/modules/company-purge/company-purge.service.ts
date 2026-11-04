import { Inject, Injectable } from '@nestjs/common';
import { Database, qrAccounts } from '../../db';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { StorageError, StorageGateway } from '../attachments';
import { CompanyPurgeStore, type PurgeJob } from '../auth';
import { PlatformAuditService } from '../platform';
import { isRetryableQr, QR_SESSION, QrConnectionsService, QrSessionError, type QrSessionProvider } from '../qr';

/** Pasadas máximas de la función de borrado en una sola ronda, y tiempo máximo: lo que falte se retoma en la siguiente ronda (la función es reanudable). */
const MAX_PASSES = 2000;
const TIME_BUDGET_MS = 8 * 60_000;
/** Después de tantos intentos fallidos con Evolution se sigue adelante (y se anota): una instancia huérfana no debe impedir el borrado de los datos. */
const QR_GIVE_UP_AFTER = 3;

export type PurgeOutcome =
  | { kind: 'done'; counts: Record<string, unknown> }
  | { kind: 'more' } // hubo avance pero se acabó el tiempo de esta ronda: se retoma en la siguiente
  | { kind: 'failed'; code: PurgeFailureCode; retryAfterMs: number };

export type PurgeFailureCode = 'QR_CLEANUP_FAILED' | 'STORAGE_UNAVAILABLE' | 'STORAGE_RESIDUE' | 'DB_INCOMPLETE' | 'IDENTITY_FAILED';

const HOUR = 3_600_000;

/**
 * El borrado definitivo de UNA empresa eliminada cuyo plazo venció (F3c, ADR-59 #10–12). En este orden, y cada paso se puede repetir sin daño:
 *  1. Evolution: cierra la sesión de WhatsApp y borra la instancia de cada conexión por QR (los nombres de instancia solo existen en la base de datos, por eso va antes).
 *  2. Archivos: todo lo que cuelga de `org/<id>/` en el almacenamiento (adjuntos, biblioteca, paquetes de descarga) y comprobación de que no quedó nada.
 *  3. Base de datos: la función `purge_company_step` hasta que una pasada no borre nada y no quede ninguna fila.
 *  4. Identidad: la función `purge_company_identity` (rutas, invitaciones, sesiones, membresías, personas exclusivas) y la lápida de la empresa.
 * Solo entonces queda `purged`, con la evidencia (filas borradas por tabla) en la eliminación y en la auditoría de plataforma. Un fallo deja `purge_failed` con un código genérico y se reintenta.
 */
@Injectable()
export class CompanyPurgeService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CompanyPurgeStore) private readonly store: CompanyPurgeStore,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(QrConnectionsService) private readonly qr: QrConnectionsService,
    @Inject(QR_SESSION) private readonly qrProvider: QrSessionProvider,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async purge(job: PurgeJob, beat: () => Promise<void>, now = new Date()): Promise<PurgeOutcome> {
    const retryAfterMs = Math.min(30 * 60_000 * Math.max(1, job.attempts), 6 * HOUR);
    const counts: Record<string, unknown> = {};

    // 1 · Evolution
    const qr = await this.cleanQr(job);
    if (qr === 'retry') return { kind: 'failed', code: 'QR_CLEANUP_FAILED', retryAfterMs };
    counts['qr'] = qr;
    await beat();

    // 2 · Archivos
    let files: number | 'skipped';
    try {
      files = await this.cleanFiles(job.organizationId);
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', deletionId: job.deletionId }, 'no se pudieron borrar los archivos de la empresa (se reintenta)');
      return { kind: 'failed', code: e instanceof StorageError && e.code === 'not_configured' ? 'STORAGE_UNAVAILABLE' : e instanceof ResidueError ? 'STORAGE_RESIDUE' : 'STORAGE_UNAVAILABLE', retryAfterMs };
    }
    counts['files'] = files;
    await beat();

    // 3 · Base de datos
    const started = Date.now();
    const tables: Record<string, number> = {};
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const rows = await this.store.step(job.organizationId);
      let deleted = 0;
      let remaining = 0;
      for (const r of rows) {
        deleted += r.deleted;
        remaining += r.remaining;
        if (r.deleted > 0) tables[r.table] = (tables[r.table] ?? 0) + r.deleted;
      }
      await beat();
      if (deleted === 0) {
        if (remaining > 0) return { kind: 'failed', code: 'DB_INCOMPLETE', retryAfterMs };
        break; // una pasada completa sin borrar nada y sin filas restantes: esa es la evidencia
      }
      if (Date.now() - started > TIME_BUDGET_MS) return { kind: 'more' };
    }
    counts['tables'] = tables;

    // 4 · Identidad y lápida
    try {
      counts['identity'] = await this.store.identity(job.organizationId);
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', deletionId: job.deletionId }, 'no se pudo borrar la identidad de la empresa (se reintenta)');
      return { kind: 'failed', code: 'IDENTITY_FAILED', retryAfterMs };
    }

    await this.store.complete(job.deletionId, counts, now);
    try {
      await this.audit.recordAs(job.requestedBy, {
        action: 'company.purged',
        entityType: 'organization',
        entityId: job.organizationId,
        targetOrgId: job.organizationId,
        details: { deletion_id: job.deletionId, name: job.organizationName, kind: job.kind, attempts: job.attempts, ...counts },
      });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', deletionId: job.deletionId }, 'auditoría company.purged falló (el borrado ya está confirmado)');
    }
    // Esta línea queda en el registro de la aplicación, FUERA de la base: si algún día se restaura una copia antigua, de aquí (y de la auditoría de plataforma) sale la lista de empresas a volver a borrar
    this.log.warn({ organizationId: job.organizationId, deletionId: job.deletionId }, 'empresa borrada definitivamente');
    return { kind: 'done', counts };
  }

  /** Cierra la sesión y borra la instancia de cada conexión por QR de la empresa. `retry`: Evolution no respondió (se reintenta); si ya se intentó varias veces se sigue y se anota. */
  private async cleanQr(job: PurgeJob): Promise<{ instances: number; failed: number; skipped: boolean } | 'retry'> {
    const instances = await TenantContext.run({ organizationId: job.organizationId, userId: job.requestedBy, actingAs: 'super_admin' }, () => this.db.withTenant((tx) => tx.select({ instance: qrAccounts.instanceName }).from(qrAccounts)));
    if (instances.length === 0) return { instances: 0, failed: 0, skipped: false };
    const creds = await this.qr.credentials();
    if (!creds) {
      // Sin la URL y la clave de Evolution no hay forma de hablarle: se anota y se sigue (si no, nunca se podría borrar la empresa)
      this.log.warn({ deletionId: job.deletionId, instances: instances.length }, 'Evolution no está configurado: las instancias QR de la empresa no se pudieron cerrar');
      return { instances: instances.length, failed: instances.length, skipped: true };
    }
    let failed = 0;
    for (const { instance } of instances) {
      try {
        await this.qrProvider.logout(creds, instance).catch((e: unknown) => {
          if (e instanceof QrSessionError && (e.code === 'not_found' || e.code === 'session_down')) return; // ya estaba cerrada o no existe
          throw e;
        });
        await this.qrProvider.deleteInstance(creds, instance);
      } catch (e) {
        if (e instanceof QrSessionError && isRetryableQr(e.code) && job.attempts < QR_GIVE_UP_AFTER) return 'retry';
        failed += 1;
        this.log.warn({ deletionId: job.deletionId, code: e instanceof QrSessionError ? e.code : 'desconocido' }, 'no se pudo borrar una instancia de Evolution');
      }
    }
    return { instances: instances.length, failed, skipped: false };
  }

  /** Borra todo `org/<id>/` y comprueba que no quedó nada. Sin almacenamiento configurado no pudo haber guardado nada con este adaptador: se anota y se sigue. */
  private async cleanFiles(orgId: string): Promise<number | 'skipped'> {
    const prefix = `org/${orgId}/`;
    let deleted: number;
    try {
      deleted = await this.storage.deleteByPrefix(prefix);
    } catch (e) {
      if (e instanceof StorageError && e.code === 'not_configured') return 'skipped';
      throw e;
    }
    if ((await this.storage.countByPrefix(prefix, 1)) > 0) throw new ResidueError();
    return deleted;
  }
}

class ResidueError extends Error {
  constructor() {
    super('quedaron archivos bajo el prefijo de la empresa');
    this.name = 'ResidueError';
  }
}
