import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { adCreatives, Database } from '../../db';
import { CAPI_PROVIDER, CapiSendError, type CapiProvider } from './capi.ports';
import { MetaSettingsService } from './meta-settings.service';

export const AD_NAMES_BATCH = 50;
const HOUR = 60 * 60_000;
/** Cuánto esperar antes de volver a preguntar por un anuncio, según el resultado de la última vez. */
const RECHECK_MS = { ok: 7 * 24 * HOUR, not_found: 24 * HOUR, no_access: 6 * HOUR, error: HOUR } as const;

/**
 * Nombres reales de los anuncios (anuncio, conjunto y campaña; v20, ADR-55 enmienda): el aviso de WhatsApp solo trae el id del anuncio, así que se le pregunta a la Marketing API de Meta
 * (solo lectura) con el MISMO token que la empresa ya conectó para la API de Conversiones. Sin conexión no hace nada. Corre bajo el contexto de una empresa. Si Meta dice que el token no puede
 * leer anuncios, los anuncios quedan marcados `no_access` (la pantalla avisa que hace falta el permiso) y se reintenta pasadas unas horas. Nunca bloquea ni toca los eventos de conversión.
 */
@Injectable()
export class AdNamesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CAPI_PROVIDER) private readonly provider: CapiProvider,
    @Inject(MetaSettingsService) private readonly settings: MetaSettingsService,
  ) {}

  async run(now = new Date()): Promise<number> {
    if (this.provider.kind === 'none') return 0;
    const prep = await this.db.withTenant(async (tx) => {
      const creds = await this.settings.credentials(tx);
      if (!creds && this.provider.requiresCredentials) return null;
      const before = (ms: number): Date => new Date(now.getTime() - ms);
      const due = await tx
        .select({ id: adCreatives.id, sourceId: adCreatives.sourceId })
        .from(adCreatives)
        .where(
          or(
            isNull(adCreatives.namesCheckedAt),
            and(eq(adCreatives.namesStatus, 'ok'), lt(adCreatives.namesCheckedAt, before(RECHECK_MS.ok))),
            and(eq(adCreatives.namesStatus, 'not_found'), lt(adCreatives.namesCheckedAt, before(RECHECK_MS.not_found))),
            and(eq(adCreatives.namesStatus, 'no_access'), lt(adCreatives.namesCheckedAt, before(RECHECK_MS.no_access))),
            and(eq(adCreatives.namesStatus, 'error'), lt(adCreatives.namesCheckedAt, before(RECHECK_MS.error))),
          ),
        )
        .orderBy(asc(adCreatives.namesCheckedAt), asc(adCreatives.id))
        .limit(AD_NAMES_BATCH);
      return { creds: creds ?? { datasetId: 'fake', accessToken: 'fake' }, due };
    });
    if (!prep || prep.due.length === 0) return 0;

    // La llamada a Meta va FUERA de la transacción: no se retiene una conexión de la base mientras se espera a la red
    let found: Awaited<ReturnType<CapiProvider['lookupAds']>> | null = null;
    let failure: 'no_access' | 'error' | null = null;
    try {
      found = await this.provider.lookupAds(
        prep.due.map((d) => d.sourceId),
        prep.creds,
      );
    } catch (e) {
      failure = e instanceof CapiSendError && e.credentials ? 'no_access' : 'error';
    }
    await this.db.withTenant(async (tx) => {
      if (failure || !found) {
        await tx
          .update(adCreatives)
          .set({ namesStatus: failure ?? 'error', namesCheckedAt: now })
          .where(inArray(adCreatives.id, prep.due.map((d) => d.id)));
        return;
      }
      for (const d of prep.due) {
        const n = found[d.sourceId] ?? null;
        await tx
          .update(adCreatives)
          .set(
            n
              ? { adName: n.adName, adsetId: n.adsetId, adsetName: n.adsetName, campaignId: n.campaignId, campaignName: n.campaignName, namesStatus: 'ok', namesCheckedAt: now }
              : { namesStatus: 'not_found', namesCheckedAt: now },
          )
          .where(eq(adCreatives.id, d.id));
      }
    });
    return prep.due.length;
  }
}
