import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { createQueueSchema, setMembersSchema, simulateSchema, updateQueueSchema, type CreateQueueDto, type SetMembersDto, type SimulateDto, type UpdateQueueDto } from './queues.dto';
import { QueuesService } from './queues.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Colas y reparto (M5.3, ADR-07/ADR-50). Todo exige `queues.manage` (el administrador de la empresa). `no-store`: describe el equipo y la carga de cada asesor.
 */
@Controller('queues')
export class QueuesController {
  constructor(@Inject(QueuesService) private readonly queues: QueuesService) {}

  @RequirePermission('queues.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.queues.list();
  }

  @RequirePermission('queues.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createQueueSchema)) b: CreateQueueDto) {
    return this.queues.create(b);
  }

  @RequirePermission('queues.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateQueueSchema)) b: UpdateQueueDto) {
    return this.queues.update(id, b);
  }

  /** Quién participa en la cola y con qué peso (reemplaza la configuración de las personas listadas; quien no aparece queda apagado). */
  @RequirePermission('queues.manage')
  @Put(':id/members')
  @Header('Cache-Control', 'no-store')
  setMembers(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setMembersSchema)) b: SetMembersDto) {
    return this.queues.setMembers(id, b);
  }

  /** Archiva la cola. */
  @RequirePermission('queues.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  archive(@Param('id', idParam) id: string) {
    return this.queues.archive(id);
  }

  /** Simula el reparto (sin guardar nada); el cuerpo puede traer cambios por probar. */
  @RequirePermission('queues.manage')
  @Post(':id/simulate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  simulate(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(simulateSchema)) b: SimulateDto) {
    return this.queues.simulate(id, b);
  }

  /** Reparte ahora las conversaciones «sin asignar» de la cola. */
  @RequirePermission('queues.manage')
  @Post(':id/distribute')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  distribute(@Param('id', idParam) id: string) {
    return this.queues.distributeUnassigned(id);
  }
}
