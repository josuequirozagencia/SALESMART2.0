import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import {
  createFieldSchema,
  listFieldsQuerySchema,
  orderFieldsSchema,
  updateFieldSchema,
  type CreateFieldDto,
  type ListFieldsQuery,
  type OrderFieldsDto,
  type UpdateFieldDto,
} from './custom-fields.dto';
import { CustomFieldsService } from './custom-fields.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Campos personalizados (M3.2, ADR-44). Tenant: la organización sale del contexto verificado. Leer las definiciones va con `contacts.read` (el asesor
 * las necesita para dibujar el formulario de contacto); crearlas, cambiarlas, archivarlas y ordenarlas exige `custom_fields.manage`.
 * La respuesta del listado trae `access.manage` para que la web muestre u oculte acciones (cada ruta vuelve a verificar su permiso).
 */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(@Inject(CustomFieldsService) private readonly fields: CustomFieldsService) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listFieldsQuerySchema)) q: ListFieldsQuery) {
    return { ...(await this.fields.list(q)), access: { manage: req.principal?.permissions?.has('custom_fields.manage') === true } };
  }

  @RequirePermission('custom_fields.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createFieldSchema)) b: CreateFieldDto) {
    return this.fields.create(b);
  }

  /** Declarada ANTES de `:id`. */
  @RequirePermission('custom_fields.manage')
  @Put('order')
  @Header('Cache-Control', 'no-store')
  order(@Body(new ZodValidationPipe(orderFieldsSchema)) b: OrderFieldsDto) {
    return this.fields.reorder(b);
  }

  @RequirePermission('custom_fields.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateFieldSchema)) b: UpdateFieldDto) {
    return this.fields.update(id, b);
  }

  @RequirePermission('custom_fields.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  archive(@Param('id', idParam) id: string) {
    return this.fields.archive(id);
  }

  @RequirePermission('custom_fields.manage')
  @Post(':id/restore')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  restore(@Param('id', idParam) id: string) {
    return this.fields.restore(id);
  }
}
