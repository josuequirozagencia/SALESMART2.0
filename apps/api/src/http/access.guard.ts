import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { AccessResolver, type Principal } from './access-resolver';
import { PERMISSION_KEY } from '../rbac';
import type { PermissionKey } from '../rbac';
import { ACCESS_KEY, type AccessKind } from './public.decorator';

export type AuthedRequest = Request & { requestId?: string; principal?: Principal };

/**
 * Guard global DENEGAR-POR-DEFECTO. Solo verifica y adjunta el principal; el contexto de organización lo
 * establece `ContextInterceptor`. Este archivo no lee ninguna organización de la petición (ADR-24 P5).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccessResolver) private readonly resolver: AccessResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<AccessKind | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]) ?? 'tenant';
    if (kind === 'public') return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const principal = await this.resolver.resolve(req);
    if (!principal) throw new UnauthorizedError();

    // 'self': cualquier principal verificado; el servicio solo usa principal.userId, nunca ids de la petición
    if (kind === 'platform' && principal.kind !== 'platform') throw new ForbiddenError();
    if (kind === 'tenant' && principal.kind !== 'tenant') throw new ForbiddenError('CONTEXT_REQUIRED', 'Selecciona una organización para continuar');
    // RBAC central: TODOS los permisos exigidos deben estar en los que el resolvedor cargó para el rol verificado
    const required = this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (required && required.length > 0 && !required.every((k) => principal.permissions?.has(k))) throw new ForbiddenError();
    req.principal = principal;
    return true;
  }
}
