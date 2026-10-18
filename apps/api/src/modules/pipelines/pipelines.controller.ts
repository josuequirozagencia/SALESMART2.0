import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import {
  createPipelineSchema, createStageSchema, orderSchema, updatePipelineSchema, updateStageSchema,
  type CreatePipelineDto, type CreateStageDto, type OrderDto, type UpdatePipelineDto, type UpdateStageDto,
} from './pipelines.dto';
import { PipelinesService, type PipelineScope } from './pipelines.service';

const idParam = new ZodValidationPipe(z.uuid());
const has = (req: AuthedRequest, k: 'contacts.view_all' | 'pipelines.manage' | 'opportunities.write'): boolean => req.principal?.permissions?.has(k) === true;
/** El alcance sale de los permisos VERIFICADOS del principal (nunca de la petición). */
const scopeOf = (req: AuthedRequest): PipelineScope => ({ viewAll: has(req, 'contacts.view_all') });

/**
 * Pipelines y etapas (M4.1, ADR-49). Ver: `opportunities.read`; configurar (crear, renombrar, ordenar, ocultar, eliminar): `pipelines.manage` (el administrador).
 * `no-store`: son datos de negocio y no deben quedar en cachés. El listado trae también las etapas ocultas y `access` para que la web muestre u oculte botones.
 */
@Controller('pipelines')
export class PipelinesController {
  constructor(@Inject(PipelinesService) private readonly pipelines: PipelinesService) {}

  @RequirePermission('opportunities.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest) {
    return { ...(await this.pipelines.list(scopeOf(req))), access: { manage: has(req, 'pipelines.manage'), write: has(req, 'opportunities.write') } };
  }

  @RequirePermission('pipelines.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createPipelineSchema)) b: CreatePipelineDto) {
    return this.pipelines.create(scopeOf(req), b);
  }

  /** Declarada ANTES de `:id`. */
  @RequirePermission('pipelines.manage')
  @Put('order')
  @Header('Cache-Control', 'no-store')
  reorder(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(orderSchema)) b: OrderDto) {
    return this.pipelines.reorder(scopeOf(req), b);
  }

  @RequirePermission('pipelines.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updatePipelineSchema)) b: UpdatePipelineDto) {
    return this.pipelines.update(scopeOf(req), id, b);
  }

  @RequirePermission('pipelines.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.pipelines.remove(id);
  }

  @RequirePermission('pipelines.manage')
  @Post(':id/stages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  createStage(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(createStageSchema)) b: CreateStageDto) {
    return this.pipelines.createStage(scopeOf(req), id, b);
  }

  @RequirePermission('pipelines.manage')
  @Put(':id/stages/order')
  @Header('Cache-Control', 'no-store')
  reorderStages(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(orderSchema)) b: OrderDto) {
    return this.pipelines.reorderStages(scopeOf(req), id, b);
  }
}

/** Una etapa por su id. */
@Controller('pipeline-stages')
export class PipelineStagesController {
  constructor(@Inject(PipelinesService) private readonly pipelines: PipelinesService) {}

  @RequirePermission('pipelines.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateStageSchema)) b: UpdateStageDto) {
    return this.pipelines.updateStage(scopeOf(req), id, b);
  }

  @RequirePermission('pipelines.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.pipelines.removeStage(scopeOf(req), id);
  }
}
