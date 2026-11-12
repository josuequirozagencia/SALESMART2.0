import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ServiceUnavailableError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { StorageError, StorageGateway } from '../attachments';
import {
  BrandingStore,
  buildIcon,
  buildLogo,
  checkName,
  defaultImages,
  DEFAULT_APP_NAME,
  ICON_VARIANT_NAMES,
  SHORT_NAME_MAX,
  type AssetRef,
  type BrandSnapshot,
  type BrandingAsset,
} from '../platform';

/** Lo que ve el Súper Admin en Plataforma › Marca. */
export interface BrandingView {
  name: string | null;
  short_name: string | null;
  default_name: string;
  effective_name: string;
  icon: { custom: boolean; version: string | null; px: number | null; has_badge: boolean; updated_at: string | null };
  logo_light: { version: string; bytes: number; content_type: string; px: number | null } | null;
  logo_dark: { version: string; bytes: number; content_type: string; px: number | null } | null;
  updated_at: string | null;
}

/** Lo público (el navegador y el service worker lo piden sin sesión): nada de ninguna empresa. */
export interface PublicBranding {
  name: string;
  short_name: string;
  /** Cambia cuando se cambia el icono; va como `?v=` en las direcciones. */
  version: string;
  icon: { custom: boolean; favicon: string; apple_touch: string; icon_192: string; icon_512: string; badge_96: string };
  logo: { light: string | null; dark: string | null };
}

export interface ServedFile {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly version: string;
}

export type PublicFile = 'favicon' | 'icon-32' | 'icon-48' | 'icon-180' | 'icon-192' | 'icon-512' | 'badge-96' | 'logo-light' | 'logo-dark';

/** El icono por omisión de la pestaña (SVG propio, de confianza; nunca viene de una subida). */
const DEFAULT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M42 21c-2-3-5-4.5-9.5-4.5C26.5 16.5 22.5 19.5 22.5 24c0 11 20.5 5.5 20.5 16 0 4.8-4.2 7.5-10.5 7.5-4.8 0-8.5-1.7-11-5" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
export const DEFAULT_FAVICON: ServedFile = { bytes: Buffer.from(DEFAULT_SVG, 'utf8'), contentType: 'image/svg+xml', version: 'default-1' };
const DEFAULT_VERSION = 'default-1';
const SNAPSHOT_MS = 30_000;
const ICONS: readonly BrandingAsset[] = [...ICON_VARIANT_NAMES, 'badge-96'];

const url = (file: string, v: string): string => `/v1/branding/${file}?v=${encodeURIComponent(v)}`;

/**
 * La marca de la plataforma (v11 §3, ADR-69): nombre, logos y icono de la aplicación (favicon, instalación y notificaciones). Lo cambia SOLO el Súper Admin; lo pide cualquiera sin sesión y lo que se
 * entrega no revela nada de ninguna empresa. Los archivos viven en el almacenamiento bajo `platform/branding/` (nunca bajo una organización) y las referencias en tablas de plataforma. Las imágenes se
 * validan y se generan con `sharp` (contenido real, sin SVG ni metadatos). Se guarda en memoria una foto de la marca (30 s) y los archivos (por versión) para no ir a la base ni al almacenamiento en
 * cada petición; cualquier cambio la renueva al instante en esta instancia.
 */
@Injectable()
export class BrandingService {
  private snap: { at: number; value: BrandSnapshot } | null = null;
  private readonly files = new Map<string, ServedFile>();

