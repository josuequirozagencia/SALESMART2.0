import { Module } from '@nestjs/common';
import { MailModule } from '../../mail';
import { AttachmentsModule } from '../attachments';
import { AuthModule } from '../auth';
import { PlatformModule } from '../platform';
import { QrModule } from '../qr';
import { CompanyPurgeJob } from './company-purge.job';
import { CompanyPurgeService } from './company-purge.service';

/**
 * Borrado definitivo de las empresas eliminadas (F3c, ADR-59 #10–12): la tarea de fondo y el servicio que cierra Evolution, vacía el almacenamiento y llama a las dos funciones de borrado. La parte de identidad
 * (qué empresa toca, las funciones SECURITY DEFINER) vive en `auth` y se usa por su almacén. Sin rutas: el borrado nadie lo pide, lo dispara el vencimiento del plazo.
 */
@Module({
  imports: [AuthModule, AttachmentsModule, QrModule, PlatformModule, MailModule],
  providers: [CompanyPurgeService, CompanyPurgeJob],
  exports: [CompanyPurgeJob, CompanyPurgeService],
})
export class CompanyPurgeModule {}
