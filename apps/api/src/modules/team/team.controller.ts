import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { departmentsSchema, inviteSchema, leaveSchema, permissionsSchema, roleSchema, type DepartmentsDto, type InviteDto, type LeaveDto, type PermissionsDto, type RoleDto } from './team.dto';
import { TeamService } from './team.service';

const idParam = new ZodValidationPipe(z.uuid());
const limitQuery = new ZodValidationPipe(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict());

/** Lo que tiene quien hace la petición (nadie concede lo que no tiene). */
const holderOf = (req: AuthedRequest): ReadonlySet<import('../../rbac').PermissionKey> => req.principal?.permissions ?? new Set();

/**
 * Usuarios del equipo (M10.3, ADR-56 B3). TODO exige `users.manage` (el administrador; no es otorgable a un asesor). Las rutas fijas van antes que las de `:userId`.
 * `no-store`: describe a las personas de la empresa y sus permisos. La persona de la ruta es siempre de la empresa del contexto: la de otra empresa es un 404.
 */
@RequirePermission('users.manage')
@Controller('users')
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  /** Las personas del equipo (activas y desactivadas) con sus departamentos, y las invitaciones pendientes. */
  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.team.list();
  }

  /** El catálogo de permisos agrupado en español, con lo que trae cada rol y lo que se puede conceder. */
  @Get('permissions/catalog')
  @Header('Cache-Control', 'no-store')
  catalog(@Req() req: AuthedRequest) {
    return this.team.catalog(holderOf(req));
  }

  /** La historia del equipo (invitaciones, cambios de rol y permisos, desactivaciones…), la más reciente primero. */
  @Get('history')
  @Header('Cache-Control', 'no-store')
  async history(@Query(limitQuery) q: { limit: number }) {
    return { items: await this.team.history(q.limit) };
  }

  /** Invita a alguien al equipo. El enlace solo vuelve en la respuesta si el correo no salió. */
  @Post('invitations')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  invite(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(inviteSchema)) b: InviteDto) {
    return this.team.invite(b, holderOf(req));
  }

  @Post('invitations/:id/resend')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resend(@Param('id', idParam) id: string) {
    return this.team.resendInvitation(id);
  }

  @Post('invitations/:id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Param('id', idParam) id: string) {
    return this.team.cancelInvitation(id);
  }

  @Get(':userId')
  @Header('Cache-Control', 'no-store')
  one(@Param('userId', idParam) userId: string) {
    return this.team.get(userId);
  }

  /** Cambia el rol (administrador ↔ asesor). Los ajustes de permisos se reinician. El último administrador no baja de rol. */
  @Patch(':userId')
  @Header('Cache-Control', 'no-store')
  role(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(roleSchema)) b: RoleDto) {
    return this.team.changeRole(userId, b.role);
  }

  /** Reemplaza los ajustes de permisos de la persona, dentro del techo de su rol y de lo que tiene quien los otorga. */
  @Put(':userId/permissions')
  @Header('Cache-Control', 'no-store')
  permissions(@Req() req: AuthedRequest, @Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(permissionsSchema)) b: PermissionsDto) {
    return this.team.setPermissions(userId, b, holderOf(req));
  }

  @Put(':userId/departments')
  @Header('Cache-Control', 'no-store')
  departments(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(departmentsSchema)) b: DepartmentsDto) {
    return this.team.setDepartments(userId, b);
  }

  /** Desactiva a la persona (se puede reactivar). Hay que elegir qué pasa con sus conversaciones abiertas. */
  @Post(':userId/deactivate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  deactivate(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(leaveSchema)) b: LeaveDto) {
    return this.team.leave(userId, 'deactivated', b);
  }

  /** La quita del equipo para siempre (solo vuelve con una invitación nueva). Misma elección sobre sus conversaciones. */
  @Post(':userId/remove')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('userId', idParam) userId: string, @Body(new ZodValidationPipe(leaveSchema)) b: LeaveDto) {
    return this.team.leave(userId, 'removed', b);
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reactivate(@Param('userId', idParam) userId: string) {
    return this.team.reactivate(userId);
  }

  @Post(':userId/sessions/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revokeSessions(@Param('userId', idParam) userId: string) {
    return this.team.revokeSessions(userId);
  }
}
