import { Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { ConnectionHealthService } from './connection-health.service';

/**
 * Salud de las conexiones (v19 B1): lo ve y lo reintenta quien administra las conexiones (`channels.manage`). Solo cifras y motivos fijos; ni teléfonos ni textos de clientes. Todo `no-store`.
 * Prefijo propio (`connection-health`) para no chocar con las rutas `channels/:id`.
 */
@Controller('connection-health')
export class ConnectionHealthController {
  constructor(@Inject(ConnectionHealthService) private readonly health: ConnectionHealthService) {}

  @RequirePermission('channels.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.health.list();
  }

  /** Vuelve a poner en cola un aviso fallido (si su contenido sigue guardado). Queda auditado. */
  @RequirePermission('channels.manage')
  @Post('events/:id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retry(@Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    return this.health.retry(id);
  }
}
