import { Module } from '@nestjs/common';
import { AiModule } from '../ai';
import { AuthModule } from '../auth';
import { AutomationsModule } from '../automations';
import { FormsModule } from '../forms';
import { OrganizationsModule } from '../organizations';
import { QueuesModule } from '../queues';
import { OnboardingService } from './onboarding.service';
import { SampleDataController } from './sample-data.controller';
import { SampleDataService } from './sample-data.service';

/** Datos de ejemplo y «Primeros pasos» (M10.6, ADR-56 B5). */
@Module({
  imports: [AiModule, AuthModule, AutomationsModule, FormsModule, OrganizationsModule, QueuesModule],
  controllers: [SampleDataController],
  providers: [SampleDataService, OnboardingService],
  exports: [SampleDataService],
})
export class SampleDataModule {}
