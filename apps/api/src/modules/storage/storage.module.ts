import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { StorageAdminService } from './storage-admin.service';
import { StorageQuotaService } from './storage-quota.service';
import { StorageRequestsService } from './storage-requests.service';
import { StorageClientController, StoragePlatformController } from './storage.controller';

/** Espacio extra de la biblioteca de archivos (V21b, ADR-75): cupo derivado, planes, solicitudes y concesiones. El cobro es manual. */
@Module({
  imports: [OrganizationsModule, PlatformModule],
  controllers: [StorageClientController, StoragePlatformController],
  providers: [StorageQuotaService, StorageRequestsService, StorageAdminService],
  exports: [StorageQuotaService, StorageRequestsService],
})
export class StorageModule {}
