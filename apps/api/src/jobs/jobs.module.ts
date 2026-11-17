import { Module } from '@nestjs/common';
import { AppointmentRemindersJob, AppointmentsModule } from '../modules/appointments';
import { CalendarModule, CalendarSyncJob } from '../modules/calendar';
import { FollowUpsJob, FollowUpsModule } from '../modules/follow-ups';
import { AgentRuntimeJob, AiModule, KnowledgeJob } from '../modules/ai';
import { AttachmentsModule, AttachmentsJob } from '../modules/attachments';
import { AttributionModule, CapiSenderJob } from '../modules/attribution';
import { AuthModule, IdentityCleanupJob } from '../modules/auth';
import { CompanyExportJob, CompanyExportModule } from '../modules/company-export';
import { CompanyPurgeJob, CompanyPurgeModule } from '../modules/company-purge';
import { AutomationsJob, AutomationsModule } from '../modules/automations';
import { CampaignSenderJob, CampaignsModule } from '../modules/campaigns';
import { ConnectionHealthJob, ConnectionHealthModule } from '../modules/connection-health';
import { ChannelsModule, WebhookEventsJob } from '../modules/channels';
import { GhlEventsJob, GhlModule, GhlOutboxJob } from '../modules/ghl';
import { ContactPhotosJob, QrCatchUpJob, QrHeartbeatJob, QrModule } from '../modules/qr';
import { TaskDueNoticesJob, TaskNoticesModule } from '../modules/task-notices';
import { InboxModule, OutboundJob, ScheduledMessagesJob, SlaSweepJob } from '../modules/inbox';
import { OrganizationsModule, TrialExpiryJob } from '../modules/organizations';
import { TemplatesModule, TemplatesSyncJob } from '../modules/templates';
import { JobRunner } from './job-runner';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/** Registro de tareas periódicas. Cada módulo aporta las suyas aquí. */
@Module({
  imports: [OrganizationsModule, AuthModule, AttributionModule.register(), GhlModule.register(), CalendarModule.register(), ChannelsModule, InboxModule, TemplatesModule, AttachmentsModule, AppointmentsModule, AiModule, AutomationsModule, FollowUpsModule, CampaignsModule, ConnectionHealthModule, QrModule, TaskNoticesModule, CompanyExportModule, CompanyPurgeModule],
  providers: [{ provide: SCHEDULED_JOBS, useFactory: (expiry: TrialExpiryJob, cleanup: IdentityCleanupJob, capi: CapiSenderJob, webhooks: WebhookEventsJob, outbound: OutboundJob, slaSweep: SlaSweepJob, templatesSync: TemplatesSyncJob, scheduledMessages: ScheduledMessagesJob, attachments: AttachmentsJob, reminders: AppointmentRemindersJob, ghlEvents: GhlEventsJob, ghlOutbox: GhlOutboxJob, knowledge: KnowledgeJob, agentReplies: AgentRuntimeJob, automationRuns: AutomationsJob, qrHeartbeat: QrHeartbeatJob, qrCatchUp: QrCatchUpJob, taskDue: TaskDueNoticesJob, companyExport: CompanyExportJob, companyPurge: CompanyPurgeJob, contactPhotos: ContactPhotosJob, followUps: FollowUpsJob, calendarSync: CalendarSyncJob, campaignSender: CampaignSenderJob, connectionHealth: ConnectionHealthJob): ScheduledJob[] => [expiry, cleanup, capi, webhooks, outbound, slaSweep, templatesSync, scheduledMessages, attachments, reminders, ghlEvents, ghlOutbox, knowledge, agentReplies, automationRuns, qrHeartbeat, qrCatchUp, taskDue, companyExport, companyPurge, contactPhotos, followUps, calendarSync, campaignSender, connectionHealth], inject: [TrialExpiryJob, IdentityCleanupJob, CapiSenderJob, WebhookEventsJob, OutboundJob, SlaSweepJob, TemplatesSyncJob, ScheduledMessagesJob, AttachmentsJob, AppointmentRemindersJob, GhlEventsJob, GhlOutboxJob, KnowledgeJob, AgentRuntimeJob, AutomationsJob, QrHeartbeatJob, QrCatchUpJob, TaskDueNoticesJob, CompanyExportJob, CompanyPurgeJob, ContactPhotosJob, FollowUpsJob, CalendarSyncJob, CampaignSenderJob, ConnectionHealthJob] }, JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
