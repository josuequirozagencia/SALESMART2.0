import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { DbModule } from './db';
import { HealthController } from './health/health.controller';
import { HttpModule } from './http';
import { JobsModule } from './jobs';
import { AuthModule, LocalAccessResolver } from './modules/auth';
import { ContactsModule } from './modules/contacts';
import { OrganizationsModule } from './modules/organizations';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [HealthController] })
export class AppModule {}
