import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { QueuesModule } from '../queues';
import { SlaModule } from '../sla';
import { TagsModule } from '../tags';
import { AutoMessagesService } from './auto-messages.service';
import { ConversationsService } from './conversations.service';

/** Conversaciones y mensajes (M5.2, ADR-50). La bandeja con sus pantallas y permisos llega en M5.4; por ahora solo recibe lo que entra por los canales. */
@Module({ imports: [ContactsModule, QueuesModule, SlaModule, TagsModule], providers: [AutoMessagesService, ConversationsService], exports: [ConversationsService] })
export class ConversationsModule {}
