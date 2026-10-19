import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService, OrgDirectoryService } from '../organizations';
import { ReassignService } from './reassign.service';

/**
 * Tarea periódica del SLA (M5.5b): reasigna las conversaciones que nadie respondió a tiempo y reparte lo que esperó a que una cola abriera. Recorre las empresas con algún
 * número conectado y trabaja cada una bajo SU contexto (la RLS impide ver otra). Cada 30 s: el SLA se mide en minutos, no en segundos. Con muchas empresas habrá que cambiar el
 * recorrido por una lista de «empresas con pendientes» cuando haya cifras reales, igual que en las otras tareas de canales.
 */
@Injectable()
export class SlaSweepJob implements ScheduledJob {
  readonly name = 'sla-sweep';
  readonly intervalMs = 30_000;

  constructor(
    @Inject(ReassignService) private readonly reassign: ReassignService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      // Lo de identidad (zona horaria, quién recibe trabajo) se lee ANTES de abrir la transacción de negocio; se guarda 30 s por empresa
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      touched += await TenantContext.run({ organizationId }, () => this.reassign.runDue(now, dir));
      touched += await TenantContext.run({ organizationId }, () => this.reassign.runPickup(now, dir));
    }
    return touched;
  }
}
