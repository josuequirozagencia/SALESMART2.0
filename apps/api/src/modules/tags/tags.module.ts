import { Module } from '@nestjs/common';
import { SystemTagsService } from './system-tags.service';
import { TagsController } from './tags.controller';

/** Etiquetas del sistema (M3.3, ADR-45). `SystemTagsService` lo usan los módulos que originan los hechos (atribución hoy; citas y ventas en M6). */
@Module({ controllers: [TagsController], providers: [SystemTagsService], exports: [SystemTagsService] })
export class TagsModule {}
