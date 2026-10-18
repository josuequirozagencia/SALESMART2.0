import { Module } from '@nestjs/common';
import { PipelineStagesController, PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';

/** Pipelines y etapas (M4.1, ADR-49). `PipelinesService` lo usarán las oportunidades (M4.2). */
@Module({ controllers: [PipelinesController, PipelineStagesController], providers: [PipelinesService], exports: [PipelinesService] })
export class PipelinesModule {}
