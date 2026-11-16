import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PlatformOnly, ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { accessResetSchema, listAccessResetsQuerySchema, type AccessResetDto, type ListAccessResetsQuery } from './access-reset.dto';
import { AccessResetService } from './access-reset.service';

const idParam = new ZodValidationPipe(z.uuid());

/**
 * Restablecer el acceso de una persona de la EMPRESA del contexto (ADR-71): el administrador del cliente y la agencia con nivel `admin` (su permiso sale del nivel por cliente) que está «administrando» a ese cliente.
 * La persona de la ruta es siempre de la empresa del contexto: la de otra empresa o inexistente es el mismo 404. `no-store`: nada de esto debe quedar en cachés.
 */
@Controller('users')
export class AccessResetController {
  constructor(@Inject(AccessResetService) private readonly reset: AccessResetService) {}

  /** ¿Se puede restablecer a esta persona desde aquí? `{ allowed }`, sin explicar por qué no (la pantalla solo decide si muestra el botón). */
  @Get(':userId/reset-access')
  @RequirePermission('users.reset_access')
  @Header('Cache-Control', 'no-store')
  canReset(@Param('userId', idParam) userId: string) {
    return this.reset.canReset(userId);
  }

  @Post(':userId/reset-access')
  @RequirePermission('users.reset_access')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resetAccess(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(accessResetSchema)) b: AccessResetDto, @Req() req: Request) {
    return this.reset.resetInCompany(userId, b, req.ip);
  }
}

/** Lo que solo hace el Súper Admin: cuentas de varias empresas, personal de agencia y otros Súper Admin (y cualquier otra persona). */
@PlatformOnly()
@Controller('platform')
export class PlatformAccessResetController {
  constructor(@Inject(AccessResetService) private readonly reset: AccessResetService) {}

  @Post('users/:userId/reset-access')
  @RequirePermission('platform.users.reset_access')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resetAccess(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(accessResetSchema)) b: AccessResetDto, @Req() req: Request) {
    return this.reset.resetFromPlatform(userId, b, req.ip);
  }

  /** El registro de restablecimientos (quién, a quién, de qué empresa y por qué): pestaña «Accesos». */
  @Get('access-resets')
  @RequirePermission('platform.access_log.read')
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(listAccessResetsQuerySchema)) q: ListAccessResetsQuery) {
    return this.reset.list(q);
  }
}
