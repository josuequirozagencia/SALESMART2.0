import { uuidv7 } from '@sales-smart/shared';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, isNull, lt, or, sql, type SQL, inArray } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { automations, Database, mediaAssets, mediaFolders, type TenantTx, quickReplies, quickReplyAssets } from '../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { APP_CONFIG } from '../../tokens';
import { writeAudit } from '../audit';
import { AttachmentsService } from '../attachments';
import { OrgDirectoryService } from '../organizations';
import { openRequestIn, StorageQuotaService } from '../storage';
import type { AssetView, FolderDto, FolderView, ListLibraryQuery, UpdateAssetDto, UploadAssetQuery, UsageView } from './library.dto';

/** Quién consulta: `manage` = el administrador (sube, ordena, ve archivados y el uso); si no, un asesor, que solo ve lo marcado para asesores. */
export type AssetProblem = 'archived' | 'not_for_advisors' | 'unscanned';

export interface LibraryAccess {
  readonly manage: boolean;
}

const PAGE = 30;
const URL_AUDIT_WINDOW_MS = 60 * 60_000;
const MB = 1024 * 1024;

type AssetRow = typeof mediaAssets.$inferSelect;
const view = (r: AssetRow): AssetView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  kind: r.kind as AssetView['kind'],
  mime_type: r.mimeType,
  size_bytes: r.sizeBytes,
  folder_id: r.folderId,
  usable_by_advisors: r.usableByAdvisors,
  usable_by_ai: r.usableByAi,
  state: r.state as AssetView['state'],
  scan_status: r.scanStatus as AssetView['scan_status'],
  created_at: r.createdAt.toISOString(),
  archived_at: r.archivedAt?.toISOString() ?? null,
});

const mb = (n: number): string => (n / MB >= 10 ? Math.round(n / MB) : Math.round((n / MB) * 10) / 10).toString();

/**
 * Biblioteca de archivos de la empresa (V21, ADR-75): carpetas de un nivel y archivos que el administrador sube y los asesores envían. Todo pasa por las reglas de los adjuntos (tipo por contenido,
 * tamaño por tipo, antivirus) y se guarda bajo `org/<empresa>/library/<id>`; solo se entrega por URL firmada de pocos minutos. Sin DELETE: se archiva. El uso de espacio se DERIVA de los archivos
 * vigentes y se compara con el tope de la empresa (`organizations.storage_quota_bytes`). La empresa sale SIEMPRE de `TenantContext`; un archivo o carpeta de otra empresa responde 404 uniforme.
 * La clave del almacenamiento y la URL firmada nunca van a la auditoría ni a los registros.
 */
@Injectable()
export class LibraryService {
  /** Una subida de URL firmada por persona y archivo cada hora queda en la auditoría (para no inundarla). Por instancia: con varias puede haber una de más, nunca una de menos. */
  private readonly urlAudited = new Map<string, number>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(StorageQuotaService) private readonly quotas: StorageQuotaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ lectura

