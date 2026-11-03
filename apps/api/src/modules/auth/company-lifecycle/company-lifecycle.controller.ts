import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { PlatformOnly, ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { deleteCompanySchema, recoverCompanySchema, uuidParam, type DeleteCompanyDto, type RecoverCompanyDto } from './company-lifecycle.dto';
import { CompanyLifecycleService } from './company-lifecycle.service';

/**
 * Eliminar y recuperar empresas (F3a, ADR-59). Solo el Súper Admin. El id de la ruta es el de la empresa a administrar (no el de la propia organización del principal).
 * `no-store`: la respuesta describe una operación destructiva y no debe quedar en cachés.
 */
@PlatformOnly()
@RequirePermission('platform.companies.delete')
@Controller('platform/companies')
export class PlatformCompanyLifecycleController {
  constructor(@Inject(CompanyLifecycleService) private readonly lifecycle: CompanyLifecycleService) {}

  @Get(':id/deletion-preview')
  @Header('Cache-Control', 'no-store')
  preview(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.lifecycle.preview(id);
  }

  @Post(':id/delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  delete(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(deleteCompanySchema)) b: DeleteCompanyDto) {
    return this.lifecycle.delete(id, b);
  }

  @Post(':id/recover')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  recover(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(recoverCompanySchema)) b: RecoverCompanyDto) {
    return this.lifecycle.recover(id, b);
  }
}
