import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { eventsQuerySchema, saveSettingsSchema, type EventsQuery, type SaveSettingsDto } from './meta-settings.dto';
import { MetaSettingsService } from './meta-settings.service';

/** Conexión de la empresa con la API de Conversiones de Meta y panel de eventos (M6.4, ADR-45/51). Solo quien administra integraciones; `no-store`: son credenciales y datos de clientes. */
@Controller('meta')
export class MetaSettingsController {
  constructor(@Inject(MetaSettingsService) private readonly meta: MetaSettingsService) {}

  @RequirePermission('integrations.manage')
  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings() {
    return this.meta.get();
  }

  @RequirePermission('integrations.manage')
  @Put('settings')
  @Header('Cache-Control', 'no-store')
  save(@Body(new ZodValidationPipe(saveSettingsSchema)) b: SaveSettingsDto) {
    return this.meta.save(b);
  }

  /** «Probar conexión»: vuelve a comprobar con Meta el dataset y el token guardados. */
  @RequirePermission('integrations.manage')
  @Post('settings/test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test() {
    return this.meta.test();
  }

  @RequirePermission('integrations.manage')
  @Get('events')
  @Header('Cache-Control', 'no-store')
  events(@Query(new ZodValidationPipe(eventsQuerySchema)) q: EventsQuery) {
    return this.meta.events(q);
  }

  @RequirePermission('integrations.manage')
  @Post('events/:id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retry(@Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    return this.meta.retry(id);
  }
}
