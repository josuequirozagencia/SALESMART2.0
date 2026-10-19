import { Module } from '@nestjs/common';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { ChannelsModule, WebhookEventsJob } from '../modules/channels';
import { InboxModule, OutboundJob, SlaSweepJob } from '../modules/inbox';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register(), ChannelsModule, InboxModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob, webhooks: WebhookEventsJob, outbound: OutboundJob, slaSweep: SlaSweepJob): ScheduledJob[] => [expiry, cleanup, capi, webhooks, outbound, slaSweep], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob, WebhookEventsJob, OutboundJob, SlaSweepJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
