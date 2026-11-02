import { Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { listNotificationsQuerySchema, type ListNotificationsQuery } from './notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * Centro de avisos (F1, ADR-57). Tenant: la empresa y la persona salen del contexto verificado, nunca de la petición. Cada quien ve y marca SOLO los suyos (los ajenos responden 404). Ver exige
 * `notifications.read` (entra en el techo de solo lectura); marcar leído, `notifications.write` (en «Ver como» o con acceso de solo lectura no se puede). `no-store`: llevan extractos de notas.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @RequirePermission('notifications.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listNotificationsQuerySchema)) q: ListNotificationsQuery) {
    return this.notifications.list({ viewAll: req.principal?.permissions?.has('inbox.view_all') === true }, q);
  }

  /** Declarada ANTES de `:id/read` para que «read-all» no se tome por un id. */
  @RequirePermission('notifications.write')
  @Post('read-all')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  readAll() {
    return this.notifications.markAllRead();
  }

  @RequirePermission('notifications.write')
  @Post(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  read(@Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    return this.notifications.markRead(id);
  }
}
