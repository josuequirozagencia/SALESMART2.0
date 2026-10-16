import { Controller, Get, Header, Inject } from '@nestjs/common';
import { RequirePermission } from '../../rbac';
import { SystemTagsService } from './system-tags.service';

/**
 * Etiquetas (M3.3, ADR-45). Solo lectura: las del SISTEMA las pone el sistema y no hay ruta para ponerlas, quitarlas ni borrarlas.
 * Crear etiquetas personalizadas y ponerlas a mano llega en M3.4.
 */
@Controller('tags')
export class TagsController {
  constructor(@Inject(SystemTagsService) private readonly tags: SystemTagsService) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.tags.list();
  }
}
