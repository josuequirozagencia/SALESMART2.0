import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { AttachmentsModule } from '../attachments';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { AiAdminService } from './ai-admin.service';
import { AiCreditsService } from './ai-credits.service';
import { AiGateway } from './ai-gateway.service';
import { AiAdminController, AiCreditsController } from './ai.controller';
import { FakeAiProvider } from './ai.fake';
import { AI_PROVIDER, NoAiProvider, type AIProvider } from './ai.ports';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { KnowledgeJob } from './knowledge/knowledge.job';
import { KnowledgeProcessorService } from './knowledge/knowledge-processor.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { PgArrayVectorStore, VECTOR_STORE } from './knowledge/vector-store';
import { OpenAiProvider } from './openai.provider';

/** El adaptador de IA que dice la configuración (las pruebas registran el suyo sobreescribiendo `AI_PROVIDER`). */
export function buildAiProvider(cfg: AppConfig): AIProvider {
  return cfg.ai.provider === 'openai' ? new OpenAiProvider() : cfg.ai.provider === 'fake' ? new FakeAiProvider() : new NoAiProvider();
}

/** IA (M8, ADR-53): créditos (M8.1) y conocimiento (M8.2). Después: agentes, prueba y agente en vivo. */
@Module({
  imports: [OrganizationsModule, PlatformModule, AttachmentsModule],
  controllers: [AiCreditsController, AiAdminController, KnowledgeController],
  providers: [
    AiCreditsService,
    AiAdminService,
    AiGateway,
    KnowledgeService,
    KnowledgeProcessorService,
    KnowledgeJob,
    { provide: AI_PROVIDER, useFactory: buildAiProvider, inject: [APP_CONFIG] },
    { provide: VECTOR_STORE, useFactory: () => new PgArrayVectorStore() },
  ],
  exports: [AiCreditsService, AiGateway, KnowledgeService, KnowledgeJob],
})
export class AiModule {}
