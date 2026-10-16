import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { PlatformOnly, ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { catalogKey, saveCredentialsSchema, setActiveSchema, type SaveCredentialsDto, type SetActiveDto } from './providers.dto';
import { ProvidersService } from './providers.service';

const keyParam = new ZodValidationPipe(catalogKey);

/**
 * Proveedores de la plataforma (solo Súper Admin, ADR-21/ADR-42). Los ids de la ruta son claves del catálogo (servicio y proveedor), nunca una
 * organización. Ninguna respuesta incluye un valor guardado: solo si existe y sus últimos 4. `no-store`: nada de esto debe quedar en cachés.
 */
@PlatformOnly()
@RequirePermission('platform.providers.manage')
@Controller('platform/providers')
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providers: ProvidersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.providers.list();
  }

  /** Proveedor en uso de un servicio (`provider: null` lo desactiva). Solo uno con todos sus campos obligatorios. */
  @Put(':service/active')
  @Header('Cache-Control', 'no-store')
  setActive(@Param('service', keyParam) service: string, @Body(new ZodValidationPipe(setActiveSchema)) b: SetActiveDto) {
    return this.providers.setActive(service, b.provider);
  }

  /** Cambio parcial de los valores de un proveedor (todos cifrados). Devuelve su vista, solo con los últimos 4 de cada uno. */
  @Put(':service/:provider/credentials')
  @Header('Cache-Control', 'no-store')
  save(@Param('service', keyParam) service: string, @Param('provider', keyParam) provider: string, @Body(new ZodValidationPipe(saveCredentialsSchema)) b: SaveCredentialsDto) {
    return this.providers.saveCredentials(service, provider, b);
  }

  @Delete(':service/:provider/credentials')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  clear(@Param('service', keyParam) service: string, @Param('provider', keyParam) provider: string) {
    return this.providers.clearCredentials(service, provider);
  }
}
