import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { holidaySchema, hoursSchema, policySchema, type HolidayDto, type HoursDto, type PolicyDto } from './sla.dto';
import { SlaConfigService } from './sla-config.service';

/**
 * SLA, horario laboral y feriados de la empresa (M5.5b, ADR-50). Todo exige `sla.manage` (el administrador de la empresa; una agencia con nivel «administrador» también).
 * `no-store`: es configuración que cambia el comportamiento de la bandeja.
 */
@Controller('sla')
export class SlaController {
  constructor(@Inject(SlaConfigService) private readonly config: SlaConfigService) {}

  @RequirePermission('sla.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  get() {
    return this.config.get();
  }

  /** Objetivo de respuesta y aviso de riesgo, en minutos de tiempo abierto. */
  @RequirePermission('sla.manage')
  @Put('policy')
  @Header('Cache-Control', 'no-store')
  policy(@Body(new ZodValidationPipe(policySchema)) b: PolicyDto) {
    return this.config.setPolicy(b);
  }

  /** Horario laboral de la empresa; `days: null` la deja abierta siempre. */
  @RequirePermission('sla.manage')
  @Put('hours')
  @Header('Cache-Control', 'no-store')
  hours(@Body(new ZodValidationPipe(hoursSchema)) b: HoursDto) {
    return this.config.setHours(b);
  }

  @RequirePermission('sla.manage')
  @Post('holidays')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  addHoliday(@Body(new ZodValidationPipe(holidaySchema)) b: HolidayDto) {
    return this.config.addHoliday(b);
  }

  @RequirePermission('sla.manage')
  @Delete('holidays/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  removeHoliday(@Param('id', new ZodValidationPipe(z.uuid())) id: string) {
    return this.config.removeHoliday(id);
  }
}
