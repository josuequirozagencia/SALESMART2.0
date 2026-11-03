import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../errors';
import { PlatformContext } from '../../tenant';
import { StorageGateway } from '../attachments';
import { CompanyExportStore, PasswordConfirmationService, hashExportToken, type ExportRow, type ExportState, type LiveDeletion } from '../auth';
import { PlatformAuditService, type PlatformAuditEntry } from '../platform';

/** Cuánto vale una URL de descarga (se pide otra cuando vence). */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
/** Cuánto tiempo queda listo un paquete antes de borrarse. */
export const EXPORT_RETENTION_MS = 48 * 3_600_000;

export interface ExportView {
  id: string;
  state: ExportState;
  requested_via: 'platform' | 'owner';
  requested_at: string;
  finished_at: string | null;
  /** Hasta cuándo se puede bajar (solo cuando está listo). */
  expires_at: string | null;
  parts: Array<{ n: number; filename: string; bytes: number }>;
  total_bytes: number;
  /** Código genérico de por qué falló, sin datos del cliente. */
  error: string | null;
}

export interface PlatformExportStatus {
  /** ¿Se puede pedir? Solo una empresa eliminada que aún está dentro de su plazo. */
  available: boolean;
  purge_after: string | null;
  export: ExportView | null;
}

export interface OwnerExportStatus {
  organization_name: string;
  purge_after: string;
  export: ExportView | null;
}

export interface DownloadLink {
  url: string;
  filename: string;
  expires_in_seconds: number;
}

export const viewOf = (r: ExportRow): ExportView => ({
  id: r.id,
  state: r.state,
  requested_via: r.requestedVia,
  requested_at: r.requestedAt.toISOString(),
  finished_at: r.finishedAt?.toISOString() ?? null,
  expires_at: r.state === 'ready' ? (r.expiresAt?.toISOString() ?? null) : null,
  parts: r.state === 'ready' ? r.parts.map((p) => ({ n: p.n, filename: p.filename, bytes: p.bytes })) : [],
  total_bytes: r.state === 'ready' ? r.parts.reduce((a, p) => a + p.bytes, 0) : 0,
  error: r.state === 'failed' ? (r.error ?? 'EXPORT_FAILED') : null,
});

/** Un token nuevo para el correo «tu copia está lista» y su huella (el token no se guarda). */
export function newDownloadToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashExportToken(token) };
}

/**
 * Pedir y bajar la copia completa de los datos de una empresa eliminada (F3b, ADR-59 #8/#9). Dos puertas:
 *  - **El Súper Admin**, desde la Consola: con su sesión; pedirla exige su contraseña (es un volcado de todos los datos de un cliente).
 *  - **El dueño**, desde el enlace del correo que recibió al eliminarse la empresa: no puede iniciar sesión, así que el token del enlace (256 bits, guardado solo como huella) dice QUÉ empresa y su
 *    contraseña dice QUIÉN. Cada acción con datos (pedir, bajar) la exige y comparte el límite de intentos del inicio de sesión.
 * Solo funciona con una empresa eliminada dentro de su plazo, y un solo paquete a la vez. Las claves del almacenamiento salen SIEMPRE de la base de datos, jamás de lo que mande el cliente.
 */
@Injectable()
export class CompanyExportService {
  constructor(
    @Inject(CompanyExportStore) private readonly store: CompanyExportStore,
    @Inject(PasswordConfirmationService) private readonly passwords: PasswordConfirmationService,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  // ── Súper Admin ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async requestAsPlatform(orgId: string, password: string): Promise<ExportView> {
    const actor = PlatformContext.current().actorUserId;
    await this.passwords.confirm(actor, password);
    const live = await this.store.liveDeletionOf(orgId);
    if (!live) throw new ConflictError('NOT_DELETED', 'Solo se puede pedir la copia de una empresa eliminada que todavía está dentro de su plazo');
    return this.enqueue(live, actor, 'platform');
  }

