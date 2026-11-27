import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { adCreatives, Database } from '../../db';
import { AttachmentsService } from '../attachments';
import type { NormalizedReferral } from '../conversations';

/** Lo que se recuerda de un anuncio (v20, ADR-55). Solo lo que el mensaje trae: el id del anuncio, su titular, su texto, su dirección y la red. */
export interface AdInfo {
  readonly sourceId: string;
  readonly headline: string | null;
  readonly body: string | null;
  readonly sourceUrl: string | null;
  readonly platform: 'facebook' | 'instagram' | null;
}

const cut = (v: string | null, n: number): string | null => {
  const s = (v ?? '').replace(/\p{Cc}/gu, ' ').trim();
  return s === '' ? null : s.slice(0, n);
};
/** Solo direcciones https sin usuario ni contraseña (la interfaz las abre en una pestaña nueva). */
const httpsUrl = (v: string | null): string | null => {
  const s = (v ?? '').trim();
  if (s === '' || s.length > 1000) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? s : null;
  } catch {
    return null;
  }
};

/** El anuncio de un clic, o null si el clic no trae id de anuncio. */
export function adInfoOf(r: NormalizedReferral | null | undefined): AdInfo | null {
  const sourceId = cut(r?.sourceId ?? null, 100);
  if (!r || !sourceId) return null;
  return { sourceId, headline: cut(r.headline, 300), body: cut(r.body, 500), sourceUrl: httpsUrl(r.sourceUrl), platform: r.platform ?? null };
}

/**
 * Los anuncios de Meta de una empresa (v20, ADR-55): una fila por anuncio con su titular, texto, dirección, red y la miniatura guardada UNA sola vez en el almacenamiento (la miniatura viaja en cada aviso, ~2 KB).
 * Corre bajo el contexto de una empresa. Mejor esfuerzo: si el almacenamiento falla, el anuncio se recuerda sin miniatura y la siguiente vez que llegue se vuelve a intentar.
 */
@Injectable()
export class AdCreativesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttachmentsService) private readonly files: AttachmentsService,
  ) {}

  async remember(ad: AdInfo, thumbnail: { bytes: Buffer; mime: string } | null, organizationId: string): Promise<void> {
    const [existing] = await this.db.withTenant((tx) => tx.select({ key: adCreatives.thumbnailKey }).from(adCreatives).where(eq(adCreatives.sourceId, ad.sourceId)).limit(1));
    const key = thumbnail && !existing?.key ? await this.files.putAsset(organizationId, 'ads', thumbnail.bytes, thumbnail.mime) : null;
    const now = new Date();
    await this.db.withTenant((tx) =>
      tx
        .insert(adCreatives)
        .values({ sourceId: ad.sourceId, headline: ad.headline, body: ad.body, sourceUrl: ad.sourceUrl, platform: ad.platform, thumbnailKey: key, thumbnailMime: key && thumbnail ? thumbnail.mime : null, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [adCreatives.organizationId, adCreatives.sourceId],
          // Lo ya guardado no se pisa con vacíos; la miniatura solo se pone si aún no había
          set: {
            lastSeenAt: now,
            headline: ad.headline ? ad.headline : undefined,
            body: ad.body ? ad.body : undefined,
            sourceUrl: ad.sourceUrl ? ad.sourceUrl : undefined,
            platform: ad.platform ? ad.platform : undefined,
          },
        }),
    );
    // Dos avisos a la vez pudieron subir cada uno su copia: si la fila quedó con otra clave, la nuestra sobra
    if (key) {
      const [row] = await this.db.withTenant((tx) => tx.select({ key: adCreatives.thumbnailKey }).from(adCreatives).where(and(eq(adCreatives.sourceId, ad.sourceId))).limit(1));
      if (row && row.key !== key) {
        if (row.key === null) {
          await this.db.withTenant((tx) => tx.update(adCreatives).set({ thumbnailKey: key, thumbnailMime: thumbnail?.mime ?? null }).where(eq(adCreatives.sourceId, ad.sourceId)));
        } else {
          await this.files.remove(key).catch(() => undefined);
        }
      }
    }
  }
}
