import { Module } from '@nestjs/common';
import { AttributionModule } from '../attribution';
import { AuthModule } from '../auth';
import { ContactsModule } from '../contacts';
import { CustomFieldsModule } from '../custom-fields';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { OutreachModule } from '../outreach';
import { QueuesModule } from '../queues';
import { TagsModule } from '../tags';
import { TemplatesModule } from '../templates';
import { FormFollowUpService } from './form-follow-up.service';
import { FormSubmitService } from './form-submit.service';
import { FormsController } from './forms.controller';
import { FormsEmbedController } from './forms-embed.controller';
import { FormsPublicController } from './forms-public.controller';
import { FormsService } from './forms.service';

/** Formularios embebibles (M9.1, ADR-09/54; F07): administración de la empresa y recepción pública de lo que llena el visitante. */
@Module({
  imports: [AttributionModule.register(), AuthModule, ContactsModule, CustomFieldsModule, OpportunitiesModule, OrganizationsModule, OutreachModule, QueuesModule, TagsModule, TemplatesModule],
  controllers: [FormsController, FormsPublicController, FormsEmbedController],
  providers: [FormsService, FormSubmitService, FormFollowUpService],
  exports: [FormsService],
})
export class FormsModule {}
