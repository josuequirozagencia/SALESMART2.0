import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService } from '../organizations';
import { TemplatesService } from './templates.service';

/**
 * Tarea periódica (M5.6a): vuelve a sincronizar las plantillas de las conexiones activas con Meta cada 30 minutos. Recorre solo las empresas con algún número conectado y
 * trabaja cada una bajo SU contexto. Una conexión que falla no frena a las demás: queda anotado en ella y se reintenta en la siguiente pasada.
 */
@Injectable()
export class TemplatesSyncJob implements ScheduledJob {
  readonly name = 'templates-sync';
  readonly intervalMs = 30 * 60_000;

  constructor(
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
  ) {}

  async run(): Promise<number> {
    let done = 0;
    for (const organizationId of await this.routes.organizationIds()) done += await TenantContext.run({ organizationId }, () => this.templates.syncActive());
    return done;
  }
}
