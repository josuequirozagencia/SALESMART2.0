import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService } from '../organizations';
import { InboundMediaService } from './inbound-media.service';

/**
 * Tarea periódica de los archivos (M5.6d): descarga los que mandan los clientes y vence los que se subieron y nadie envió. Cada 10 s: un cliente que manda una foto espera verla
 * pronto. Recorre las empresas con algún número conectado y trabaja cada una bajo SU contexto.
 */
@Injectable()
export class AttachmentsJob implements ScheduledJob {
  readonly name = 'attachments';
  readonly intervalMs = 10_000;

  constructor(
    @Inject(InboundMediaService) private readonly inbound: InboundMediaService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.inbound.runDue(now));
    }
    return touched;
  }
}
