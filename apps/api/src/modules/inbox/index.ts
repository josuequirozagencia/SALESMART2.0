export { InboxModule } from './inbox.module';
export { OutboundJob } from './outbound.job';
export { OutboundDispatcher, backoffMs, SEND_BATCH, SEND_LEASE_MS, SEND_MAX_ATTEMPTS, type DispatchResult } from './outbound-dispatcher.service';
export { WINDOW_MS } from './inbox.access';
export type { ConversationView, MessageView } from './inbox.views';
