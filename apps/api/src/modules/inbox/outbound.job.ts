import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService } from '../organizations';
import { OutboundDispatcher } from './outbound-dispatcher.service';

/**
 * Tarea periódica que envía los mensajes en cola (reintentos tras un fallo pasajero del proveedor y lo que quedó pendiente si el proceso se reinició).
 * Recorre solo las empresas con algún número conectado y procesa los pendientes de cada una bajo SU contexto. Como en la tarea de avisos, con muchas empresas
 * habrá que cambiar el recorrido por una lista de «empresas con pendientes» cuando haya cifras reales.
 */
@Injectable()
export class OutboundJob implements ScheduledJob {
  readonly name = 'outbound-messages';
  readonly intervalMs = 5_000;

  constructor(
    @Inject(OutboundDispatcher) private readonly dispatcher: OutboundDispatcher,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.dispatcher.runDue(now));
    }
    return touched;
  }
}
