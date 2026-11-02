import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { OrgDirectoryService } from '../organizations';
import { TaskNoticesService } from './task-notices.service';

/**
 * Tarea periódica de los avisos de vencimiento (F2, ADR-58): cada minuto crea el aviso «tu tarea vence» de las tareas cuyo momento ya llegó. Recorre las empresas cliente (una tarea no necesita ningún
 * canal conectado) y trabaja cada una bajo SU contexto. La lista de quién puede recibir trabajo es de identidad y se lee ANTES de la transacción de negocio.
 */
@Injectable()
export class TaskDueNoticesJob implements ScheduledJob {
  readonly name = 'task-due-notices';
  readonly intervalMs = 60_000;

  constructor(
    @Inject(TaskNoticesService) private readonly notices: TaskNoticesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.directory.clientOrganizationIds()) {
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      touched += await TenantContext.run({ organizationId }, () => this.notices.runDue(now, dir.assignable));
    }
    return touched;
  }
}
