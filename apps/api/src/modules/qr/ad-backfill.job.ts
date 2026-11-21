import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { QrRoutesService } from '../organizations';
import { AD_BACKFILL_BATCH, AdBackfillService } from './ad-backfill.service';

/** Pasadas seguidas por empresa en cada vuelta: una empresa con muchos avisos se pone al día en varias vueltas sin acaparar la tarea. */
const MAX_PASSES_PER_RUN = 5;

/**
 * Recuperación de anuncios de WhatsApp por QR (v20, ADR-55): cada 10 minutos revisa, empresa por empresa, los avisos guardados con anuncio que aún no se leyeron. Cuando no queda ninguno, la consulta es
 * barata (índice parcial). Sirve también como respaldo del camino en vivo. Corre bajo el contexto de cada empresa.
 */
@Injectable()
export class AdBackfillJob implements ScheduledJob {
  readonly name = 'ad-backfill';
  readonly intervalMs = 10 * 60_000;

  constructor(
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(AdBackfillService) private readonly backfill: AdBackfillService,
  ) {}

  async run(now: Date): Promise<number> {
    let scanned = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      scanned += await TenantContext.run({ organizationId }, async () => {
        let n = 0;
        for (let i = 0; i < MAX_PASSES_PER_RUN; i++) {
          const r = await this.backfill.run(now);
          n += r.scanned;
          if (r.scanned < AD_BACKFILL_BATCH) break;
        }
        return n;
      });
    }
    return scanned;
  }
}
