import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations';
import { RealtimeModule } from '../realtime';
import { TemplatesModule } from '../templates';
import { OutreachService } from './outreach.service';

/** Mensajes automáticos que salen de una regla del sistema (formularios y automatizaciones). */
@Module({ imports: [ConversationsModule, RealtimeModule, TemplatesModule], providers: [OutreachService], exports: [OutreachService] })
export class OutreachModule {}
