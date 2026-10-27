import { Module } from '@nestjs/common';
import { AppointmentRemindersJob, AppointmentsModule } from '../modules/appointments';
import { AgentRuntimeJob, AiModule, KnowledgeJob } from '../modules/ai';
import { AttachmentsModule, AttachmentsJob } from '../modules/attachments';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { AutomationsJob, AutomationsModule } from '../modules/automations';
import { ChannelsModule, WebhookEventsJob } from '../modules/channels';
import { GhlEventsJob, GhlModule, GhlOutboxJob } from '../modules/ghl';
import { InboxModule, OutboundJob, ScheduledMessagesJob, SlaSweepJob } from '../modules/inbox';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { TemplatesModule, TemplatesSyncJob } from '../modules/templates';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register(), GhlModule.register(), ChannelsModule, InboxModule, TemplatesModule, AttachmentsModule, AppointmentsModule, AiModule, AutomationsModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob, webhooks: WebhookEventsJob, outbound: OutboundJob, slaSweep: SlaSweepJob, templatesSync: TemplatesSyncJob, scheduledMessages: ScheduledMessagesJob, attachments: AttachmentsJob, reminders: AppointmentRemindersJob, ghlEvents: GhlEventsJob, ghlOutbox: GhlOutboxJob, knowledge: KnowledgeJob, agentReplies: AgentRuntimeJob, automationRuns: AutomationsJob): ScheduledJob[] => [expiry, cleanup, capi, webhooks, outbound, slaSweep, templatesSync, scheduledMessages, attachments, reminders, ghlEvents, ghlOutbox, knowledge, agentReplies, automationRuns], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob, WebhookEventsJob, OutboundJob, SlaSweepJob, TemplatesSyncJob, ScheduledMessagesJob, AttachmentsJob, AppointmentRemindersJob, GhlEventsJob, GhlOutboxJob, KnowledgeJob, AgentRuntimeJob, AutomationsJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
