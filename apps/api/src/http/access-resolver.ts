import type { Request } from 'express';
import type { PermissionKey } from '../rbac';

/**
 * Principal ya VERIFICADO: lo produce un `AccessResolver` tras validar credencial, estado del usuario y membresía
 * en cada petición (Build Spec §4.1.5). Nunca se construye a partir de body/query/headers sin verificar.
 */
export type Principal =
  | {
      kind: 'tenant';
      userId: string;
      organizationId: string;
      /** Rol de la membresía en la organización activa (insumo del RBAC de M1.4). */
      role?: string;
      /** Permisos del rol cargados de BD por el resolvedor (RBAC). Sin este campo el principal no tiene ninguno. */
      permissions?: ReadonlySet<PermissionKey>;
      sessionId?: string;
      /** Soporte: super admin / agencia actuando dentro de la organización (queda auditado). */
      actingAs?: 'super_admin' | 'agency';
      actingOrgId?: string;
    }
  | { kind: 'platform'; userId: string; role?: string; permissions?: ReadonlySet<PermissionKey>; sessionId?: string };

/**
 * Puerto de autenticación/autorización. La implementación real (M1: LocalAuthProvider + organization_members)
 * está PENDIENTE; mientras tanto el valor por defecto deniega todo.
 */
export abstract class AccessResolver {
  /** Devuelve el principal verificado o `null` si la petición no está autenticada. Lanza solo por fallos internos. */
  abstract resolve(req: Request): Promise<Principal | null>;
}

export class DenyAllAccessResolver extends AccessResolver {
  resolve(): Promise<Principal | null> {
    return Promise.resolve(null);
  }
}
