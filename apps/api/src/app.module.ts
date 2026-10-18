import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { DbModule } from './db';
import { HealthController } from './health/health.controller';
import { HttpModule } from './http';
import { JobsModule } from './jobs';
import { AuthModule, LocalAccessResolver } from './modules/auth';
import { AttributionModule } from './modules/attribution';
import { ContactsModule } from './modules/contacts';
import { CustomFieldsModule } from './modules/custom-fields';
import { OrganizationsModule } from './modules/organizations';
import { PipelinesModule } from './modules/pipelines';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, AttributionModule.register(), JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [HealthController] })
export class AppModule {}
