import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { AttributionEndpointsService } from '../organizations';
import { AD_NAMES_BATCH, AdNamesService } from './ad-names.service';

/** Pasadas seguidas por empresa en cada vuelta (50 anuncios cada una). */
const MAX_PASSES_PER_RUN = 4;

/** Nombres de anuncio, conjunto y campaña (v20): cada 10 minutos, empresa por empresa, completa los anuncios nuevos o con datos viejos consultando a Meta. */
@Injectable()
export class AdNamesJob implements ScheduledJob {
  readonly name = 'ad-names';
  readonly intervalMs = 10 * 60_000;

  constructor(
    @Inject(AdNamesService) private readonly names: AdNamesService,
    @Inject(AttributionEndpointsService) private readonly orgs: AttributionEndpointsService,
  ) {}

  async run(now: Date): Promise<number> {
    let total = 0;
    for (const organizationId of await this.orgs.activeClientOrgIds()) {
      total += await TenantContext.run({ organizationId }, async () => {
        let n = 0;
        for (let i = 0; i < MAX_PASSES_PER_RUN; i++) {
          const done = await this.names.run(now);
          n += done;
          if (done < AD_NAMES_BATCH) break;
        }
        return n;
      });
    }
    return total;
  }
}
