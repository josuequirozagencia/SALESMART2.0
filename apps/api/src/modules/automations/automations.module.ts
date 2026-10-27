import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { CustomFieldsModule } from '../custom-fields';
import { EventsModule } from '../events';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { OutreachModule } from '../outreach';
import { QueuesModule } from '../queues';
import { TagsModule } from '../tags';
import { TemplatesModule } from '../templates';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationEnqueueService } from './automation-enqueue.service';
import { AutomationRunnerService } from './automation-runner.service';
import { AutomationsController } from './automations.controller';
import { AutomationsJob } from './automations.job';
import { AutomationsService } from './automations.service';

/** Automatizaciones (M9.3, ADR-54; F20): reglas «cuando ocurre esto, si se cumple aquello, haz esto otro». El encolador escucha los hechos del negocio y el motor los ejecuta con una tarea periódica. */
@Module({
  imports: [ContactsModule, CustomFieldsModule, EventsModule, OpportunitiesModule, OrganizationsModule, OutreachModule, QueuesModule, TagsModule, TemplatesModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationEnqueueService, AutomationActionsService, AutomationRunnerService, AutomationsJob],
  exports: [AutomationsJob],
})
export class AutomationsModule {}
