import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { eventsQuerySchema, messagingDatasetSchema, saveSettingsSchema, type EventsQuery, type MessagingDatasetDto, type SaveSettingsDto } from './meta-settings.dto';
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

  /** «Crear o recuperar el dataset de mensajes» de la cuenta de WhatsApp Business (V20): lo pide a Meta con el token guardado y lo guarda. */
  @RequirePermission('integrations.manage')
  @Post('messaging-dataset')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  messagingDataset(@Body(new ZodValidationPipe(messagingDatasetSchema)) b: MessagingDatasetDto) {
    return this.meta.ensureMessagingDataset(b.waba_id);
  }

  /** Vuelve a poner en cola los fallidos y bloqueados que aún acepta Meta; los de más de 7 días pasan a «vencido». */
  @RequirePermission('integrations.manage')
  @Post('events/retry-all')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retryAll() {
    return this.meta.retryAll();
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
