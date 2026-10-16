import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AccessResolver, type Principal } from '../../http';
import { PermissionService } from './permission.service';
import { SessionService } from './session.service';

/**
 * Resolvedor real (reemplaza al DenyAll de M0). Lee SOLO `Authorization: Bearer <access>`; la organización y el
 * rol salen de la sesión y la membresía verificadas en BD, nunca de la petición (ADR-24 P5).
 */
@Injectable()
export class LocalAccessResolver extends AccessResolver {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PermissionService) private readonly perms: PermissionService,
  ) {
    super();
  }

  async resolve(req: Request): Promise<Principal | null> {
    const m = /^Bearer ([^\s]+)$/i.exec(req.header('authorization') ?? '');
    if (!m) return null;
    const ctx = await this.sessions.authenticate(m[1]);
    if (!ctx) return null;
    // Súper Admin en la organización de plataforma → principal de plataforma; el resto → tenant
    const permissions = await this.perms.forContext(ctx);
    if (ctx.orgKind === 'platform') {
      return ctx.role === 'super_admin' ? { kind: 'platform', userId: ctx.userId, role: ctx.role, permissions, sessionId: ctx.sessionId } : null;
    }
    // Actuando en otra organización (ADR-41): queda marcado para la auditoría del cliente y la cuenta en pausa NO la bloquea (permisos de solo lectura).
    // En su propia organización, con la prueba vencida, la cuenta queda en pausa (ADR-23 #5).
    const context = ctx.actingAs ? { actingAs: ctx.actingAs, actingOrgId: ctx.home.id } : ctx.trialExpired ? { paused: true as const } : {};
    return { kind: 'tenant', userId: ctx.userId, organizationId: ctx.organizationId, role: ctx.role, permissions, sessionId: ctx.sessionId, ...context };
  }
}
