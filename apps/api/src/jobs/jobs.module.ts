import { Module } from '@nestjs/common';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register()],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob): ScheduledJob[] => [expiry, cleanup, capi], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
