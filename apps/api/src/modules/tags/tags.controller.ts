import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { SystemTagsService } from './system-tags.service';
import { createTagSchema, updateTagSchema, type CreateTagDto, type UpdateTagDto } from './tags.dto';
import { TagsService } from './tags.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Etiquetas (M3.3/M3.4, ADR-45/46). Leer va con `contacts.read` (la respuesta trae `access.manage` para la interfaz). Las del SISTEMA las pone el sistema y no
 * hay ruta para ponerlas, quitarlas ni borrarlas; las PERSONALIZADAS las administra `tags.manage` y se ponen a los contactos al crearlos o editarlos.
 */
@Controller('tags')
export class TagsController {
  constructor(
    @Inject(SystemTagsService) private readonly system: SystemTagsService,
    @Inject(TagsService) private readonly tags: TagsService,
  ) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest) {
    return { ...(await this.system.list()), access: { manage: req.principal?.permissions?.has('tags.manage') === true } };
  }

  @RequirePermission('tags.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createTagSchema)) b: CreateTagDto) {
    return this.tags.create(b);
  }

  @RequirePermission('tags.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateTagSchema)) b: UpdateTagDto) {
    return this.tags.update(id, b);
  }

  @RequirePermission('tags.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.tags.remove(id);
  }
}
