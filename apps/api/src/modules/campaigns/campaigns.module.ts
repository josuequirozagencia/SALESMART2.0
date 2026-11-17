import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { EventsModule } from '../events';
import { CustomFieldsModule } from '../custom-fields';
import { OrganizationsModule } from '../organizations';
import { OutreachModule } from '../outreach';
import { TemplatesModule } from '../templates';
import { CampaignResponsesService } from './campaign-responses.service';
import { CampaignResultsService } from './campaign-results.service';
import { CampaignSenderJob } from './campaign-sender.job';
import { CampaignSenderService } from './campaign-sender.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/** Campañas masivas (v17, ADR-72). 17.1: borradores, audiencia y topes · 17.3: envío por WhatsApp oficial · 17.4: por QR · 17.5: resultados, CSV y baja por palabra clave. */
@Module({ imports: [ContactsModule, CustomFieldsModule, EventsModule, OrganizationsModule, OutreachModule, TemplatesModule], controllers: [CampaignsController], providers: [CampaignsService, CampaignResultsService, CampaignResponsesService, CampaignSenderService, CampaignSenderJob], exports: [CampaignsService, CampaignResultsService, CampaignResponsesService, CampaignSenderService, CampaignSenderJob] })
export class CampaignsModule {}
