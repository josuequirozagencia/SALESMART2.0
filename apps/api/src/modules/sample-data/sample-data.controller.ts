import { Controller, Get, Header, Inject } from '@nestjs/common';
import { RequirePermission } from '../../rbac';
import { OnboardingService } from './onboarding.service';
import { SampleDataService } from './sample-data.service';

/**
 * «Primeros pasos» (M10.6, ADR-56 B5). Solo quien administra la empresa (`users.manage`). Abrirlo también completa los datos de ejemplo si faltaran (idempotente): es el
 * reintento «en el siguiente acceso del administrador» cuando la creación después del alta falló.
 */
@Controller('onboarding')
@RequirePermission('users.manage')
export class SampleDataController {
  constructor(
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(SampleDataService) private readonly samples: SampleDataService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get() {
    await this.samples.ensure().catch(() => undefined); // un fallo aquí no impide mostrar los pasos; ya quedó registrado
    return this.onboarding.view();
  }
}
