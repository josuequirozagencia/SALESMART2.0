import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../../jobs/scheduled-job';
import { TenantContext } from '../../../tenant';
import { OrgDirectoryService } from '../../organizations';
import { AgentRuntimeService } from './agent-runtime.service';

/**
 * Tarea periódica del agente de IA en vivo (M8.5, ADR-53). Recorre las empresas CLIENTE y, para cada una, atiende las conversaciones con mensajes sin contestar bajo SU contexto.
 * Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con un agente activo» (hoy es una consulta barata por empresa cada 5 s).
 */
@Injectable()
export class AgentRuntimeJob implements ScheduledJob {
  readonly name = 'agent-replies';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.directory.clientOrganizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.runtime.runDue(now));
    }
    return touched;
  }
}
