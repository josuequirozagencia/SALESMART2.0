import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { SlaModule } from '../sla';
import { AssignmentService } from './assignment.service';
import { DistributionService } from './distribution.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

/** Colas y reparto de conversaciones (M5.3, ADR-07/ADR-50). Usa `OrgMembersService`/`OrgDirectoryService` (organizations) para las personas: son de identidad (ADR-25). */
@Module({
  imports: [OrganizationsModule, ContactsModule, RealtimeModule, SlaModule],
  controllers: [QueuesController, ProductsController],
  providers: [DistributionService, AssignmentService, QueuesService, ProductsService],
  exports: [AssignmentService, DistributionService, QueuesService, ProductsService],
})
export class QueuesModule {}
