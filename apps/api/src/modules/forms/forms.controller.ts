import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { createFormSchema, setFieldsSchema, submissionsQuerySchema, updateFormSchema, type CreateFormDto, type SetFieldsDto, type SubmissionsQuery, type UpdateFormDto } from './forms.dto';
import { FormsService } from './forms.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Formularios embebibles de la empresa (M9.1, ADR-09/54; F07): armarlos, publicarlos o pausarlos y ver lo recibido. Solo quien administra formularios (`forms.manage`). `no-store`: llevan datos de
 * personas que llenaron el formulario.
 */
@RequirePermission('forms.manage')
@Controller('forms')
export class FormsController {
  constructor(@Inject(FormsService) private readonly forms: FormsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.forms.list();
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createFormSchema)) b: CreateFormDto) {
    return this.forms.create(b);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string) {
    return this.forms.get(id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateFormSchema)) b: UpdateFormDto) {
    return this.forms.update(id, b);
  }

  @Put(':id/fields')
  @Header('Cache-Control', 'no-store')
  setFields(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setFieldsSchema)) b: SetFieldsDto) {
    return this.forms.setFields(id, b);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  publish(@Param('id', idParam) id: string) {
    return this.forms.publish(id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  pause(@Param('id', idParam) id: string) {
    return this.forms.pause(id);
  }

  @Get(':id/submissions')
  @Header('Cache-Control', 'no-store')
  submissions(@Param('id', idParam) id: string, @Query(new ZodValidationPipe(submissionsQuerySchema)) q: SubmissionsQuery) {
    return this.forms.submissions(id, q);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.forms.remove(id);
  }
}
