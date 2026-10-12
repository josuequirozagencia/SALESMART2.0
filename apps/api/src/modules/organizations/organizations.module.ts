import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { PlatformModule } from '../platform';
import { CompaniesService } from './companies.service';
import { PlatformCompaniesController, PlatformPlansController } from './platform-companies.controller';
import { PlatformTrialsController } from './platform-trials.controller';
import { PlansService } from './plans.service';
import { TrialExpiryJob } from './trial-expiry.job';
import { TrialsController } from './trials.controller';
import { TrialsService } from './trials.service';

/** Organizaciones y pruebas gratuitas (M1.5). Usa `withIdentity` (ADR-25, lint P12 permite este módulo). */
@Module({
  imports: [AuditModule, PlatformModule],
  controllers: [TrialsController, PlatformTrialsController, PlatformPlansController, PlatformCompaniesController],
  providers: [TrialsService, TrialExpiryJob, PlansService, CompaniesService],
  exports: [TrialsService, TrialExpiryJob, PlansService, CompaniesService],
})
export class OrganizationsModule {}
