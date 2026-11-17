import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { CustomFieldsModule } from '../custom-fields';
import { OrganizationsModule } from '../organizations';
import { TemplatesModule } from '../templates';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/** Campañas masivas (v17, ADR-72). 17.1: borradores, audiencia y topes; el envío llega en 17.3 (oficial) y 17.4 (QR). */
@Module({ imports: [ContactsModule, CustomFieldsModule, OrganizationsModule, TemplatesModule], controllers: [CampaignsController], providers: [CampaignsService], exports: [CampaignsService] })
export class CampaignsModule {}
