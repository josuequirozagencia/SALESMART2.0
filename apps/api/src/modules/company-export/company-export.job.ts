import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import type { AppLogger } from '../../logger';
import { MAIL_PROVIDER, type MailProvider } from '../../mail';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { StorageError, StorageGateway } from '../attachments';
import { CompanyExportStore, type ExportRow } from '../auth';
import { PlatformAuditService } from '../platform';
import { EXPORT_RETENTION_MS, newDownloadToken } from './company-export.service';
import { ExportPackager } from './export-packager';

/** Cuánto tiempo es «suyo» el trabajo sin dar señales de vida (otra instancia lo retoma pasado ese tiempo). */
const LEASE_MS = 5 * 60_000;
/** Cada cuánto se renueva el arrendamiento mientras se arma o se sube (una subida grande no avisa por su cuenta). */
const HEARTBEAT_MS = 60_000;

/** Un nombre de archivo de descarga: sin tildes ni símbolos, en minúsculas. */
export function downloadBase(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `salesmart-${slug || 'empresa'}`;
}

/**
 * Tarea de fondo de «Descargar todo» (F3b, ADR-59 #8): toma UN pedido a la vez (cola con arrendamiento: si el proceso muere, otro lo retoma), arma el paquete, lo deja listo con 48 horas de vida y,
 * si lo pidió el dueño, le avisa por correo. Además borra del almacenamiento las partes vencidas. Es el único caso en que se lee a una empresa detenida (eliminada, dentro de su plazo): no recorre
 * empresas, atiende pedidos concretos.
 */
@Injectable()
export class CompanyExportJob implements ScheduledJob {
  readonly name = 'company-export';
  readonly intervalMs = 10_000;

  constructor(
    @Inject(CompanyExportStore) private readonly store: CompanyExportStore,
    @Inject(ExportPackager) private readonly packager: ExportPackager,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async run(now: Date): Promise<number> {
    let n = await this.expire(now);
    const row = await this.store.claim(now, LEASE_MS);
    if (row) {
      n += 1;
      await this.work(row);
    }
    return n;
  }

  /** Arma un paquete. Cualquier fallo vuelve el pedido a la cola (hasta 3 intentos) o lo deja `failed` con un código genérico: jamás un texto con datos del cliente. */
  private async work(row: ExportRow): Promise<void> {
    const beat = (): Promise<void> => this.store.heartbeat(row.id, new Date(Date.now() + LEASE_MS));
    const timer = setInterval(() => void beat().catch(() => undefined), HEARTBEAT_MS);
    timer.unref();
    try {
      const live = await this.store.liveDeletionOf(row.organizationId);
      if (!live) {
        await this.store.fail(row.id, 'COMPANY_NOT_DELETED', new Date(), { final: true });
        return;
      }
      const result = await this.packager.build(
        {
          organizationId: row.organizationId,
          organizationName: live.organizationName,
          requestedBy: row.requestedBy,
          actingAsSuperAdmin: row.requestedVia === 'platform',
          generatedAt: new Date(),
          timeZone: live.timezone,
          people: await this.store.people(row.organizationId),
          storagePrefix: `org/${row.organizationId}/exports/${row.id}/`,
          downloadBase: downloadBase(live.organizationName),
        },
        { onProgress: beat },
      );
      const now = new Date();
      const owner = row.requestedVia === 'owner' ? await this.store.ownerOf(live) : null;
      const token = owner ? newDownloadToken() : null;
      await this.store.complete(row.id, { parts: result.parts, counts: { tables: result.counts, files: result.files } }, now, new Date(now.getTime() + EXPORT_RETENTION_MS), token?.hash ?? null);
      await this.audit.recordAs(row.requestedBy, {
        action: 'company.export_ready',
        entityType: 'organization',
        entityId: row.organizationId,
        targetOrgId: row.organizationId,
        details: { export_id: row.id, parts: result.parts.length, bytes: result.parts.reduce((a, p) => a + p.bytes, 0), tables: Object.keys(result.counts).length, files: result.files },
      });
      if (owner && token) await this.notify(row, owner.email, live.organizationName, live.timezone, token.token, result.parts.map((p) => p.bytes), now);
    } catch (e) {
      const code = e instanceof StorageError && e.code === 'not_configured' ? 'STORAGE_NOT_CONFIGURED' : 'EXPORT_FAILED';
      const state = await this.store.fail(row.id, code, new Date(), { final: code === 'STORAGE_NOT_CONFIGURED' });
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', exportId: row.id, state }, 'no se pudo armar la copia de datos de la empresa');
    } finally {
      clearInterval(timer);
    }
  }

  private async notify(row: ExportRow, to: string, organizationName: string, timeZone: string, token: string, sizes: number[], now: Date): Promise<void> {
    const base = this.cfg.frontend.baseUrl;
    if (!base) return;
    try {
      await this.mail.sendCompanyExportReady({ to, organizationName, downloadUrl: `${base}/company-export#token=${token}`, expiresAt: new Date(now.getTime() + EXPORT_RETENTION_MS), timeZone, parts: sizes.length, totalBytes: sizes.reduce((a, b) => a + b, 0) });
      await this.store.markNotified(row.id, now);
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', exportId: row.id }, 'no se pudo avisar que la copia de datos está lista (el paquete ya está listo)');
    }
  }

  /** Borra del almacenamiento las partes de los paquetes que ya vencieron y los marca `expired`. Si el almacenamiento no responde, se reintenta en la siguiente pasada. */
  private async expire(now: Date): Promise<number> {
    let n = 0;
    for (const row of await this.store.dueToExpire(now)) {
      try {
        for (const p of row.parts) await this.storage.delete(p.key);
        await this.store.markExpired(row.id);
        await this.audit.recordAs(row.requestedBy, { action: 'company.export_expired', entityType: 'organization', entityId: row.organizationId, targetOrgId: row.organizationId, details: { export_id: row.id, parts: row.parts.length } });
        n += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido', exportId: row.id }, 'no se pudieron borrar las partes vencidas de la copia de datos (se reintenta)');
      }
    }
    return n;
  }
}
