import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { AttributionEndpointsService } from '../organizations';
import { GHL_OUTBOX_BATCH, GhlOutboxService } from './ghl-outbox.service';

/** Tope de lotes seguidos por empresa y pasada. */
export const GHL_OUTBOX_MAX_BATCHES_PER_RUN = 5;

/**
 * Tarea periódica de envío de etiquetas a GoHighLevel (M7.3, ADR-52). Recorre las empresas cliente activas y, para cada una, envía lo pendiente bajo SU contexto (la RLS impide ver lo de otra);
 * sin conexión activa no hace nada. Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con pendientes», igual que en el envío a Meta.
 */
@Injectable()
export class GhlOutboxJob implements ScheduledJob {
  readonly name = 'ghl-outbox';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(GhlOutboxService) private readonly outbox: GhlOutboxService,
    @Inject(AttributionEndpointsService) private readonly orgs: AttributionEndpointsService,
  ) {}

  async run(now: Date): Promise<number> {
    let sent = 0;
    for (const organizationId of await this.orgs.activeClientOrgIds()) {
      for (let i = 0; i < GHL_OUTBOX_MAX_BATCHES_PER_RUN; i++) {
        const n = await TenantContext.run({ organizationId }, () => this.outbox.runDue(now));
        sent += n;
        if (n < GHL_OUTBOX_BATCH) break;
      }
    }
    return sent;
  }
}
