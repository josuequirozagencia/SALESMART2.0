import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { CustomFieldsModule } from '../custom-fields';
import { OrganizationsModule } from '../organizations';
import { OutreachModule } from '../outreach';
import { TemplatesModule } from '../templates';
import { CampaignSenderJob } from './campaign-sender.job';
import { CampaignSenderService } from './campaign-sender.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/** Campañas masivas (v17, ADR-72). 17.1: borradores, audiencia y topes · 17.3: envío por WhatsApp oficial · 17.4 (QR) llega después. */
@Module({ imports: [ContactsModule, CustomFieldsModule, OrganizationsModule, OutreachModule, TemplatesModule], controllers: [CampaignsController], providers: [CampaignsService, CampaignSenderService, CampaignSenderJob], exports: [CampaignsService, CampaignSenderService, CampaignSenderJob] })
export class CampaignsModule {}
