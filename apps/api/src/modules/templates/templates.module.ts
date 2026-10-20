import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels';
import { OrganizationsModule } from '../organizations';
import { TemplatesController } from './templates.controller';
import { TemplatesSyncJob } from './templates-sync.job';
import { TemplatesService } from './templates.service';

/** Plantillas de WhatsApp sincronizadas desde Meta (M5.6a, ADR-50). El Inbox las usa para listarlas y enviarlas. */
@Module({ imports: [ChannelsModule, OrganizationsModule], controllers: [TemplatesController], providers: [TemplatesService, TemplatesSyncJob], exports: [TemplatesService, TemplatesSyncJob] })
export class TemplatesModule {}