  /** Carpetas y archivos con filtros y cursor. El asesor solo ve lo marcado para asesores y lo vigente. */
  async list(access: LibraryAccess, q: ListLibraryQuery): Promise<{ folders: FolderView[]; items: AssetView[]; next_cursor: string | null; usage: UsageView | null; storage_available: boolean }> {
    const limit = q.limit ?? PAGE;
    const quota = access.manage ? await this.directory.storageQuotaBytes() : null;
    const storageOk = await this.files.available();
    const out = await this.db.withTenant(async (tx) => {
      const conds: SQL[] = [eq(mediaAssets.state, access.manage ? (q.state ?? 'ready') : 'ready')];
      if (!access.manage) conds.push(eq(mediaAssets.usableByAdvisors, true));
      if (q.folder_id === 'root') conds.push(isNull(mediaAssets.folderId));
      else if (q.folder_id) conds.push(eq(mediaAssets.folderId, q.folder_id));
      if (q.kind) conds.push(eq(mediaAssets.kind, q.kind));
      if (q.q) conds.push(ilike(mediaAssets.name, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      const cur = this.decodeCursor(q.cursor);
      if (cur) conds.push(or(lt(mediaAssets.createdAt, cur.at), and(eq(mediaAssets.createdAt, cur.at), lt(mediaAssets.id, cur.id)))!);
      const rows = await tx.select().from(mediaAssets).where(and(...conds)).orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);

      const visible = access.manage ? sql`true` : sql`${mediaAssets.usableByAdvisors}`;
      const counts = await tx
        .select({ folderId: mediaAssets.folderId, n: sql<number>`count(*)::int` })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.state, 'ready'), visible))
        .groupBy(mediaAssets.folderId);
      const byFolder = new Map(counts.map((c) => [c.folderId, c.n]));
      const folders = (await tx.select().from(mediaFolders).where(isNull(mediaFolders.archivedAt)).orderBy(asc(mediaFolders.name))).map((f) => ({ id: f.id, name: f.name, asset_count: byFolder.get(f.id) ?? 0 }));
      const usage = access.manage ? await this.usageIn(tx, quota!, true) : null;
      return { folders, items: page.map(view), next_cursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null, usage };
    });
    return { ...out, storage_available: storageOk };
  }

  /** Cuánto espacio usa la empresa frente a su tope. */
  async usage(): Promise<UsageView> {
    const quota = await this.directory.storageQuotaBytes();
    return this.db.withTenant((tx) => this.usageIn(tx, quota, true));
  }

  /** Una URL firmada de pocos minutos para ver o descargar el archivo. El asesor solo de lo marcado para asesores. 404 si no existe, está archivado o es de otra empresa. */
  async assetUrl(access: LibraryAccess, id: string): Promise<{ url: string; expires_at: string; kind: string; mime_type: string; name: string }> {
    const userId = TenantContext.current().userId ?? null;
    const row = await this.db.withTenant(async (tx) => {
      const [r] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.state, 'ready'), ...(access.manage ? [] : [eq(mediaAssets.usableByAdvisors, true)]))).limit(1);
      if (!r) throw new NotFoundError();
      const key = `${TenantContext.current().organizationId}:${userId ?? '-'}:${id}`;
      const at = this.urlAudited.get(key) ?? 0;
      if (Date.now() - at > URL_AUDIT_WINDOW_MS) {
        this.urlAudited.set(key, Date.now());
        await writeAudit(tx, { entityType: 'media_asset', entityId: id, field: 'url_issued', oldValue: null, newValue: { kind: r.kind }, source: 'manual' });
      }
      return r;
    });
    const signed = await this.files.signedUrl(row.storageKey, row.kind as 'image', row.mimeType, row.name);
    return { url: signed.url, expires_at: signed.expiresAt.toISOString(), kind: row.kind, mime_type: row.mimeType, name: row.name };
  }

  /**
   * El contenido de un archivo para ENVIARLO por una conversación (el chat copia el objeto a un adjunto propio: ADR-75 #3). Mismas reglas de visibilidad que ver: el asesor solo de lo marcado para
   * asesores; 404 si no existe, está archivado o es de otra empresa. Deja el envío en la auditoría (sin el contenido ni la clave).
   */
  async readForSend(access: LibraryAccess, id: string, conversationId: string): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const row = await this.db.withTenant(async (tx) => {
      const [r] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.state, 'ready'), ...(access.manage ? [] : [eq(mediaAssets.usableByAdvisors, true)]))).limit(1);
      if (!r) throw new NotFoundError();
      await writeAudit(tx, { entityType: 'media_asset', entityId: id, field: 'sent', oldValue: null, newValue: { conversation_id: conversationId, kind: r.kind }, source: 'manual' });
      return r;
    });
    return { bytes: await this.files.read(row.storageKey), contentType: row.mimeType, filename: row.name };
  }

  /**
   * Un archivo para que una AUTOMATIZACIÓN lo adjunte (V21 · 21.3), dentro de la transacción de quien llama. Solo uno vigente; con `REQUIRE_VIRUS_SCAN` y sin revisar, no (misma regla que compartirlo con
   * los asesores). No mira `usable_by_advisors`: la regla la escribió el administrador.
   */
  async forAutomation(tx: TenantTx, id: string): Promise<{ ok: true; row: AssetRow } | { ok: false; reason: 'missing' | 'unscanned' }> {
    const [r] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.state, 'ready'))).limit(1);
    if (!r) return { ok: false, reason: 'missing' };
    if (this.cfg.attachments.requireVirusScan && r.scanStatus === 'skipped') return { ok: false, reason: 'unscanned' };
    return { ok: true, row: r };
  }

  /** Los archivos que enlaza una respuesta rápida (V25), en cualquier estado, para decir cómo está cada uno. Dentro de la transacción de quien llama. */
  async forLinks(tx: TenantTx, ids: readonly string[]): Promise<Map<string, AssetRow>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.select().from(mediaAssets).where(inArray(mediaAssets.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Por qué esta persona NO puede usar ahora un archivo (null = sí puede). Quien no administra la biblioteca solo usa lo marcado para asesores. */
  problemOf(access: LibraryAccess, row: AssetRow): AssetProblem | null {
    if (row.state !== 'ready') return 'archived';
    if (!access.manage && !row.usableByAdvisors) return 'not_for_advisors';
    if (this.cfg.attachments.requireVirusScan && row.scanStatus === 'skipped') return 'unscanned';
    return null;
  }

  /** Qué respuestas rápidas usan este archivo: las compartidas por su atajo; de las personales SOLO cuántas (son privadas incluso para el administrador). */
  async usedByQuickReplies(id: string): Promise<{ shared: Array<{ id: string; shortcut: string }>; personal: number }> {
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: quickReplies.id, shortcut: quickReplies.shortcut, shared: quickReplies.shared })
        .from(quickReplyAssets)
        .innerJoin(quickReplies, and(eq(quickReplies.organizationId, quickReplyAssets.organizationId), eq(quickReplies.id, quickReplyAssets.quickReplyId)))
        .where(and(eq(quickReplyAssets.assetId, id), isNull(quickReplies.deletedAt)))
        .orderBy(asc(quickReplies.shortcut));
      return { shared: rows.filter((r) => r.shared).map((r) => ({ id: r.id, shortcut: r.shortcut })), personal: rows.filter((r) => !r.shared).length };
    });
  }

  /** El contenido del objeto de un archivo de la biblioteca (para copiarlo a un adjunto propio). */
  readObject(row: Pick<AssetRow, 'storageKey'>): Promise<Buffer> {
    return this.files.read(row.storageKey);
  }

  /** Las automatizaciones (no borradas) que adjuntan este archivo: archivarlo hará que esos pasos fallen. */
  async usedByAutomations(id: string): Promise<Array<{ id: string; name: string; status: string }>> {
    return this.db.withTenant(async (tx) => {
      const [a] = await tx.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
      if (!a) throw new NotFoundError();
      return tx
        .select({ id: automations.id, name: automations.name, status: automations.status })
        .from(automations)
        .where(and(isNull(automations.deletedAt), sql`${automations.actions} @> ${JSON.stringify([{ attachment: { asset_id: id } }])}::jsonb`))
        .orderBy(asc(automations.name));
    });
  }

  // ------------------------------------------------------------------ archivos

  /**
   * Sube un archivo. Mismas reglas que un adjunto de conversación (tipo declarado, tamaño, contenido REAL, antivirus; los stickers no) más el tope de espacio de la empresa: lo que no cabe da 409
   * `QUOTA_EXCEEDED` y no se guarda nada. Con `REQUIRE_VIRUS_SCAN` y sin antivirus el archivo se guarda pero NO se puede marcar para asesores.
   */
  async upload(file: { bytes: Buffer; contentType: string | undefined; filename: string | null }, opts: UploadAssetQuery): Promise<AssetView> {
    const organizationId = TenantContext.current().organizationId;
    const userId = TenantContext.current().userId ?? null;
    const quota = await this.directory.storageQuotaBytes();
    const prepared = await this.files.prepareUpload(file.bytes, file.contentType, file.filename);
    if (prepared.kind === 'sticker') throw new AppError(415, 'ATTACHMENT_UNSUPPORTED_TYPE', 'La biblioteca guarda imágenes, documentos, videos y audios');
    const size = prepared.bytes.length;
    // Primero lo barato: que la carpeta exista y que quepa (no se gasta antivirus ni almacenamiento en algo que no se aceptaría)
    await this.db.withTenant(async (tx) => {
      if (opts.folder_id) await this.folderIn(tx, opts.folder_id);
      await this.assertFits(tx, quota, size);
    });
    const id = uuidv7();
    const stored = await this.files.scanAndStore(organizationId, id, prepared, 'library');
    const shareable = !(this.cfg.attachments.requireVirusScan && stored.scanStatus === 'skipped');
    try {
      return await this.db.withTenant(async (tx) => {
        // Dos subidas a la vez no pueden pasarse del tope: se ordenan por empresa
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(('library:' || app_org()::text), 0))`);
        if (opts.folder_id) await this.folderIn(tx, opts.folder_id);
        await this.assertFits(tx, quota, size);
        const [row] = await tx
          .insert(mediaAssets)
          .values({
            id,
            folderId: opts.folder_id ?? null,
            name: opts.name ?? prepared.filename,
            description: opts.description ? opts.description : null,
            kind: prepared.kind,
            mimeType: prepared.mime,
            sizeBytes: size,
            storageKey: stored.key,
            checksum: prepared.checksum,
            scanStatus: stored.scanStatus,
            usableByAdvisors: shareable,
            createdBy: userId,
          })
          .returning();
        await writeAudit(tx, { entityType: 'media_asset', entityId: id, field: 'uploaded', oldValue: null, newValue: { kind: prepared.kind, size_bytes: size, folder_id: opts.folder_id ?? null }, source: 'manual' });
        return view(row!);
      });
    } catch (e) {
      await this.files.remove(stored.key); // si no se pudo anotar, no queda suelto en el almacenamiento
      throw e;
    }
  }

  /** Cambia el nombre, la descripción, la carpeta o los usos de un archivo. No cambia el contenido (se sube otro). */
  async update(id: string, input: UpdateAssetDto): Promise<AssetView> {
    return this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.state, 'ready'))).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      const set: Partial<typeof mediaAssets.$inferInsert> = {};
      const changes: Array<[string, unknown, unknown]> = [];
      if (input.name !== undefined && input.name !== cur.name) { set.name = input.name; changes.push(['name', cur.name, input.name]); }
      if (input.description !== undefined && (input.description || null) !== cur.description) { set.description = input.description || null; changes.push(['description', cur.description, set.description]); }
      if (input.folder_id !== undefined && input.folder_id !== cur.folderId) {
        if (input.folder_id) await this.folderIn(tx, input.folder_id);
        set.folderId = input.folder_id;
        changes.push(['folder_id', cur.folderId, input.folder_id]);
      }
      for (const [key, col, now, before] of [['usable_by_advisors', 'usableByAdvisors', input.usable_by_advisors, cur.usableByAdvisors], ['usable_by_ai', 'usableByAi', input.usable_by_ai, cur.usableByAi]] as const) {
        if (now === undefined || now === before) continue;
        if (now && this.cfg.attachments.requireVirusScan && cur.scanStatus === 'skipped') throw new ConflictError('VIRUS_SCAN_REQUIRED', 'Este archivo no se revisó con un antivirus: no se puede compartir con los asesores ni con la IA hasta que haya uno');
        set[col] = now;
        changes.push([key, before, now]);
      }
      if (changes.length === 0) return view(cur);
      set.updatedAt = new Date();
      const [row] = await tx.update(mediaAssets).set(set).where(eq(mediaAssets.id, id)).returning();
      for (const [field, oldValue, newValue] of changes) await writeAudit(tx, { entityType: 'media_asset', entityId: id, field, oldValue, newValue, source: 'manual' });
      return view(row!);
    });
  }

  /** Archiva un archivo: deja de verse y de enviarse, libera su espacio y conserva el objeto (lo ya enviado a clientes no cambia: cada envío tiene su propia copia). */
  async archive(id: string): Promise<AssetView> {
    return this.db.withTenant(async (tx) => {
      const now = new Date();
      const [row] = await tx.update(mediaAssets).set({ state: 'archived', archivedAt: now, updatedAt: now }).where(and(eq(mediaAssets.id, id), eq(mediaAssets.state, 'ready'))).returning();
      if (!row) throw new NotFoundError();
      await writeAudit(tx, { entityType: 'media_asset', entityId: id, field: 'archived', oldValue: { kind: row.kind, size_bytes: row.sizeBytes }, newValue: null, source: 'manual' });
      return view(row);
    });
  }

  // ------------------------------------------------------------------ carpetas

  async createFolder(input: FolderDto): Promise<FolderView> {
    const userId = TenantContext.current().userId ?? null;
    return this.db
      .withTenant(async (tx) => {
        const [row] = await tx.insert(mediaFolders).values({ name: input.name, createdBy: userId }).returning();
        await writeAudit(tx, { entityType: 'media_folder', entityId: row!.id, field: 'created', oldValue: null, newValue: { name: input.name }, source: 'manual' });
        return { id: row!.id, name: row!.name, asset_count: 0 };
      })
      .catch((e: unknown) => {
        throw this.folderRace(e);
      });
  }

  async renameFolder(id: string, input: FolderDto): Promise<FolderView> {
    return this.db
      .withTenant(async (tx) => {
        const cur = await this.folderIn(tx, id);
        if (cur.name === input.name) return { id, name: cur.name, asset_count: await this.countIn(tx, id) };
        await tx.update(mediaFolders).set({ name: input.name, updatedAt: new Date() }).where(eq(mediaFolders.id, id));
        await writeAudit(tx, { entityType: 'media_folder', entityId: id, field: 'name', oldValue: cur.name, newValue: input.name, source: 'manual' });
        return { id, name: input.name, asset_count: await this.countIn(tx, id) };
      })
      .catch((e: unknown) => {
        throw this.folderRace(e);
      });
  }

  /** Archiva una carpeta VACÍA (una con archivos vigentes no: 409). */
  async archiveFolder(id: string): Promise<{ id: string; archived: true }> {
    return this.db.withTenant(async (tx) => {
      const cur = await this.folderIn(tx, id);
      if ((await this.countIn(tx, id)) > 0) throw new ConflictError('FOLDER_NOT_EMPTY', 'La carpeta tiene archivos: muévelos o archívalos primero');
      const now = new Date();
      await tx.update(mediaFolders).set({ archivedAt: now, updatedAt: now }).where(eq(mediaFolders.id, id));
      await writeAudit(tx, { entityType: 'media_folder', entityId: id, field: 'archived', oldValue: { name: cur.name }, newValue: null, source: 'manual' });
      return { id, archived: true };
    });
  }

  // ------------------------------------------------------------------ internos

  /** Uso derivado: la suma de los archivos vigentes. Nunca es un campo editable. */
  private async usageIn(tx: TenantTx, included: number, withRequest = false): Promise<UsageView> {
    const q = await this.quotas.quotaIn(tx, included);
    const [r] = await tx.select({ used: sql<string>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::bigint`, n: sql<number>`count(*)::int` }).from(mediaAssets).where(eq(mediaAssets.state, 'ready'));
    const used = Number(r?.used ?? 0);
    const request = withRequest ? await openRequestIn(tx) : null;
    return { used_bytes: used, quota_bytes: q.effective_bytes, available_bytes: Math.max(0, q.effective_bytes - used), assets: r?.n ?? 0, included_bytes: q.included_bytes, extra_bytes: q.extra_bytes, next_expiry_at: q.next_expiry_at, request: request ? { id: request.id, plan_name: request.plan_name, created_at: request.created_at } : null };
  }

  private async assertFits(tx: TenantTx, quota: number, size: number): Promise<void> {
    const u = await this.usageIn(tx, quota);
    if (u.used_bytes + size > u.quota_bytes) {
      throw new AppError(409, 'QUOTA_EXCEEDED', `No hay espacio: la biblioteca usa ${mb(u.used_bytes)} MB de ${mb(u.quota_bytes)} MB y este archivo pesa ${mb(size)} MB. Archiva algo o pide más espacio`);
    }
  }

  private async folderIn(tx: TenantTx, id: string): Promise<typeof mediaFolders.$inferSelect> {
    const [f] = await tx.select().from(mediaFolders).where(and(eq(mediaFolders.id, id), isNull(mediaFolders.archivedAt))).limit(1);
    if (!f) throw new NotFoundError();
    return f;
  }

  private async countIn(tx: TenantTx, folderId: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(mediaAssets).where(and(eq(mediaAssets.folderId, folderId), eq(mediaAssets.state, 'ready')));
    return r?.n ?? 0;
  }

  private folderRace(e: unknown): unknown {
    if ((e as { cause?: { code?: string } }).cause?.code === '23505') return new ConflictError('FOLDER_EXISTS', 'Ya hay una carpeta con ese nombre');
    return e;
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}
