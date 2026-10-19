import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { PipelinesModule } from '../pipelines';
import { TagsModule } from '../tags';
import { OpportunitiesController, PipelineSummaryController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

/** Oportunidades (M4.2, ADR-49): un contacto en un pipeline, con su historial de etapas. */
@Module({ imports: [ContactsModule, PipelinesModule, OrganizationsModule, TagsModule], controllers: [OpportunitiesController, PipelineSummaryController], providers: [OpportunitiesService], exports: [OpportunitiesService] })
export class OpportunitiesModule {}
