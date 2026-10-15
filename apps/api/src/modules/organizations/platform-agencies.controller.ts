import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { PlatformOnly, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { assignAgencySchema, listAgenciesQuerySchema, type AssignAgencyDto, type ListAgenciesQuery } from './agencies.dto';
import { AgenciesService } from './agencies.service';
import { uuidParam } from './plans.dto';

/**
 * Agencias y carteras (solo Súper Admin, ADR-22). Los ids de las rutas son los de la agencia o el cliente A ADMINISTRAR (no la organización
 * del principal). Crear una agencia (con su invitación) vive en `auth`, junto a las invitaciones.
 */
@PlatformOnly()
@RequirePermission('platform.agencies.manage')
@Controller('platform')
export class PlatformAgenciesController {
  constructor(@Inject(AgenciesService) private readonly agencies: AgenciesService) {}

  @Get('agencies')
  list(@Query(new ZodValidationPipe(listAgenciesQuerySchema)) q: ListAgenciesQuery) {
    return this.agencies.list(q);
  }

  @Post('agencies/:id/suspend')
  @HttpCode(200)
  suspend(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.agencies.setSuspended(id, true);
  }

  @Post('agencies/:id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.agencies.setSuspended(id, false);
  }

  @Get('agencies/:id/history')
  history(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.agencies.history(id);
  }

  /** Cambia quién administra al cliente (`agency_id` o `null` = administración directa). Solo el Súper Admin (ADR-22). */
  @Put('organizations/:id/agency')
  assign(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(assignAgencySchema)) b: AssignAgencyDto) {
    return this.agencies.assignAgency(id, b);
  }
}
