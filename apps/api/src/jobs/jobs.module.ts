import { Module } from '@nestjs/common';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { ChannelsModule, WebhookEventsJob } from '../modules/channels';
import { InboxModule, OutboundJob, ScheduledMessagesJob, SlaSweepJob } from '../modules/inbox';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { TemplatesModule, TemplatesSyncJob } from '../modules/templates';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register(), ChannelsModule, InboxModule, TemplatesModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob, webhooks: WebhookEventsJob, outbound: OutboundJob, slaSweep: SlaSweepJob, templatesSync: TemplatesSyncJob, scheduledMessages: ScheduledMessagesJob): ScheduledJob[] => [expiry, cleanup, capi, webhooks, outbound, slaSweep, templatesSync, scheduledMessages], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob, WebhookEventsJob, OutboundJob, SlaSweepJob, TemplatesSyncJob, ScheduledMessagesJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
