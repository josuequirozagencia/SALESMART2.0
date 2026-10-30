import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, permissions, rolePermissions, roles } from '../../db';
import { accessLevelPermissions, effectivePermissions, isOverrideRole, isPermissionKey, type AccessLevel, type PermissionKey } from '../../rbac';
import type { ActingAs } from './session.service';

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

  /**
   * Permisos de la sesión en su contexto ACTUAL (ADR-41). En su propia organización: los de su rol. Actuando en otra:
   *  - agencia en un cliente → según el nivel de acceso de ESE cliente (sin nivel, ningún permiso);
   *  - Súper Admin (soporte) en una empresa → los del administrador del cliente; en una agencia → los de la agencia;
   *  - con la empresa en pausa (prueba vencida) → solo los de lectura, para ambos.
   * Nunca se incluyen permisos de plataforma ni de la consola de agencia dentro de un cliente.
   */
  async forContext(c: { role: string; orgKind: string; accessLevel: AccessLevel | null; actingAs: ActingAs | null; trialExpired: boolean; overrides?: { grant: readonly string[]; deny: readonly string[] } }, now = Date.now()): Promise<ReadonlySet<PermissionKey>> {
    if (!c.actingAs) {
      const base = await this.forRole(c.role, now);
      // Ajustes por persona (M10.3, ADR-56): solo para los roles de una empresa, y siempre dentro del techo de su rol (un dato indebido no concede nada)
      const o = c.overrides;
      if (o && (o.grant.length > 0 || o.deny.length > 0) && isOverrideRole(c.role) && c.orgKind === 'client') return effectivePermissions(c.role, base, { grant: o.grant.filter(isPermissionKey), deny: o.deny.filter(isPermissionKey) });
      return base;
    }
    // Falla cerrada: una membresía de agencia en un cliente SIN nivel de acceso (dato corrupto) no puede nada
    if (c.actingAs === 'agency' && c.accessLevel === null) return new Set();
    if (c.actingAs === 'super_admin' && c.orgKind === 'agency') return this.forRole('agency', now);
    const base = { clientAdmin: await this.forRole('client_admin', now), advisor: await this.forRole('advisor', now) };
    const level: AccessLevel = c.actingAs === 'agency' ? (c.accessLevel as AccessLevel) : 'admin';
    return accessLevelPermissions(level, base, c.trialExpired);
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
