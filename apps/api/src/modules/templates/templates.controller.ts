import { Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { TemplatesService } from './templates.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Plantillas de WhatsApp de una conexión (M5.6a, ADR-50): lo que ve y sincroniza el administrador en Configuración › Conexiones. El selector de una conversación usa
 * `GET /conversations/:id/templates` (con el permiso de responder). `no-store`: describe la mensajería de la empresa.
 */
@Controller('channels/:id/templates')
export class TemplatesController {
  constructor(@Inject(TemplatesService) private readonly templates: TemplatesService) {}

  @RequirePermission('channels.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('id', idParam) id: string) {
    return this.templates.list(id);
  }

  /** Vuelve a pedirle a Meta las plantillas de la conexión. */
  @RequirePermission('channels.manage')
  @Post('sync')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  sync(@Param('id', idParam) id: string) {
    return this.templates.sync(id);
  }
}
