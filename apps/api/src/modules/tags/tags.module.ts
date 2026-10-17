import { Module } from '@nestjs/common';
import { ContactTaggingService } from './contact-tagging.service';
import { SystemTagsService } from './system-tags.service';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

/** Etiquetas (M3.3/M3.4). `SystemTagsService` lo usan los módulos que originan los hechos; `ContactTaggingService`, el módulo de contactos. */
@Module({ controllers: [TagsController], providers: [SystemTagsService, TagsService, ContactTaggingService], exports: [SystemTagsService, ContactTaggingService] })
export class TagsModule {}
