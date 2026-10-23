import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { ChannelRoutesService, OrgDirectoryService } from '../organizations';
import { AppointmentsService } from './appointments.service';

/**
 * Tarea periódica de los recordatorios de cita (M6.3, ADR-13): envía los que ya les toca. Cada 30 s, para que «1 hora antes» salga a la hora y no minutos después. Recorre las
 * empresas con algún número conectado (sin conexión no hay por dónde recordar) y trabaja cada una bajo SU contexto.
 */
@Injectable()
export class AppointmentRemindersJob implements ScheduledJob {
  readonly name = 'appointment-reminders';
  readonly intervalMs = 30_000;

  constructor(
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      // La zona horaria (identidad) se lee ANTES de la transacción de negocio
      const dir = await TenantContext.run({ organizationId }, () => this.directory.current());
      touched += await TenantContext.run({ organizationId }, () => this.appointments.runDue(now, dir.timeZone));
    }
    return touched;
  }
}
