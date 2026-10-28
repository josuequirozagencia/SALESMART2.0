import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime';
import { AttachmentsModule } from '../attachments';
import { ChannelsModule } from '../channels';
import { ContactsModule } from '../contacts';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { QrModule } from '../qr';
import { QueuesModule } from '../queues';
import { QuickRepliesModule } from '../quick-replies';
import { SlaModule } from '../sla';
import { TagsModule } from '../tags';
import { TemplatesModule } from '../templates';
import { AutoCloseService } from './auto-close.service';
import { AttachmentsController, ConversationAttachmentsController } from './conversation-attachments.controller';
import { ConversationAttachmentsService } from './conversation-attachments.service';
import { InboxController, MessagesController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { OutboundDispatcher } from './outbound-dispatcher.service';
import { OutboundJob } from './outbound.job';
import { OutboundService } from './outbound.service';
import { ReassignService } from './reassign.service';
import { ScheduledMessagesJob } from './scheduled-messages.job';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { SharingService } from './sharing.service';
import { SlaSweepJob } from './sla-sweep.job';

/**
 * Inbox (M5.4, ADR-16/50): la bandeja de conversaciones, responder al cliente por WhatsApp y las notas internas. Va aparte de `conversations` (que solo recibe lo que
 * entra por los canales) porque envía por el proveedor de `channels`, que a su vez usa `conversations`: así no hay dependencias en círculo.
 */
@Module({
  imports: [AttachmentsModule, QrModule, ChannelsModule, ContactsModule, OpportunitiesModule, OrganizationsModule, QueuesModule, QuickRepliesModule, RealtimeModule, SlaModule, TagsModule, TemplatesModule],
  controllers: [InboxController, MessagesController, ConversationAttachmentsController, AttachmentsController],
  providers: [ConversationAttachmentsService, InboxService, OutboundService, SharingService, OutboundDispatcher, OutboundJob, ReassignService, AutoCloseService, SlaSweepJob, ScheduledMessagesService, ScheduledMessagesJob],
  exports: [OutboundJob, OutboundDispatcher, ReassignService, AutoCloseService, SlaSweepJob, ScheduledMessagesService, ScheduledMessagesJob],
})
export class InboxModule {}
