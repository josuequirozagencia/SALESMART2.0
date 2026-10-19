import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels';
import { ContactsModule } from '../contacts';
import { OpportunitiesModule } from '../opportunities';
import { OrganizationsModule } from '../organizations';
import { QueuesModule } from '../queues';
import { SlaModule } from '../sla';
import { TagsModule } from '../tags';
import { InboxController, MessagesController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { OutboundDispatcher } from './outbound-dispatcher.service';
import { OutboundJob } from './outbound.job';
import { OutboundService } from './outbound.service';
import { ReassignService } from './reassign.service';
import { SharingService } from './sharing.service';
import { SlaSweepJob } from './sla-sweep.job';

/**
 * Inbox (M5.4, ADR-16/50): la bandeja de conversaciones, responder al cliente por WhatsApp y las notas internas. Va aparte de `conversations` (que solo recibe lo que
 * entra por los canales) porque envía por el proveedor de `channels`, que a su vez usa `conversations`: así no hay dependencias en círculo.
 */
@Module({
  imports: [ChannelsModule, ContactsModule, OpportunitiesModule, OrganizationsModule, QueuesModule, SlaModule, TagsModule],
  controllers: [InboxController, MessagesController],
  providers: [InboxService, OutboundService, SharingService, OutboundDispatcher, OutboundJob, ReassignService, SlaSweepJob],
  exports: [OutboundJob, OutboundDispatcher, ReassignService, SlaSweepJob],
})
export class InboxModule {}
