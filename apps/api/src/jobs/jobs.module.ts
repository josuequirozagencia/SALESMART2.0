import { Module } from '@nestjs/common';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob): ScheduledJob[] => [expiry], inject: [TrialExpiryJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
