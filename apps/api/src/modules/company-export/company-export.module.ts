import { Module } from '@nestjs/common';
import { MailModule } from '../../mail';
import { AttachmentsModule } from '../attachments';
import { AuthModule } from '../auth';
import { PlatformModule } from '../platform';
import { CompanyExportPublicController, PlatformCompanyExportController } from './company-export.controller';
import { CompanyExportJob } from './company-export.job';
import { CompanyExportService } from './company-export.service';
import { ExportPackager } from './export-packager';

/**
 * «Descargar todo» de una empresa eliminada (F3b, ADR-59 #8/#9). La parte de identidad (pedidos, enlaces, contraseña) vive en `auth` y se usa por su almacén; aquí están el armado del paquete,
 * la tarea de fondo, el servicio y las dos puertas (Consola y enlace público del dueño).
 */
@Module({
  imports: [AuthModule, AttachmentsModule, PlatformModule, MailModule],
  controllers: [PlatformCompanyExportController, CompanyExportPublicController],
  providers: [CompanyExportService, ExportPackager, CompanyExportJob],
  exports: [CompanyExportJob, ExportPackager, CompanyExportService],
})
export class CompanyExportModule {}
