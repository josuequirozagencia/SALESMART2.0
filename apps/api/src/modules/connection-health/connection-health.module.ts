import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { SlaModule } from '../sla';
import { ConnectionHealthController } from './connection-health.controller';
import { ConnectionHealthJob } from './connection-health.job';
import { ConnectionHealthService } from './connection-health.service';

/** Salud de las conexiones y sus alertas (v19 B1/B4). */
@Module({ imports: [OrganizationsModule, SlaModule], controllers: [ConnectionHealthController], providers: [ConnectionHealthService, ConnectionHealthJob], exports: [ConnectionHealthService, ConnectionHealthJob] })
export class ConnectionHealthModule {}
