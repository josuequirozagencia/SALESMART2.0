import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService, OrgDirectoryService } from '../organizations';
import { ScheduledMessagesService } from './scheduled-messages.service';

/**
 * Tarea periódica de los mensajes programados (M5.6c): envía los que llegaron a su hora y cancela los que ya no hacen falta (el cliente contestó, la conversación se finalizó).
 * Cada 15 s, para que «a las 10:00» salga a las 10:00 y no minutos después. Recorre las empresas con algún número conectado y trabaja cada una bajo SU contexto.
 */
@Injectable()
export class ScheduledMessagesJob implements ScheduledJob {
  readonly name = 'scheduled-messages';
  readonly intervalMs = 15_000;

  constructor(
    @Inject(ScheduledMessagesService) private readonly scheduled: ScheduledMessagesService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      // Lo de identidad (zona horaria, quién puede recibir trabajo) se lee ANTES de la transacción de negocio
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      touched += await TenantContext.run({ organizationId }, () => this.scheduled.runDue(now, dir));
    }
    return touched;
  }
}