  constructor(
    @Inject(BrandingStore) private readonly store: BrandingStore,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  // ------------------------------------------------------------------ lectura

  /** La marca vigente. NUNCA falla: sin base de datos se entregan los valores por defecto (la pestaña y el manifest no deben romperse). */
  async snapshot(now = Date.now()): Promise<BrandSnapshot> {
    if (this.snap && now - this.snap.at < SNAPSHOT_MS) return this.snap.value;
    try {
      const value = await this.store.readPublic();
      this.snap = { at: now, value };
      return value;
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo leer la marca: se entregan los valores por defecto');
      return this.snap?.value ?? { name: null, shortName: null, updatedAt: null, assets: new Map() };
    }
  }

  private invalidate(): void {
    this.snap = null;
  }

  async view(): Promise<BrandingView> {
    this.invalidate();
    const s = await this.store.read();
    const a = s.assets;
    const meta = (r: AssetRef | undefined) => (r ? { version: r.version, bytes: r.bytes, content_type: r.contentType, px: r.px } : null);
    const icon = a.get('icon-512');
    return {
      name: s.name,
      short_name: s.shortName,
      default_name: DEFAULT_APP_NAME,
      effective_name: s.name ?? DEFAULT_APP_NAME,
      icon: { custom: icon !== undefined, version: icon?.version ?? null, px: icon?.px ?? null, has_badge: a.has('badge-96'), updated_at: icon?.updatedAt.toISOString() ?? null },
      logo_light: meta(a.get('logo-light')),
      logo_dark: meta(a.get('logo-dark')),
      updated_at: s.updatedAt?.toISOString() ?? null,
    };
  }

  /** La versión del icono (la del archivo de 192 px) o la de por omisión. */
  private iconVersion(s: BrandSnapshot): string {
    return s.assets.get('icon-192')?.version ?? DEFAULT_VERSION;
  }

  async publicInfo(): Promise<PublicBranding> {
    const s = await this.snapshot();
    const v = this.iconVersion(s);
    const name = s.name ?? DEFAULT_APP_NAME;
    const light = s.assets.get('logo-light');
    const dark = s.assets.get('logo-dark');
    return {
      name,
      short_name: s.shortName ?? name.slice(0, SHORT_NAME_MAX).trim(),
      version: v,
      icon: { custom: s.assets.has('icon-192'), favicon: url('favicon', v), apple_touch: url('apple-touch-icon.png', v), icon_192: url('icon-192.png', v), icon_512: url('icon-512.png', v), badge_96: url('badge-96.png', s.assets.get('badge-96')?.version ?? DEFAULT_VERSION) },
      logo: { light: light ? url('logo-light', light.version) : null, dark: dark || light ? url(dark ? 'logo-dark' : 'logo-light', (dark ?? light)!.version) : null },
    };
  }

  /** Lo que se escribe en el HTML al servirlo: el nombre (el servidor lo escapa), la versión de los iconos y los logos para el primer pintado de la interfaz. */
  async indexBrand(): Promise<{ name: string; short_name: string; version: string; logo: PublicBranding['logo']; icon: { custom: boolean; icon_192: string; badge_96: string } }> {
    const p = await this.publicInfo();
    return { name: p.name, short_name: p.short_name, version: p.version, logo: p.logo, icon: { custom: p.icon.custom, icon_192: p.icon.icon_192, badge_96: p.icon.badge_96 } };
  }

  /** El manifest de la aplicación instalable. */
  async manifest(): Promise<Record<string, unknown>> {
    const p = await this.publicInfo();
    return {
      name: p.name,
      short_name: p.short_name,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#4f46e5',
      icons: [
        { src: p.icon.icon_192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: p.icon.icon_512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    };
  }

  /** Un ETag estable para una respuesta JSON de la marca. */
  etagOf(value: unknown): string {
    return `"${createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)}"`;
  }

  /**
   * El archivo público pedido, o `null` si no existe (logos sin subir). Los iconos y el badge NUNCA fallan: sin archivo propio (o con el almacenamiento caído) se entrega el de por omisión, así
   * una pestaña, una notificación o una instalación nunca quedan con un 404.
   */
  async serve(file: PublicFile): Promise<ServedFile | null> {
    if (file === 'favicon') return (await this.snapshot()).assets.has('icon-48') ? this.serve('icon-48') : DEFAULT_FAVICON;
    const s = await this.snapshot();
    const asset: BrandingAsset = file === 'logo-dark' && !s.assets.has('logo-dark') ? 'logo-light' : file;
    const ref = s.assets.get(asset);
    if (ref) {
      const cached = this.files.get(asset);
      if (cached?.version === ref.version) return cached;
      try {
        const served: ServedFile = { bytes: await this.storage.get(ref.key), contentType: ref.contentType, version: ref.version };
        this.files.set(asset, served);
        return served;
      } catch (e) {
        this.log.warn({ asset, err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo leer un archivo de la marca');
      }
    }
    if (file === 'logo-light' || file === 'logo-dark') return null;
    const d = await defaultImages();
    return { bytes: file === 'badge-96' ? d.badge : d.icons[file], contentType: 'image/png', version: DEFAULT_VERSION };
  }

  // ------------------------------------------------------------------ cambios (Súper Admin)

  async setName(name: string | null, shortName: string | null): Promise<BrandingView> {
    const c = checkName(name, shortName);
    if (!c.ok) throw new AppError(400, 'BRANDING_NAME_INVALID', c.message);
    await this.store.saveName(c.name, c.shortName);
    this.invalidate();
    return this.view();
  }

  /** Valida el PNG, genera todas las variantes, las guarda y fija las referencias; después borra los archivos anteriores. */
  async setIcon(bytes: Buffer): Promise<BrandingView> {
    const built = await buildIcon(bytes);
    if (!built.ok) throw new AppError(built.status, built.code, built.message);
    const version = randomUUID();
    const set: Array<{ asset: BrandingAsset; key: string; contentType: string; bytes: number; px: number | null; version: string }> = [];
    // `px` de cada variante = el lado del PNG que subió la persona (lo que muestra la pantalla), no el de la variante
    const puts: Array<[BrandingAsset, Buffer, number | null]> = [...ICON_VARIANT_NAMES.map((n): [BrandingAsset, Buffer, number | null] => [n, built.variants[n], built.px])];
    if (built.badge) puts.push(['badge-96', built.badge, built.px]);
    const written: string[] = [];
    try {
      for (const [asset, buf, px] of puts) {
        const key = `platform/branding/${asset}-${version}`;
        await this.put(key, buf, 'image/png');
        written.push(key);
        set.push({ asset, key, contentType: 'image/png', bytes: buf.length, px, version });
      }
    } catch (e) {
      await Promise.all(written.map((k) => this.storage.delete(k).catch(() => undefined)));
      throw e;
    }
    await this.commit({ set, remove: built.badge ? [] : ['badge-96'], audit: { action: 'branding.icon.set', details: { px: built.px, has_badge: built.badge !== null, version } } }, written, ICONS);
    return this.view();
  }

  async clearIcon(): Promise<BrandingView> {
    await this.commit({ set: [], remove: [...ICONS], audit: { action: 'branding.icon.cleared', details: {} } }, [], ICONS);
    return this.view();
  }

  async setLogo(which: 'light' | 'dark', bytes: Buffer): Promise<BrandingView> {
    const built = await buildLogo(bytes);
    if (!built.ok) throw new AppError(built.status, built.code, built.message);
    const asset: BrandingAsset = which === 'light' ? 'logo-light' : 'logo-dark';
    const version = randomUUID();
    const key = `platform/branding/${asset}-${version}`;
    await this.put(key, built.bytes, built.contentType);
    await this.commit({ set: [{ asset, key, contentType: built.contentType, bytes: built.bytes.length, px: built.px, version }], remove: [], audit: { action: 'branding.logo.set', details: { asset, content_type: built.contentType, bytes: built.bytes.length, px: built.px, version } } }, [key], [asset]);
    return this.view();
  }

  async clearLogo(which: 'light' | 'dark'): Promise<BrandingView> {
    const asset: BrandingAsset = which === 'light' ? 'logo-light' : 'logo-dark';
    await this.commit({ set: [], remove: [asset], audit: { action: 'branding.logo.cleared', details: { asset } } }, [], [asset]);
    return this.view();
  }

  // ------------------------------------------------------------------ piezas

  private async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    try {
      await this.storage.put(key, bytes, contentType);
    } catch (e) {
      if (e instanceof StorageError && e.code === 'not_configured') throw new ServiceUnavailableError('STORAGE_NOT_CONFIGURED', 'Configura el almacenamiento en Proveedores antes de subir archivos de la marca');
      throw new ServiceUnavailableError('STORAGE_UNAVAILABLE', 'No pudimos guardar el archivo: inténtalo de nuevo');
    }
  }

  /** Fija las referencias; si la base falla, borra lo recién subido. Después borra los archivos anteriores (si falla, quedan huérfanos pero nada se rompe) y renueva las memorias. */
  private async commit(change: Parameters<BrandingStore['changeAssets']>[0], written: readonly string[], touched: readonly BrandingAsset[]): Promise<void> {
    let prior: AssetRef[];
    try {
      prior = await this.store.changeAssets(change);
    } catch (e) {
      await Promise.all(written.map((k) => this.storage.delete(k).catch(() => undefined)));
      throw e;
    }
    this.invalidate();
    for (const a of touched) this.files.delete(a);
    for (const p of prior) await this.storage.delete(p.key).catch((e: unknown) => this.log.warn({ asset: p.asset, err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo borrar un archivo anterior de la marca'));
  }
}
