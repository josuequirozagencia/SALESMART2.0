import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ServiceUnavailableError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { StorageError, StorageGateway } from '../attachments';
import { BrandingStore, checkFavicon } from '../platform';

export interface BrandingView {
  has_favicon: boolean;
  /** Cambia en cada subida; la pantalla lo usa para ver siempre la imagen nueva. */
  version: string | null;
  content_type: string | null;
  bytes: number | null;
  px: number | null;
  updated_at: string | null;
}

export interface ServedFavicon {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly version: string;
}

/** El icono por omisión (SVG propio, de confianza; nunca viene de una subida): un cuadrado índigo con una «S». Lo que se ve mientras el Súper Admin no suba el suyo. */
const DEFAULT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M42 21c-2-3-5-4.5-9.5-4.5C26.5 16.5 22.5 19.5 22.5 24c0 11 20.5 5.5 20.5 16 0 4.8-4.2 7.5-10.5 7.5-4.8 0-8.5-1.7-11-5" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
export const DEFAULT_FAVICON: ServedFavicon = { bytes: Buffer.from(DEFAULT_SVG, 'utf8'), contentType: 'image/svg+xml', version: 'default-1' };

/**
 * El favicon de la plataforma (v11 S3). Lo sube y lo quita SOLO el Súper Admin; lo pide cualquiera sin sesión (el navegador lo pide para la pestaña) y lo que se entrega no revela nada de ninguna
 * empresa. El archivo vive en el almacenamiento bajo `platform/branding/` (no bajo una organización) y la referencia en `platform_branding`. Se valida por su contenido real. Se
 * guarda en memoria (una sola imagen de hasta 256 KB, con su versión) para no ir al almacenamiento en cada petición.
 */
@Injectable()
export class BrandingService {
  private cache: ServedFavicon | null = null;

  constructor(
    @Inject(BrandingStore) private readonly store: BrandingStore,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async view(): Promise<BrandingView> {
    const r = await this.store.read();
    return { has_favicon: r !== null, version: r?.version ?? null, content_type: r?.contentType ?? null, bytes: r?.bytes ?? null, px: r?.px ?? null, updated_at: r?.updatedAt.toISOString() ?? null };
  }

  /** Valida el contenido real, lo guarda en el almacenamiento y fija la referencia; después borra el archivo anterior (si falla, queda huérfano pero nada se rompe). */
  async setFavicon(bytes: Buffer): Promise<BrandingView> {
    const check = checkFavicon(bytes);
    if (!check.ok) throw new AppError(check.code === 'TOO_LARGE' ? 413 : 400, `FAVICON_${check.code}`, check.message);
    const version = randomUUID();
    const key = `platform/branding/favicon-${version}`;
    try {
      await this.storage.put(key, bytes, check.contentType);
    } catch (e) {
      if (e instanceof StorageError && e.code === 'not_configured') throw new ServiceUnavailableError('STORAGE_NOT_CONFIGURED', 'Configura el almacenamiento en Proveedores antes de subir el favicon');
      throw new ServiceUnavailableError('STORAGE_UNAVAILABLE', 'No pudimos guardar el archivo: inténtalo de nuevo');
    }
    let prior;
    try {
      prior = await this.store.save({ key, contentType: check.contentType, bytes: bytes.length, px: check.px, version });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
    this.cache = null;
    if (prior) await this.storage.delete(prior.key).catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo borrar el favicon anterior'));
    return this.view();
  }

  /** Quita el favicon: la plataforma vuelve al icono por omisión. Quitar cuando no hay no es un error. */
  async clear(): Promise<BrandingView> {
    const prior = await this.store.clear();
    this.cache = null;
    if (prior) await this.storage.delete(prior.key).catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo borrar el favicon'));
    return this.view();
  }

  /** Lo que se entrega a quien lo pide: el favicon subido o, si no hay (o el almacenamiento no responde), el icono por omisión. Nunca falla. */
  async serve(): Promise<ServedFavicon> {
    try {
      const ref = await this.store.readPublic();
      if (!ref) return DEFAULT_FAVICON;
      if (this.cache?.version === ref.version) return this.cache;
      const bytes = await this.storage.get(ref.key);
      this.cache = { bytes, contentType: ref.contentType, version: ref.version };
      return this.cache;
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo leer el favicon: se entrega el de por omisión');
      return DEFAULT_FAVICON;
    }
  }
}
