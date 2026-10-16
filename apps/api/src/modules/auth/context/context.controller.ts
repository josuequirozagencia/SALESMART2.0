import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../errors';
import { PlatformOnly, SelfService, ZodValidationPipe } from '../../../http';
import type { AuthedRequest } from '../../../http/access.guard';
import { RequirePermission } from '../../../rbac';
import { AccessSessionsService } from './access-sessions.service';
import { contextOptionsQuerySchema, listAccessSessionsQuerySchema, switchContextSchema, type ContextOptionsQuery, type ListAccessSessionsQuery, type SwitchContextDto } from './context.dto';
import { ContextService } from './context.service';

/**
 * Cambio de contexto (ADR-41). Son rutas «self»: cualquier sesión verificada puede PEDIR el cambio, pero el servicio decide si tiene derecho al
 * destino (membresía vigente o Súper Admin) con un 404 uniforme. Nada de lo que llega en el cuerpo concede acceso por sí mismo.
 */
@SelfService()
@Controller('context')
export class ContextController {
  constructor(@Inject(ContextService) private readonly context: ContextService) {}

  /** Entrar a otra organización (`target`) o volver al origen de la sesión (`target: null`). Devuelve el contexto resultante, igual que `/auth/me`. */
  @Post('switch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  switch(@Body(new ZodValidationPipe(switchContextSchema)) b: SwitchContextDto, @Req() req: AuthedRequest & Request) {
    const p = req.principal;
    if (!p?.sessionId) throw new UnauthorizedError();
    return this.context.switch({ sessionId: p.sessionId, userId: p.userId, target: b.target, ...(req.ip ? { ip: req.ip } : {}) });
  }

  /** Clientes a los que puede entrar con una membresía vigente (el selector del banner). */
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Query(new ZodValidationPipe(contextOptionsQuerySchema)) q: ContextOptionsQuery, @Req() req: AuthedRequest) {
    const sessionId = req.principal?.sessionId;
    if (!sessionId) throw new UnauthorizedError();
    return this.context.options(sessionId, q.q);
  }
}

/** Historial de accesos: SOLO Súper Admin (ADR-22: ni la agencia ni el cliente lo ven). */
@PlatformOnly()
@RequirePermission('platform.access_log.read')
@Controller('platform/access-sessions')
export class PlatformAccessSessionsController {
  constructor(@Inject(AccessSessionsService) private readonly access: AccessSessionsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(listAccessSessionsQuerySchema)) q: ListAccessSessionsQuery) {
    return this.access.list(q);
  }
}
