import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { AiAdminService } from './ai-admin.service';
import { AiCreditsService } from './ai-credits.service';
import { AiAdminController, AiCreditsController } from './ai.controller';

/** IA (M8, ADR-53). Por ahora: créditos (M8.1). Después: conocimiento, agentes, prueba y agente en vivo. */
@Module({
  imports: [OrganizationsModule, PlatformModule],
  controllers: [AiCreditsController, AiAdminController],
  providers: [AiCreditsService, AiAdminService],
  exports: [AiCreditsService],
})
export class AiModule {}
