import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService, OrgDirectoryService } from '../organizations';
import { EVENT_BATCH, WebhookEventsService } from './webhook-events.service';

/** Tope de lotes seguidos por empresa y pasada: una ráfaga grande se drena rápido, pero ninguna empresa acapara la tarea. */
export const MAX_BATCHES_PER_RUN = 10;

/**
 * Tarea periódica que procesa los avisos del webhook (ADR-50 #4). Recorre solo las empresas que tienen algún número conectado y, para cada una, procesa sus
 * avisos pendientes bajo SU contexto (la RLS impide ver los de otra). Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con
 * pendientes»: se decide cuando haya cifras reales, igual que en el envío de eventos a Meta.
 */
@Injectable()
export class WebhookEventsJob implements ScheduledJob {
  readonly name = 'webhook-events';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(WebhookEventsService) private readonly events: WebhookEventsService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let processed = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      // Lo de identidad (zona horaria, quién puede recibir trabajo) se lee ANTES de abrir la transacción de negocio; se guarda 30 s por empresa
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const n = await TenantContext.run({ organizationId }, () => this.events.runDue(now, dir));
        processed += n;
        if (n < EVENT_BATCH) break; // lote incompleto: ya no quedan avisos pendientes
      }
    }
    return processed;
  }
}
