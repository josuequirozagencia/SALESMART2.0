import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService } from '../organizations';
import { CampaignSenderService } from './campaign-sender.service';

/**
 * Tarea periódica del envío de campañas (v17 · 17.3): cada 5 s, en cada empresa con un número conectado, pasa a «en curso» las programadas que llegaron a su hora, pone al día el estado de los
 * destinatarios y saca el siguiente mensaje de cada campaña respetando su pausa y sus topes. Cada empresa se trabaja bajo SU contexto.
 */
@Injectable()
export class CampaignSenderJob implements ScheduledJob {
  readonly name = 'campaign-sender';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(CampaignSenderService) private readonly sender: CampaignSenderService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.sender.runDue(now));
    }
    return touched;
  }
}
