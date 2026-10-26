import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { GhlRoutesService, OrgDirectoryService } from '../organizations';
import { GHL_EVENT_BATCH, GhlEventsService } from './ghl-events.service';

/** Tope de lotes seguidos por empresa y pasada: una ráfaga grande se drena rápido, pero ninguna empresa acapara la tarea. */
export const GHL_MAX_BATCHES_PER_RUN = 10;

/**
 * Tarea periódica que procesa los avisos del Workflow de GoHighLevel (M7.2, ADR-52). Recorre solo las empresas que tienen punto de entrada y, para cada una, procesa sus avisos
 * pendientes bajo SU contexto (la RLS impide ver los de otra). Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con pendientes», igual que en Meta.
 */
@Injectable()
export class GhlEventsJob implements ScheduledJob {
  readonly name = 'ghl-events';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(GhlEventsService) private readonly events: GhlEventsService,
    @Inject(GhlRoutesService) private readonly routes: GhlRoutesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let processed = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      // Lo de identidad (zona horaria, quién puede recibir trabajo) se lee ANTES de abrir la transacción de negocio; se guarda 30 s por empresa
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      for (let i = 0; i < GHL_MAX_BATCHES_PER_RUN; i++) {
        const n = await TenantContext.run({ organizationId }, () => this.events.runDue(now, dir));
        processed += n;
        if (n < GHL_EVENT_BATCH) break; // lote incompleto: ya no quedan avisos pendientes
      }
    }
    return processed;
  }
}
