import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { AutomationDryRunService } from './automation-dry-run.service';
import { AutomationSettingsService } from './automation-settings.service';
import { createAutomationSchema, runsQuerySchema, testAutomationSchema, updateAutomationSchema, updateSettingsSchema, type CreateAutomationDto, type RunsQuery, type TestAutomationDto, type UpdateAutomationDto, type UpdateSettingsDto } from './automations.dto';
import { AutomationsService } from './automations.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Automatizaciones de la empresa (M9.3, ADR-54; F20): armarlas, activarlas o pausarlas y ver sus ejecuciones. Solo quien administra automatizaciones (`automations.manage`). */
@RequirePermission('automations.manage')
@Controller('automations')
export class AutomationsController {
  constructor(
    @Inject(AutomationsService) private readonly automations: AutomationsService,
    @Inject(AutomationDryRunService) private readonly dryRun: AutomationDryRunService,
    @Inject(AutomationSettingsService) private readonly settings: AutomationSettingsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.automations.list();
  }

  /** Ajustes de las automatizaciones: la lista de dominios a los que pueden llamar. Va ANTES de `:id`. */
  @Get('settings')
  @Header('Cache-Control', 'no-store')
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @Header('Cache-Control', 'no-store')
  putSettings(@Body(new ZodValidationPipe(updateSettingsSchema)) b: UpdateSettingsDto) {
    return this.settings.update(b);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createAutomationSchema)) b: CreateAutomationDto) {
    return this.automations.create(b);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string) {
    return this.automations.get(id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateAutomationSchema)) b: UpdateAutomationDto) {
    return this.automations.update(id, b);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  activate(@Param('id', idParam) id: string) {
    return this.automations.activate(id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  pause(@Param('id', idParam) id: string) {
    return this.automations.pause(id);
  }

  /** Prueba en seco: qué haría la regla con este contacto, sin escribir nada. */
  @Post(':id/test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(testAutomationSchema)) b: TestAutomationDto) {
    return this.dryRun.test(id, b.contact_id);
  }

  @Get(':id/runs')
  @Header('Cache-Control', 'no-store')
  runs(@Param('id', idParam) id: string, @Query(new ZodValidationPipe(runsQuerySchema)) q: RunsQuery) {
    return this.automations.runs(id, q);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.automations.remove(id);
  }
}