  async statusAsPlatform(orgId: string): Promise<PlatformExportStatus> {
    const live = await this.store.liveDeletionOf(orgId);
    const last = await this.store.latest(orgId);
    return { available: live !== null, purge_after: live?.purgeAfter.toISOString() ?? null, export: last ? viewOf(last) : null };
  }

  async downloadAsPlatform(orgId: string, part: number): Promise<DownloadLink> {
    const actor = PlatformContext.current().actorUserId;
    const live = await this.store.liveDeletionOf(orgId);
    if (!live) throw new NotFoundError();
    return this.link(live, part, actor, 'platform');
  }

  // ── Dueño (enlace del correo) ─────────────────────────────────────────────────────────────────────────────────────────────────

  async statusByToken(token: string): Promise<OwnerExportStatus> {
    const live = await this.resolve(token);
    const last = await this.store.latest(live.organizationId);
    return { organization_name: live.organizationName, purge_after: live.purgeAfter.toISOString(), export: last ? viewOf(last) : null };
  }

  async requestByToken(token: string, password: string): Promise<ExportView> {
    const live = await this.resolve(token);
    const owner = await this.owner(live);
    await this.passwords.confirm(owner, password);
    return this.enqueue(live, owner, 'owner');
  }

  async downloadByToken(token: string, password: string, part: number): Promise<DownloadLink> {
    const live = await this.resolve(token);
    const owner = await this.owner(live);
    await this.passwords.confirm(owner, password);
    return this.link(live, part, owner, 'owner');
  }

  // ── Común ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Desde la Consola ya hay un contexto de plataforma con su actor; desde el enlace del dueño no, y se abre uno solo para escribir esta fila. */
  private record(actor: string, entry: PlatformAuditEntry): Promise<void> {
    return PlatformContext.currentOrNull() ? this.audit.record(entry) : this.audit.recordAs(actor, entry);
  }

  /** El token dice qué eliminación; si no vale (no existe, venció, la empresa se recuperó o se borró) la respuesta es siempre la misma: 404. */
  private async resolve(token: string): Promise<LiveDeletion> {
    const live = await this.store.liveDeletionByToken(token);
    if (!live) throw new NotFoundError();
    return live;
  }

  private async owner(live: LiveDeletion): Promise<string> {
    const o = await this.store.ownerOf(live);
    if (!o) throw new NotFoundError();
    return o.userId;
  }

  private async enqueue(live: LiveDeletion, actor: string, via: 'platform' | 'owner'): Promise<ExportView> {
    const { row, created } = await this.store.enqueue({ organizationId: live.organizationId, deletionId: live.deletionId, requestedBy: actor, via });
    if (created) {
      await this.record(actor, { action: 'company.export_requested', entityType: 'organization', entityId: live.organizationId, targetOrgId: live.organizationId, details: { export_id: row.id, deletion_id: live.deletionId, via } });
    }
    return viewOf(row);
  }

  private async link(live: LiveDeletion, part: number, actor: string, via: 'platform' | 'owner'): Promise<DownloadLink> {
    const last = await this.store.latest(live.organizationId);
    if (!last || last.state !== 'ready' || !last.expiresAt || last.expiresAt.getTime() <= Date.now()) throw new ConflictError('EXPORT_NOT_READY', 'La copia todavía no está lista, o ya venció: pídela de nuevo');
    const p = last.parts.find((x) => x.n === part);
    if (!p) throw new NotFoundError();
    const url = await this.storage.signedUrl(p.key, { expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, contentType: 'application/zip', disposition: 'attachment', filename: p.filename });
    await this.record(actor, { action: 'company.export_downloaded', entityType: 'organization', entityId: live.organizationId, targetOrgId: live.organizationId, details: { export_id: last.id, part, via } });
    return { url, filename: p.filename, expires_in_seconds: DOWNLOAD_URL_TTL_SECONDS };
  }
}
