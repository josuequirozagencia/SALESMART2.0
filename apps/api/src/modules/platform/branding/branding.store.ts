import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, platformAudit, platformBranding } from '../../../db';
import { PlatformContext, TenantContext } from '../../../tenant';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

export interface FaviconRef {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly px: number;
  readonly version: string;
  readonly updatedAt: Date;
}

type Row = typeof platformBranding.$inferSelect;

const refOf = (r: Row | undefined): FaviconRef | null =>
  r && r.faviconKey && r.faviconContentType && r.faviconVersion && r.faviconBytes !== null && r.faviconPx !== null
    ? { key: r.faviconKey, contentType: r.faviconContentType, bytes: r.faviconBytes, px: r.faviconPx, version: r.faviconVersion, updatedAt: r.updatedAt }
    : null;

/**
 * La referencia al favicon de la plataforma (v11 S3): una sola fila de `platform_branding`. Es la ÚNICA pieza que la toca (rol `app_platform`, lint P10). Guardar y quitar escriben la
 * auditoría de plataforma en la MISMA transacción. Leer no pide sesión (la ruta pública del favicon): abre un contexto de plataforma solo para leer esa fila.
 */
@Injectable()
export class BrandingStore {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Para la ruta pública (sin sesión, sin empresa): la referencia, o null si no hay favicon cargado. */
  readPublic(): Promise<FaviconRef | null> {
    const read = (): Promise<FaviconRef | null> => this.read();
    return PlatformContext.currentOrNull() ? read() : TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
  }

  async read(): Promise<FaviconRef | null> {
    return this.db.withPlatform(async (tx) => {
      const [r] = await tx.select().from(platformBranding).where(eq(platformBranding.id, 1)).limit(1);
      return refOf(r);
    });
  }

  /** Guarda la referencia al archivo nuevo y devuelve la que había (para borrar su archivo). Auditoría en la misma transacción. */
  async save(ref: Omit<FaviconRef, 'updatedAt'>): Promise<FaviconRef | null> {
    const actor = PlatformContext.current();
    return this.db.withPlatform(async (tx) => {
      const [before] = await tx.select().from(platformBranding).where(eq(platformBranding.id, 1)).limit(1);
      const set = { faviconKey: ref.key, faviconContentType: ref.contentType, faviconBytes: ref.bytes, faviconPx: ref.px, faviconVersion: ref.version, updatedAt: new Date(), updatedBy: actor.actorUserId };
      await tx.insert(platformBranding).values({ id: 1, ...set }).onConflictDoUpdate({ target: platformBranding.id, set });
      await tx.insert(platformAudit).values({ action: 'branding.favicon.set', entityType: 'platform_branding', actorUserId: actor.actorUserId, details: { content_type: ref.contentType, bytes: ref.bytes, px: ref.px, version: ref.version }, requestId: actor.requestId });
      return refOf(before);
    });
  }

  /** Quita el favicon (todo en NULL) y devuelve la referencia que tenía, o null si no había. Auditoría en la misma transacción. */
  async clear(): Promise<FaviconRef | null> {
    const actor = PlatformContext.current();
    return this.db.withPlatform(async (tx) => {
      const [row] = await tx.select().from(platformBranding).where(eq(platformBranding.id, 1)).limit(1);
      const before = refOf(row);
      if (!before) return null;
      await tx.update(platformBranding).set({ faviconKey: null, faviconContentType: null, faviconBytes: null, faviconPx: null, faviconVersion: null, updatedAt: new Date(), updatedBy: actor.actorUserId }).where(eq(platformBranding.id, 1));
      await tx.insert(platformAudit).values({ action: 'branding.favicon.cleared', entityType: 'platform_branding', actorUserId: actor.actorUserId, details: { version: before.version }, requestId: actor.requestId });
      return before;
    });
  }
}
