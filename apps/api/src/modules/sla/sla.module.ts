import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { SlaConfigService } from './sla-config.service';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';
import { UserHoursService } from './user-hours.service';

/**
 * SLA, horario laboral y cronómetros de respuesta (M5.5b, ADR-50). No depende de colas, conversaciones ni Inbox: ellos le piden los cronómetros (así no hay dependencias en
 * círculo). Usa `OrgDirectoryService` (organizations) para la zona horaria, que es de identidad.
 */
@Module({ imports: [OrganizationsModule], controllers: [SlaController], providers: [SlaService, SlaConfigService, UserHoursService], exports: [SlaService, SlaConfigService, UserHoursService] })
export class SlaModule {}
