import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, permissions, rolePermissions, roles } from '../../db';
import { isPermissionKey, type PermissionKey } from '../../rbac';

const TTL_MS = 60_000;

/**
 * Permisos efectivos por rol (RBAC, M1.4), leídos de `role_permissions` con el rol de identidad. Se cachean 60 s
 * (cambian solo por migración). Un rol desconocido o un permiso fuera del ámbito del rol NO concede nada (deniega por defecto):
 * un rol de organización jamás recibe un permiso de plataforma, aunque la tabla estuviera mal sembrada.
 */
@Injectable()
export class PermissionService {
  private cache: { at: number; byRole: Map<string, ReadonlySet<PermissionKey>> } | null = null;

  constructor(@Inject(Database) private readonly db: Database) {}

  async forRole(role: string | undefined, now = Date.now()): Promise<ReadonlySet<PermissionKey>> {
    if (!role) return new Set();
    if (!this.cache || now - this.cache.at > TTL_MS) this.cache = { at: now, byRole: await this.load() };
    return this.cache.byRole.get(role) ?? new Set();
  }

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<Map<string, ReadonlySet<PermissionKey>>> {
    const rows = await this.db.withIdentity((tx) =>
      tx
        .select({ role: rolePermissions.roleKey, perm: rolePermissions.permissionKey, roleScope: roles.scope, permScope: permissions.scope })
        .from(rolePermissions)
        .innerJoin(roles, eq(roles.key, rolePermissions.roleKey))
        .innerJoin(permissions, eq(permissions.key, rolePermissions.permissionKey)),
    );
    const out = new Map<string, Set<PermissionKey>>();
    for (const r of rows) {
      if (r.roleScope !== r.permScope || !isPermissionKey(r.perm)) continue; // ámbito distinto o clave que el código no conoce
      let set = out.get(r.role);
      if (!set) out.set(r.role, (set = new Set()));
      set.add(r.perm);
    }
    return out;
  }
}
