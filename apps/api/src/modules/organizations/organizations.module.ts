import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { PlatformModule } from '../platform';
import { PlatformTrialsController } from './platform-trials.controller';
import { TrialExpiryJob } from './trial-expiry.job';
import { TrialsController } from './trials.controller';
import { TrialsService } from './trials.service';

/** Organizaciones y pruebas gratuitas (M1.5). Usa `withIdentity` (ADR-25, lint P12 permite este módulo). */
@Module({
  imports: [AuditModule, PlatformModule],
  controllers: [TrialsController, PlatformTrialsController],
  providers: [TrialsService, TrialExpiryJob],
  exports: [TrialsService, TrialExpiryJob],
})
export class OrganizationsModule {}
