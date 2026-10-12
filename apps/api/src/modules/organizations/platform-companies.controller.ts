import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { PlatformOnly, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { CompaniesService } from './companies.service';
import { assignPlanSchema, createPlanSchema, listCompaniesQuerySchema, listPlansQuerySchema, updatePlanSchema, uuidParam, type AssignPlanDto, type CreatePlanDto, type ListCompaniesQuery, type ListPlansQuery, type UpdatePlanDto } from './plans.dto';
import { PlansService } from './plans.service';

/** Catálogo de planes de la plataforma (solo Súper Admin). */
@PlatformOnly()
@RequirePermission('platform.plans.manage')
@Controller('platform/plans')
export class PlatformPlansController {
  constructor(@Inject(PlansService) private readonly plans: PlansService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listPlansQuerySchema)) q: ListPlansQuery) {
    return this.plans.list(q.include_archived === 'true');
  }

  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(createPlanSchema)) b: CreatePlanDto) {
    return this.plans.create(b);
  }

  @Patch(':id')
  update(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(updatePlanSchema)) b: UpdatePlanDto) {
    return this.plans.update(id, b);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.plans.setArchived(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.plans.setArchived(id, false);
  }
}

/** Empresas de la plataforma y asignación de plan (solo Súper Admin). */
@PlatformOnly()
@RequirePermission('platform.companies.manage')
@Controller('platform/companies')
export class PlatformCompaniesController {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listCompaniesQuerySchema)) q: ListCompaniesQuery) {
    return this.companies.list(q);
  }

  /** Asigna el plan de la empresa (o lo quita con `plan_id: null`). El id de la empresa es el de la ruta (es la empresa a administrar, no la propia). */
  @Put(':id/plan')
  assign(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(assignPlanSchema)) b: AssignPlanDto) {
    return this.companies.assignPlan(id, b.plan_id);
  }
}
