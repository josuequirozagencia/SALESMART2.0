import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { AttachmentsModule } from '../attachments';
import { ContactsModule } from '../contacts';
import { CustomFieldsModule } from '../custom-fields';
import { RealtimeModule } from '../realtime';
import { TaskNoticesModule } from '../task-notices';
import { QueuesModule } from '../queues';
import { SlaModule } from '../sla';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { AiAdminService } from './ai-admin.service';
import { AiCreditsService } from './ai-credits.service';
import { AiGateway } from './ai-gateway.service';
import { AgentTestService } from './agents/agent-test.service';
import { AgentTurnService } from './agents/agent-turn.service';
import { AgentToolsService } from './tools/agent-tools.service';
import { AgentsController } from './agents/agents.controller';
import { AgentsService } from './agents/agents.service';
import { AiAdminController, AiCreditsController } from './ai.controller';
import { FakeAiProvider } from './ai.fake';
import { AI_PROVIDER, NoAiProvider, type AIProvider } from './ai.ports';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { KnowledgeJob } from './knowledge/knowledge.job';
import { KnowledgeProcessorService } from './knowledge/knowledge-processor.service';
import { KnowledgeService } from './knowledge/knowledge.service';
import { PgArrayVectorStore, VECTOR_STORE } from './knowledge/vector-store';
import { OpenAiProvider } from './openai.provider';
import { AgentRuntimeJob } from './runtime/agent-runtime.job';
import { AgentMediaService } from './runtime/agent-media.service';
import { AgentRuntimeService } from './runtime/agent-runtime.service';
import { AgentReplyBus } from './runtime/agent-reply.bus';
import { ConversationAiController } from './runtime/conversation-ai.controller';
import { ReplySuggestionService } from './runtime/reply-suggestion.service';

/** El adaptador de IA que dice la configuración (las pruebas registran el suyo sobreescribiendo `AI_PROVIDER`). */
export function buildAiProvider(cfg: AppConfig): AIProvider {
  return cfg.ai.provider === 'openai' ? new OpenAiProvider() : cfg.ai.provider === 'fake' ? new FakeAiProvider() : new NoAiProvider();
}

/** IA (M8, ADR-53): créditos (M8.1), conocimiento (M8.2), agentes (M8.3), simulador de prueba (M8.4) y agente en vivo en el Inbox (M8.5). */
@Module({
  imports: [OrganizationsModule, PlatformModule, AttachmentsModule, ContactsModule, CustomFieldsModule, RealtimeModule, SlaModule, QueuesModule, TaskNoticesModule],
  controllers: [AiCreditsController, AiAdminController, KnowledgeController, AgentsController, ConversationAiController],
  providers: [
    AiCreditsService,
    AiAdminService,
    AiGateway,
    KnowledgeService,
    AgentsService,
    AgentTestService,
    AgentTurnService,
    AgentToolsService,
    AgentRuntimeService,
    AgentMediaService,
    ReplySuggestionService,
    AgentReplyBus,
    AgentRuntimeJob,
    KnowledgeProcessorService,
    KnowledgeJob,
    { provide: AI_PROVIDER, useFactory: buildAiProvider, inject: [APP_CONFIG] },
    { provide: VECTOR_STORE, useFactory: () => new PgArrayVectorStore() },
  ],
  exports: [AiCreditsService, AiGateway, KnowledgeService, AgentsService, AgentTurnService, KnowledgeJob, AgentRuntimeJob, AgentRuntimeService, AgentReplyBus],
})
export class AiModule {}
