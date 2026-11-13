import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { Database, platformAudit, platformBranding, platformBrandingAssets } from '../../../db';
import { PlatformContext, TenantContext } from '../../../tenant';
import type { BrandingAsset } from './brand-files';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

/** La referencia a un archivo de la marca (el archivo vive en el almacenamiento). */
export interface AssetRef {
  readonly asset: BrandingAsset;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly px: number | null;
  readonly version: string;
  readonly updatedAt: Date;
}

export interface BrandSnapshot {
  /** Nombre y nombre corto guardados; `null` = valor por defecto. */
  readonly name: string | null;
  readonly shortName: string | null;
  readonly updatedAt: Date | null;
  readonly assets: ReadonlyMap<BrandingAsset, AssetRef>;
}

export interface AssetChange {
  readonly set: ReadonlyArray<Omit<AssetRef, 'updatedAt'>>;
  readonly remove: readonly BrandingAsset[];
  /** Qué quedó escrito en la auditoría de plataforma (misma transacción). */
  readonly audit: { readonly action: string; readonly details: Record<string, unknown> };
}

type AssetRow = typeof platformBrandingAssets.$inferSelect;
const refOf = (r: AssetRow): AssetRef => ({ asset: r.asset as BrandingAsset, key: r.storageKey, contentType: r.contentType, bytes: r.bytes, px: r.px, version: r.version, updatedAt: r.updatedAt });

/**
 * La marca de la plataforma en base de datos (v11 §3): el nombre (`platform_branding`, una fila) y las referencias a los archivos (`platform_branding_assets`). Es la ÚNICA pieza que las toca (rol
 * `app_platform`, lint P10). Cada cambio escribe la auditoría de plataforma en la MISMA transacción. Leer no pide sesión (las rutas públicas): abre un contexto de plataforma solo para eso.
 */
@Injectable()
export class BrandingStore {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Para las rutas públicas y el HTML (sin sesión, sin empresa). */
  readPublic(): Promise<BrandSnapshot> {
    return PlatformContext.currentOrNull() ? this.read() : TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, () => this.read()));
  }

  async read(): Promise<BrandSnapshot> {
    return this.db.withPlatform(async (tx) => {
      const [b] = await tx.select().from(platformBranding).where(eq(platformBranding.id, 1)).limit(1);
      const rows = await tx.select().from(platformBrandingAssets);
      return { name: b?.appName ?? null, shortName: b?.appShortName ?? null, updatedAt: b?.updatedAt ?? null, assets: new Map(rows.map((r) => [r.asset as BrandingAsset, refOf(r)])) };
    });
  }

  /** Guarda el nombre y el nombre corto (`null` = valor por defecto). */
  async saveName(name: string | null, shortName: string | null): Promise<void> {
    const actor = PlatformContext.current();
    await this.db.withPlatform(async (tx) => {
      const [before] = await tx.select().from(platformBranding).where(eq(platformBranding.id, 1)).limit(1);
      const set = { appName: name, appShortName: shortName, updatedAt: new Date(), updatedBy: actor.actorUserId };
      await tx.insert(platformBranding).values({ id: 1, ...set }).onConflictDoUpdate({ target: platformBranding.id, set });
      await tx.insert(platformAudit).values({
        action: name === null ? 'branding.name.cleared' : 'branding.name.set',
        entityType: 'platform_branding',
        actorUserId: actor.actorUserId,
        details: { before: { name: before?.appName ?? null, short_name: before?.appShortName ?? null }, after: { name, short_name: shortName } },
        requestId: actor.requestId,
      });
    });
  }

  /** Aplica el cambio de archivos de una sola vez y devuelve las referencias que había (para borrar sus archivos). */
  async changeAssets(change: AssetChange): Promise<AssetRef[]> {
    const actor = PlatformContext.current();
    return this.db.withPlatform(async (tx) => {
      const touched = [...change.set.map((s) => s.asset), ...change.remove];
      const before = touched.length > 0 ? await tx.select().from(platformBrandingAssets).where(inArray(platformBrandingAssets.asset, touched)) : [];
      const now = new Date();
      for (const s of change.set) {
        const row = { storageKey: s.key, contentType: s.contentType, bytes: s.bytes, px: s.px, version: s.version, updatedAt: now, updatedBy: actor.actorUserId };
        await tx.insert(platformBrandingAssets).values({ asset: s.asset, ...row }).onConflictDoUpdate({ target: platformBrandingAssets.asset, set: row });
      }
      if (change.remove.length > 0) await tx.delete(platformBrandingAssets).where(inArray(platformBrandingAssets.asset, [...change.remove]));
      await tx.insert(platformAudit).values({ action: change.audit.action, entityType: 'platform_branding', actorUserId: actor.actorUserId, details: change.audit.details, requestId: actor.requestId });
      return before.map(refOf);
    });
  }
}
