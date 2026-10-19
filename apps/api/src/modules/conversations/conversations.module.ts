import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { ConversationsService } from './conversations.service';

/** Conversaciones y mensajes (M5.2, ADR-50). La bandeja con sus pantallas y permisos llega en M5.4; por ahora solo recibe lo que entra por los canales. */
@Module({ imports: [ContactsModule], providers: [ConversationsService], exports: [ConversationsService] })
export class ConversationsModule {}
