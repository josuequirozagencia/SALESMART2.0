import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AuthModule } from '../auth';
import { InboxModule } from '../inbox';
import { OrganizationsModule } from '../organizations';
import { QueuesModule } from '../queues';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

/** Usuarios del equipo (M10.3, ADR-56): coordina identidad (organizations/auth) con negocio (inbox, queues) sin tocar las tablas de identidad. */
@Module({
  imports: [AuditModule, AuthModule, OrganizationsModule, InboxModule, QueuesModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
