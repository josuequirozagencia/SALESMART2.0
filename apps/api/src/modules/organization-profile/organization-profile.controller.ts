import { Body, Controller, Get, Header, Inject, Patch, Req } from '@nestjs/common';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { updateProfileSchema, type UpdateProfileDto } from './organization-profile.dto';
import { OrganizationProfileService } from './organization-profile.service';

/** Perfil de la empresa (V25, ADR-76). La empresa sale del contexto verificado, nunca de la petición. `no-store`: datos de contacto del negocio. */
@Controller('organization')
export class OrganizationProfileController {
  constructor(@Inject(OrganizationProfileService) private readonly profiles: OrganizationProfileService) {}

  @RequirePermission('organization.read')
  @Get('profile')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest) {
    return this.profiles.get(req.principal?.permissions?.has('organization.manage') === true);
  }

  /** Cambia solo lo enviado. La moneda no se acepta aquí (400): se cambia con las reglas de ventas. */
  @RequirePermission('organization.manage')
  @Patch('profile')
  @Header('Cache-Control', 'no-store')
  update(@Body(new ZodValidationPipe(updateProfileSchema)) b: UpdateProfileDto) {
    return this.profiles.update(b);
  }
}
