import { Module } from '@nestjs/common';
import { AiModule } from '../ai';
import { AutomationsModule } from '../automations';
import { OrganizationsModule } from '../organizations';
import { RealtimeModule } from '../realtime';
import { SlaModule } from '../sla';
import { FollowUpRunnerService } from './follow-up-runner.service';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsJob } from './follow-ups.job';
import { FollowUpsService } from './follow-ups.service';

/**
 * Seguimientos automáticos del agente de IA (v11 S5, ADR-68). Módulo aparte porque depende de las automatizaciones, que ya dependen del módulo de IA (un solo sentido). El agente en vivo solo
 * anuncia que respondió (`AgentReplyBus`); este módulo se registra al arrancar y arma los pasos.
 */
@Module({
  imports: [AiModule, AutomationsModule, OrganizationsModule, RealtimeModule, SlaModule],
  controllers: [FollowUpsController],
  providers: [FollowUpsService, FollowUpRunnerService, FollowUpsJob],
  exports: [FollowUpsJob],
})
export class FollowUpsModule {}
