import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { DbModule } from './db';
import { HealthController } from './health/health.controller';
import { HttpModule } from './http';
import { JobsModule } from './jobs';
import { AuthModule, LocalAccessResolver } from './modules/auth';
import { OrganizationsModule } from './modules/organizations';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [HealthController] })
export class AppModule {}
