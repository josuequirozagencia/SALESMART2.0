import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { DbModule } from './db';
import { HealthController } from './health/health.controller';
import { HttpModule } from './http';
import { JobsModule } from './jobs';
import { AuthModule, LocalAccessResolver } from './modules/auth';
import { AttributionModule } from './modules/attribution';
import { ChannelsModule } from './modules/channels';
import { InboxModule } from './modules/inbox';
import { ContactsModule } from './modules/contacts';
import { CustomFieldsModule } from './modules/custom-fields';
import { OpportunitiesModule } from './modules/opportunities';
import { OrganizationsModule } from './modules/organizations';
import { PipelinesModule } from './modules/pipelines';
import { QueuesModule } from './modules/queues';
import { SalesModule } from './modules/sales';
import { RealtimeModule } from './modules/realtime';
import { SlaModule } from './modules/sla';
import { QuickRepliesModule } from './modules/quick-replies';
import { TemplatesModule } from './modules/templates';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, OpportunitiesModule, QueuesModule, SlaModule, ChannelsModule, TemplatesModule, QuickRepliesModule, RealtimeModule, SalesModule, InboxModule, AttributionModule.register(), JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [HealthController] })
export class AppModule {}
