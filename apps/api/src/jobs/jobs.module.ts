import { Module } from '@nestjs/common';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { ChannelsModule, WebhookEventsJob } from '../modules/channels';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register(), ChannelsModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob, webhooks: WebhookEventsJob): ScheduledJob[] => [expiry, cleanup, capi, webhooks], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob, WebhookEventsJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
