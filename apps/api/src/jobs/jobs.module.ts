import { Module } from '@nestjs/common';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob): ScheduledJob[] => [expiry, cleanup], inject: [TrialExpiryJob, IdentityCleanupJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
