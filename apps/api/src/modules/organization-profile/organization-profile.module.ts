import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { OrganizationProfileController } from './organization-profile.controller';
import { OrganizationProfileService } from './organization-profile.service';

/** Perfil de la empresa (V25, ADR-76). Módulo aparte: usa la identidad de `organizations` y la regla de la moneda de `sales` sin crear dependencias en círculo. */
@Module({
  imports: [OrganizationsModule],
  controllers: [OrganizationProfileController],
  providers: [OrganizationProfileService],
})
export class OrganizationProfileModule {}
