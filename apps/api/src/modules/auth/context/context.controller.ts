import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../errors';
import { AllowWhileViewingAs, PlatformOnly, SelfService, ZodValidationPipe } from '../../../http';
import type { AppLogger } from '../../../logger';
import { APP_LOGGER } from '../../../tokens';
import { AuditService } from '../../audit';
import type { AuthedRequest } from '../../../http/access.guard';
import { RequirePermission } from '../../../rbac';
import { AccessSessionsService } from './access-sessions.service';
import { contextOptionsQuerySchema, listAccessSessionsQuerySchema, switchContextSchema, viewAsSchema, type ContextOptionsQuery, type ListAccessSessionsQuery, type SwitchContextDto, type ViewAsDto } from './context.dto';
import { ContextService } from './context.service';

/**
 * Cambio de contexto (ADR-41). Son rutas «self»: cualquier sesión verificada puede PEDIR el cambio, pero el servicio decide si tiene derecho al
 * destino (membresía vigente o Súper Admin) con un 404 uniforme. Nada de lo que llega en el cuerpo concede acceso por sí mismo.
 */
@SelfService()
@Controller('context')
export class ContextController {
  constructor(
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Entrar a otra organización (`target`) o volver al origen de la sesión (`target: null`). Devuelve el contexto resultante, igual que `/auth/me`. */
  @Post('switch')
  @AllowWhileViewingAs()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  switch(@Body(new ZodValidationPipe(switchContextSchema)) b: SwitchContextDto, @Req() req: AuthedRequest & Request) {
    const p = req.principal;
    if (!p?.sessionId) throw new UnauthorizedError();
    return this.context.switch({ sessionId: p.sessionId, userId: p.userId, target: b.target, ...(req.ip ? { ip: req.ip } : {}) });
  }

  /**
   * «Ver como» (M10.5, ADR-56 B4): mirar la aplicación como otro ROL, solo lectura. `role: null` vuelve a la vista propia. Un rol que esta sesión no puede elegir ahora es 404.
   * La auditoría de la empresa se escribe DESPUÉS del cambio (otro pool): si falla, se registra sin deshacerlo (la fila de `view_as_log` ya quedó).
   */
  @Post('view-as')
  @AllowWhileViewingAs()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async viewAs(@Body(new ZodValidationPipe(viewAsSchema)) b: ViewAsDto, @Req() req: AuthedRequest & Request) {
    const p = req.principal;
    if (!p?.sessionId) throw new UnauthorizedError();
    const r = await this.context.setViewAs({ sessionId: p.sessionId, userId: p.userId, role: b.role });
    if (r.before !== r.after) {
      try {
        await this.audit.record({ entityType: 'view_as', entityId: p.sessionId, field: 'view_as', oldValue: r.before, newValue: r.after, source: 'manual' });
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo auditar «ver como»');
      }
    }
    return r.me;
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
