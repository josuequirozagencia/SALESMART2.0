export { ConversationsModule } from './conversations.module';
export { AutoMessagesService, AUTO_MESSAGE_MAX_AGE_MS, type AutoMessageKind } from './auto-messages.service';
export { ConversationsService, type IngestResult, type StatusResult, type ReactionResult } from './conversations.service';
export type { InboundKind, NormalizedMedia, NormalizedMessage, DeliveryState, NormalizedStatus, NormalizedReaction, NormalizedInboundEvent } from './normalized';
