import { Body, Controller, Get, Header, Inject, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { setFollowUpsSchema, type SetFollowUpsDto } from './follow-ups.dto';
import { FollowUpsService } from './follow-ups.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Seguimientos automáticos de un agente (v11 S5, ADR-68): ver y guardar la secuencia del escenario «El contacto dejó de responder». Solo el administrador (`agents.manage`). Un agente que no existe
 * o es de otra empresa responde 404 igual que lo inexistente. `no-store`.
 */
@RequirePermission('agents.manage')
@Controller('agents')
export class FollowUpsController {
  constructor(@Inject(FollowUpsService) private readonly followUps: FollowUpsService) {}

  @Get(':id/follow-ups')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string) {
    return this.followUps.get(id);
  }

  @Put(':id/follow-ups')
  @Header('Cache-Control', 'no-store')
  set(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setFollowUpsSchema)) body: SetFollowUpsDto) {
    return this.followUps.set(id, body);
  }
}
