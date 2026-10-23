import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth';
import { OrganizationsModule } from '../organizations';
import { RealtimeInterceptor } from './realtime.interceptor';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [AuthModule, OrganizationsModule],
  providers: [RealtimeService, { provide: APP_INTERCEPTOR, useClass: RealtimeInterceptor }],
  exports: [RealtimeService],
})
export class RealtimeModule {}
