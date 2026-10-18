import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import {
  createOpportunitySchema, listOpportunitiesQuerySchema, moveOpportunitySchema, summaryQuerySchema, updateOpportunitySchema,
  type CreateOpportunityDto, type ListOpportunitiesQuery, type MoveOpportunityDto, type SummaryQuery, type UpdateOpportunityDto,
} from './opportunities.dto';
import { OpportunitiesService } from './opportunities.service';

const idParam = new ZodValidationPipe(z.uuid());
const has = (req: AuthedRequest, k: 'contacts.view_all' | 'opportunities.write'): boolean => req.principal?.permissions?.has(k) === true;
/** El alcance sale de los permisos VERIFICADOS del principal (nunca de la petición): sin `contacts.view_all` solo se ven y tocan las oportunidades propias. */
const scopeOf = (req: AuthedRequest) => ({ viewAll: has(req, 'contacts.view_all') });

/**
 * Oportunidades (M4.2, ADR-49). Ver: `opportunities.read`; crear, editar, mover y borrar: `opportunities.write` (el asesor, solo las suyas). `no-store`: son datos
 * de negocio con datos personales del contacto y no deben quedar en cachés.
 */
@Controller('opportunities')
export class OpportunitiesController {
  constructor(@Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService) {}

  @RequirePermission('opportunities.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listOpportunitiesQuerySchema)) q: ListOpportunitiesQuery) {
    return { ...(await this.opportunities.list(scopeOf(req), q)), access: { write: has(req, 'opportunities.write'), view_all: has(req, 'contacts.view_all') } };
  }

  @RequirePermission('opportunities.write')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createOpportunitySchema)) b: CreateOpportunityDto) {
    return this.opportunities.create(scopeOf(req), b);
  }

  @RequirePermission('opportunities.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.opportunities.get(scopeOf(req), id);
  }

  @RequirePermission('opportunities.write')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateOpportunitySchema)) b: UpdateOpportunityDto) {
    return this.opportunities.update(scopeOf(req), id, b);
  }

  @RequirePermission('opportunities.write')
  @Post(':id/move')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  move(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(moveOpportunitySchema)) b: MoveOpportunityDto) {
    return this.opportunities.move(scopeOf(req), id, b);
  }

  /** Borrado lógico. */
  @RequirePermission('opportunities.write')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.opportunities.remove(scopeOf(req), id);
  }
}

/** Resumen por etapa de un pipeline (cuántas oportunidades y cuánto valen), con los filtros del tablero. */
@Controller('pipelines')
export class PipelineSummaryController {
  constructor(@Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService) {}

  @RequirePermission('opportunities.read')
  @Get(':id/summary')
  @Header('Cache-Control', 'no-store')
  summary(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Query(new ZodValidationPipe(summaryQuerySchema)) q: SummaryQuery) {
    return this.opportunities.summary(scopeOf(req), id, q);
  }
}
