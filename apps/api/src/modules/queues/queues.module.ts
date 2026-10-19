import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { AssignmentService } from './assignment.service';
import { DistributionService } from './distribution.service';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

/** Colas y reparto de conversaciones (M5.3, ADR-07/ADR-50). Usa `OrgMembersService`/`OrgDirectoryService` (organizations) para las personas: son de identidad (ADR-25). */
@Module({
  imports: [OrganizationsModule, ContactsModule],
  controllers: [QueuesController],
  providers: [DistributionService, AssignmentService, QueuesService],
  exports: [AssignmentService, QueuesService],
})
export class QueuesModule {}
