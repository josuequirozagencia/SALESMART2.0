import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { AttributionEndpointsService } from '../organizations';
import { CalendarSyncService, SYNC_BATCH } from './calendar-sync.service';

/** Tope de lotes seguidos por empresa y pasada. */
export const CALENDAR_SYNC_MAX_BATCHES_PER_RUN = 5;

/**
 * Tarea periódica de sincronización de citas con Google Calendar (67b, ADR-67). Recorre las empresas cliente activas y, para cada una, reconcilia lo pendiente bajo SU contexto (la RLS impide ver
 * lo de otra); sin calendario conectado no hace nada. Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con pendientes», igual que en GoHighLevel.
 */
@Injectable()
export class CalendarSyncJob implements ScheduledJob {
  readonly name = 'calendar-sync';
  readonly intervalMs = 10_000;

  constructor(
    @Inject(CalendarSyncService) private readonly sync: CalendarSyncService,
    @Inject(AttributionEndpointsService) private readonly orgs: AttributionEndpointsService,
  ) {}

  async run(now: Date): Promise<number> {
    let done = 0;
    for (const organizationId of await this.orgs.activeClientOrgIds()) {
      for (let i = 0; i < CALENDAR_SYNC_MAX_BATCHES_PER_RUN; i++) {
        const n = await TenantContext.run({ organizationId }, () => this.sync.runDue(now));
        done += n;
        if (n < SYNC_BATCH) break;
      }
    }
    return done;
  }
}
