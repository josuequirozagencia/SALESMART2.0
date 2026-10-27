import { Module } from '@nestjs/common';
import { MailModule } from '../../mail';
import { AuditModule } from '../audit';
import { PlatformModule } from '../platform';
import { AgenciesService } from './agencies.service';
import { AgencyAccessService } from './agency-access.service';
import { AgencyClientsController } from './agency-clients.controller';
import { AgencyClientsService } from './agency-clients.service';
import { AttributionEndpointsService } from './attribution-endpoints.service';
import { FormRoutesService } from './form-routes.service';
import { GhlRoutesService } from './ghl-routes.service';
import { ChannelRoutesService } from './channel-routes.service';
import { OrgDirectoryService } from './org-directory.service';
import { OrgMembersService } from './org-members.service';
import { CompaniesService } from './companies.service';
import { PlatformAgenciesController } from './platform-agencies.controller';
import { PlatformCompaniesController, PlatformPlansController } from './platform-companies.controller';
import { PlatformTrialsController } from './platform-trials.controller';
import { PlansService } from './plans.service';
import { TrialExpiryJob } from './trial-expiry.job';
import { TrialsController } from './trials.controller';
import { TrialsService } from './trials.service';

/** Organizaciones y pruebas gratuitas (M1.5). Usa `withIdentity` (ADR-25, lint P12 permite este módulo). */
@Module({
  imports: [AuditModule, PlatformModule, MailModule],
  controllers: [TrialsController, PlatformTrialsController, PlatformPlansController, PlatformCompaniesController, PlatformAgenciesController, AgencyClientsController],
  providers: [FormRoutesService, TrialsService, TrialExpiryJob, PlansService, CompaniesService, AgencyAccessService, AgenciesService, AgencyClientsService, OrgMembersService, OrgDirectoryService, AttributionEndpointsService, GhlRoutesService, ChannelRoutesService],
  exports: [FormRoutesService, TrialsService, TrialExpiryJob, PlansService, CompaniesService, AgencyAccessService, AgenciesService, OrgMembersService, OrgDirectoryService, AttributionEndpointsService, GhlRoutesService, ChannelRoutesService],
})
export class OrganizationsModule {}
