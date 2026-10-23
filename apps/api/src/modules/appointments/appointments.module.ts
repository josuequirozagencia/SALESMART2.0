import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { RealtimeModule } from '../realtime';
import { TemplatesModule } from '../templates';
import { AppointmentRemindersJob } from './appointments.job';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

/** Citas y recordatorios (M6.3, ADR-13/51). Al agendar: etiqueta Cita agendada y evento Schedule a Meta (atribución), oportunidad a la etapa de cita y recordatorios programados. */
@Module({
  imports: [AttributionModule.register(), OpportunitiesModule, OrganizationsModule, RealtimeModule, TemplatesModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentRemindersJob],
  exports: [AppointmentsService, AppointmentRemindersJob],
})
export class AppointmentsModule {}
