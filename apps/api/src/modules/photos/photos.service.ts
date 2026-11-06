import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { contacts, Database } from '../../db';
import { AppError } from '../../errors';
import { sniff, StorageError, StorageGateway } from '../attachments';
import { TenantContext } from '../../tenant';
import { MemberPhotosService } from '../organizations';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const PHOTO_URL_TTL_SECONDS = 900;
const TYPES: Readonly<Record<string, { mime: string; ext: string }>> = { jpeg: { mime: 'image/jpeg', ext: 'jpg' }, png: { mime: 'image/png', ext: 'png' }, webp: { mime: 'image/webp', ext: 'webp' } };
const MIME_BY_EXT: Readonly<Record<string, string>> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export interface ResolvedPhotos {
  contacts: Record<string, string>;
  users: Record<string, string>;
}

/**
 * Fotos de perfil (v5). Tres cosas: dar las URL firmadas (de 15 min) de los contactos y de las personas que la pantalla pide —las claves del almacenamiento NUNCA salen—, y dejar que cada
 * persona suba, vea y quite SU foto en SU empresa. Todo bajo el contexto de la empresa: una foto de otra empresa no existe para quien pregunta, y una persona sin foto o un contacto fuera de su alcance
 * simplemente no aparecen (la pantalla muestra las siglas). Un almacenamiento caído no rompe la lista: se responde sin fotos.
 */
@Injectable()
export class PhotosService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(MemberPhotosService) private readonly members: MemberPhotosService,
  ) {}

  /** `viewAll`: quien ve todos los contactos o todas las conversaciones; el resto, solo los contactos que lleva. */
  async resolve(ids: { contacts: readonly string[]; users: readonly string[] }, who: { userId: string; viewAll: boolean }): Promise<ResolvedPhotos> {
    const out: ResolvedPhotos = { contacts: {}, users: {} };
    const keys: Array<['contacts' | 'users', string, string]> = [];
    if (ids.contacts.length > 0) {
      const rows = await this.db.withTenant((tx) =>
        tx
          .select({ id: contacts.id, key: contacts.photoKey })
          .from(contacts)
          .where(and(inArray(contacts.id, [...ids.contacts]), isNull(contacts.deletedAt), isNotNull(contacts.photoKey), who.viewAll ? undefined : eq(contacts.ownerId, who.userId))),
      );
      for (const r of rows) if (r.key) keys.push(['contacts', r.id, r.key]);
    }
    for (const [id, key] of await this.members.keysFor(ids.users)) keys.push(['users', id, key]);
    await Promise.all(
      keys.map(async ([kind, id, key]) => {
        const url = await this.sign(key);
        if (url) out[kind][id] = url;
      }),
    );
    return out;
  }

  /** La foto de quien pregunta (URL firmada o null). */
  async mine(userId: string): Promise<{ photo_url: string | null }> {
    const key = (await this.members.keysFor([userId])).get(userId);
    return { photo_url: key ? await this.sign(key) : null };
  }

  async setMine(userId: string, bytes: Buffer): Promise<{ photo_url: string | null }> {
    if (bytes.length === 0) throw new AppError(400, 'PHOTO_EMPTY', 'El archivo está vacío');
    if (bytes.length > MAX_PHOTO_BYTES) throw new AppError(413, 'PHOTO_TOO_LARGE', `La foto pesa demasiado: el máximo es ${Math.floor(MAX_PHOTO_BYTES / (1024 * 1024))} MB`);
    const type = TYPES[sniff(bytes) ?? ''];
    if (!type) throw new AppError(415, 'PHOTO_UNSUPPORTED', 'La foto debe ser una imagen JPEG, PNG o WebP');
    const org = TenantContext.current().organizationId;
    const key = `org/${org}/members/${userId}/${randomUUID()}.${type.ext}`;
    try {
      await this.storage.put(key, bytes, type.mime);
    } catch (e) {
      throw this.storageError(e);
    }
    const r = await this.members.replace(userId, key);
    if (!r) {
      await this.storage.delete(key).catch(() => undefined);
      throw new AppError(404, 'NOT_FOUND', 'No encontramos tu perfil en esta empresa');
    }
    if (r.previous) await this.storage.delete(r.previous).catch(() => undefined);
    return { photo_url: await this.sign(key) };
  }

  async removeMine(userId: string): Promise<{ photo_url: null }> {
    const r = await this.members.replace(userId, null);
    if (r?.previous) await this.storage.delete(r.previous).catch(() => undefined);
    return { photo_url: null };
  }

  private async sign(key: string): Promise<string | null> {
    try {
      return await this.storage.signedUrl(key, { expiresInSeconds: PHOTO_URL_TTL_SECONDS, contentType: MIME_BY_EXT[key.split('.').pop() ?? ''] ?? 'application/octet-stream', disposition: 'inline', filename: null });
    } catch {
      return null;
    }
  }

  private storageError(e: unknown): unknown {
    if (e instanceof StorageError) return new AppError(503, e.code === 'not_configured' ? 'STORAGE_NOT_CONFIGURED' : 'STORAGE_UNAVAILABLE', e.message);
    return e;
  }
}
