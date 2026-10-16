import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { AttributionEndpointsService } from '../organizations';
import { CapiSenderService } from './capi-sender.service';

/**
 * Tarea periódica de envío de eventos a Meta (ADR-45). Recorre las empresas cliente activas y, para cada una, envía sus pendientes bajo SU contexto (la RLS
 * impide ver eventos de otra). Sin proveedor configurado no hace nada. Con muchas empresas habrá que cambiar el recorrido por una cola de «empresas con
 * pendientes»: se decide en M6, cuando haya un proveedor real.
 */
@Injectable()
export class CapiSenderJob implements ScheduledJob {
  readonly name = 'capi-sender';
  readonly intervalMs = 30_000;

  constructor(
    @Inject(CapiSenderService) private readonly sender: CapiSenderService,
    @Inject(AttributionEndpointsService) private readonly orgs: AttributionEndpointsService,
  ) {}

  async run(now: Date): Promise<number> {
    if (!this.sender.enabled) return 0;
    let sent = 0;
    for (const organizationId of await this.orgs.activeClientOrgIds()) {
      sent += await TenantContext.run({ organizationId }, () => this.sender.runDue(now));
    }
    return sent;
  }
}
