import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { createImportSchema, patchImportSchema, stageRowsSchema, startImportSchema, type CreateImportDto, type PatchImportDto, type StageRowsDto, type StartImportDto } from './contact-imports.dto';
import { ContactImportsService } from './contact-imports.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Importación de contactos desde CSV (M3.5, ADR-47). Solo `contacts.import` (el administrador). El navegador lee el archivo y sube las filas por lotes; el
 * servidor nunca recibe el archivo. Flujo: crear → subir filas → vista previa → (opciones) → empezar → procesar lotes hasta terminar → reporte.
 */
@Controller('contact-imports')
export class ContactImportsController {
  constructor(@Inject(ContactImportsService) private readonly imports: ContactImportsService) {}

  @RequirePermission('contacts.import')
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.imports.list();
  }

  @RequirePermission('contacts.import')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createImportSchema)) b: CreateImportDto) {
    return this.imports.create(b);
  }

  @RequirePermission('contacts.import')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Param('id', idParam) id: string) {
    return this.imports.get(id);
  }

  @RequirePermission('contacts.import')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  patch(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(patchImportSchema)) b: PatchImportDto) {
    return this.imports.patch(id, b);
  }

  @RequirePermission('contacts.import')
  @Post(':id/rows')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  rows(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(stageRowsSchema)) b: StageRowsDto) {
    return this.imports.stage(id, b);
  }

  @RequirePermission('contacts.import')
  @Get(':id/preview')
  @Header('Cache-Control', 'no-store')
  preview(@Param('id', idParam) id: string) {
    return this.imports.preview(id);
  }

  @RequirePermission('contacts.import')
  @Post(':id/start')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  start(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(startImportSchema)) b: StartImportDto) {
    return this.imports.start(id, b);
  }

  @RequirePermission('contacts.import')
  @Post(':id/process')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  process(@Param('id', idParam) id: string) {
    return this.imports.process(id);
  }

  @RequirePermission('contacts.import')
  @Post(':id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Param('id', idParam) id: string) {
    return this.imports.cancel(id);
  }

  /** Filas rechazadas y omitidas, tal como venían, con su motivo. */
  @RequirePermission('contacts.import')
  @Get(':id/report')
  @Header('Cache-Control', 'no-store')
  async report(@Param('id', idParam) id: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    const r = await this.imports.report(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    return r.csv;
  }
}
