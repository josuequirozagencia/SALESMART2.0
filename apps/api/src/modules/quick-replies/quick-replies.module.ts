import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';

/** Respuestas rápidas con variables (M5.6b, ADR-50). El Inbox las resuelve para el contacto de cada conversación. */
@Module({ imports: [CustomFieldsModule], controllers: [QuickRepliesController], providers: [QuickRepliesService], exports: [QuickRepliesService] })
export class QuickRepliesModule {}
