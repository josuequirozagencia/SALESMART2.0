import { describe, expect, it } from 'vitest';
import { accessLevelPermissions, AGENCY_CONSOLE_PERMISSIONS, PERMISSIONS, READ_ONLY_PERMISSIONS, ROLE_PERMISSIONS, type PermissionKey } from '../../src/rbac';

// M2.5 (ADR-41): permisos de quien entra a un cliente desde fuera, según el nivel de acceso de ESE cliente. Función pura.
const base = { clientAdmin: new Set<PermissionKey>(ROLE_PERMISSIONS.client_admin), advisor: new Set<PermissionKey>(ROLE_PERMISSIONS.advisor) };
const keys = (s: ReadonlySet<PermissionKey>) => [...s].sort();

describe('accessLevelPermissions', () => {
  it('administrador = los del administrador del cliente; asesor = los del asesor', () => {
    expect(keys(accessLevelPermissions('admin', base))).toEqual(keys(base.clientAdmin));
    expect(keys(accessLevelPermissions('advisor', base))).toEqual(keys(base.advisor));
  });

  it('lectura = SOLO permisos de lectura, y ninguno de escritura aunque el administrador los tenga', () => {
    const read = accessLevelPermissions('read', base);
    expect(read.size).toBeGreaterThan(0);
    for (const k of read) expect(READ_ONLY_PERMISSIONS.has(k), k).toBe(true);
    expect(read.has('contacts.write')).toBe(false);
    expect(read.has('users.manage')).toBe(false);
    expect(read.has('billing.manage')).toBe(false);
  });

  it('con la empresa en solo lectura, TODOS los niveles se reducen a lectura (nunca se amplía)', () => {
    for (const level of ['read', 'advisor', 'admin'] as const) {
      const limited = accessLevelPermissions(level, base, true);
      for (const k of limited) expect(READ_ONLY_PERMISSIONS.has(k), `${level}: ${k}`).toBe(true);
      for (const k of limited) expect(accessLevelPermissions(level, base).has(k), `${level}: ${k} no estaba en el nivel`).toBe(true);
    }
  });

  it('dentro de un cliente jamás hay permisos de plataforma ni de la consola de agencia, con ningún nivel', () => {
    for (const level of ['read', 'advisor', 'admin'] as const) {
      for (const ro of [false, true]) {
        for (const k of accessLevelPermissions(level, base, ro)) {
          expect(PERMISSIONS[k], k).toBe('tenant');
          expect((AGENCY_CONSOLE_PERMISSIONS as readonly string[]).includes(k), k).toBe(false);
        }
      }
    }
  });

  it('el catálogo de solo lectura solo contiene permisos que existen y son de organización', () => {
    for (const k of READ_ONLY_PERMISSIONS) expect(PERMISSIONS[k]).toBe('tenant');
  });
});
