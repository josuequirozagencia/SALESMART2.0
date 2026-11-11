import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { OrgDirectoryService } from '../organizations';
import { FollowUpRunnerService } from './follow-up-runner.service';

/**
 * Tarea periódica de los seguimientos del agente (v11 S5, ADR-68): cada 30 s recorre las empresas CLIENTE operativas y, bajo el contexto de cada una, resuelve los pasos que ya les toca. Igual que el agente
 * en vivo (`agent-replies`): con muchas empresas habrá que cambiar el recorrido por «empresas con seguimientos pendientes».
 */
@Injectable()
export class FollowUpsJob implements ScheduledJob {
  readonly name = 'agent-follow-ups';
  readonly intervalMs = 30_000;

  constructor(
    @Inject(FollowUpRunnerService) private readonly runner: FollowUpRunnerService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.directory.clientOrganizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.runner.runDue(now));
    }
    return touched;
  }
}
