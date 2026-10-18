import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { createChannelSchema, updateChannelSchema, type CreateChannelDto, type UpdateChannelDto } from './channels.dto';
import { ConnectionsService } from './connections.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Conexiones de canales (M5.1, ADR-50). Todo exige `channels.manage` (el administrador de la empresa). `no-store`: las respuestas describen la configuración de
 * mensajería de la empresa. El token se recibe al crear o rotar y NO vuelve a salir: solo los últimos 4 caracteres.
 */
@Controller('channels')
export class ChannelsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @RequirePermission('channels.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.connections.list();
  }

  @RequirePermission('channels.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createChannelSchema)) b: CreateChannelDto) {
    return this.connections.create(b);
  }

  @RequirePermission('channels.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateChannelSchema)) b: UpdateChannelDto) {
    return this.connections.update(id, b);
  }

  /** Vuelve a comprobar el número con el proveedor. */
  @RequirePermission('channels.manage')
  @Post(':id/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  check(@Param('id', idParam) id: string) {
    return this.connections.check(id);
  }

  /** Desconecta (borrado lógico) y libera el número. */
  @RequirePermission('channels.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.connections.remove(id);
  }
}
