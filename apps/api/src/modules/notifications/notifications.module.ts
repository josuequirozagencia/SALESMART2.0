import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Centro de avisos dentro de la aplicación (F1, ADR-57): hoy solo menciones en notas; lo usarán más productores (tareas recurrentes, F2). */
@Module({ imports: [OrganizationsModule], controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
