import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { DbModule } from './db';
import { HealthController } from './health/health.controller';
import { HttpModule } from './http';
import { AuthModule, LocalAccessResolver } from './modules/auth';

@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [HealthController] })
export class AppModule {}
