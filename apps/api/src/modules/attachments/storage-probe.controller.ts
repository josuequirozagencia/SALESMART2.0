import { Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { PlatformOnly } from '../../http';
import { RequirePermission } from '../../rbac';
import { probeStorage, type ProbeResult } from './storage-probe';
import { StorageGateway } from './storage.gateway';

/**
 * «Probar conexión» del almacenamiento en uso (solo Súper Admin, ADR-42). No recibe nada: prueba lo que está guardado y en uso en Proveedores. `no-store`.
 */
@PlatformOnly()
@RequirePermission('platform.providers.manage')
@Controller('platform/providers/storage')
export class StorageProbeController {
  constructor(@Inject(StorageGateway) private readonly storage: StorageGateway) {}

  @Post('test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test(): Promise<ProbeResult> {
    return probeStorage(this.storage);
  }
}
