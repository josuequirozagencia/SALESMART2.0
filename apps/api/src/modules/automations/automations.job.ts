import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { OrgDirectoryService } from '../organizations';
import { AutomationRunnerService } from './automation-runner.service';

/**
 * Tarea periódica del motor de automatizaciones (M9.3, ADR-54): ejecuta las ejecuciones en cola de cada empresa CLIENTE bajo SU contexto (la RLS impide ver las de otra). Cada 5 s, para que una
 * respuesta automática salga casi al instante. Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con ejecuciones en cola» (hoy es una consulta barata por empresa).
 */
@Injectable()
export class AutomationsJob implements ScheduledJob {
  readonly name = 'automation-runs';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(AutomationRunnerService) private readonly runner: AutomationRunnerService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.directory.clientOrganizationIds()) {
      // Lo de identidad (zona horaria, quién puede recibir trabajo) se lee ANTES de la transacción de negocio
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      touched += await TenantContext.run({ organizationId }, () => this.runner.runDue(now, dir));
    }
    return touched;
  }
}
