import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { adCreatives, Database } from '../../db';
import { StorageGateway } from '../attachments';

/** Las direcciones firmadas de las miniaturas duran 15 minutos (igual que las fotos de perfil). */
export const AD_THUMBNAIL_URL_TTL_SECONDS = 900;

export interface AdCreativeView {
  source_id: string;
  headline: string | null;
  body: string | null;
  source_url: string | null;
  platform: 'facebook' | 'instagram' | null;
  /** Nombres reales de Meta (v20): solo si la empresa conectó Meta y el token puede leer anuncios; si no, null. */
  ad_name: string | null;
  adset_name: string | null;
  campaign_name: string | null;
  /** Estado de la consulta de nombres: ok, not_found, no_access (el token no puede leer anuncios), error o null (aún no consultado). */
  names_status: 'ok' | 'not_found' | 'no_access' | 'error' | null;
  /** Dirección firmada de la miniatura, o null si el anuncio no la trajo o el almacenamiento no responde (la pantalla muestra el anuncio sin imagen). */
  thumbnail_url: string | null;
}

/**
 * Lo que la plataforma sabe de cada anuncio de Meta de la empresa (v20, ADR-55): titular, texto, dirección, red y miniatura, por el id del anuncio. Solo lectura, bajo el contexto de la empresa: un anuncio de
 * otra empresa no existe para quien pregunta. Un almacenamiento caído no rompe nada: se responde sin imagen.
 */
@Injectable()
export class AdsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
  ) {}

  async resolve(ids: readonly string[]): Promise<Record<string, AdCreativeView>> {
    const out: Record<string, AdCreativeView> = {};
    if (ids.length === 0) return out;
    const rows = await this.db.withTenant((tx) => tx.select().from(adCreatives).where(inArray(adCreatives.sourceId, [...ids])));
    for (const r of rows) {
      let url: string | null = null;
      if (r.thumbnailKey) {
        try {
          url = await this.storage.signedUrl(r.thumbnailKey, { expiresInSeconds: AD_THUMBNAIL_URL_TTL_SECONDS, contentType: r.thumbnailMime ?? 'image/jpeg', disposition: 'inline', filename: null });
        } catch {
          url = null;
        }
      }
      out[r.sourceId] = { source_id: r.sourceId, headline: r.headline, body: r.body, source_url: r.sourceUrl, platform: r.platform === 'facebook' || r.platform === 'instagram' ? r.platform : null, ad_name: r.adName, adset_name: r.adsetName, campaign_name: r.campaignName, names_status: r.namesStatus as AdCreativeView['names_status'], thumbnail_url: url };
    }
    return out;
  }
}
