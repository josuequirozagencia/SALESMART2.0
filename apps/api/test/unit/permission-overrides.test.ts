import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, PERMISSIONS, ROLE_PERMISSIONS, type PermissionKey } from '../../src/rbac';
import { MANAGEABLE_KEYS, PERMISSION_GROUPS, PERMISSION_META, ceilingOf, effectivePermissions, isGrantable, validateOverrides } from '../../src/rbac';

// M10.3 (ADR-56 B3): ajustes de permisos por persona dentro del techo del rol. Lógica pura.
const ADVISOR = new Set<PermissionKey>(ROLE_PERMISSIONS.advisor);
const ADMIN = new Set<PermissionKey>(ROLE_PERMISSIONS.client_admin);
const none = { grant: [] as PermissionKey[], deny: [] as PermissionKey[] };

describe('catálogo agrupado', () => {
  it('cada permiso de organización (sin la consola de la agencia) está descrito, tiene grupo y alcance', () => {
    const tenant = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'tenant' && !k.startsWith('agency.'));
    expect([...MANAGEABLE_KEYS].sort()).toEqual([...tenant].sort());
    const groups = new Set(PERMISSION_GROUPS.map((g) => g.id));
    for (const k of MANAGEABLE_KEYS) {
      const m = PERMISSION_META[k];
      expect(groups.has(m.group), k).toBe(true);
      expect(m.label.length, k).toBeGreaterThan(3);
      expect(m.hint.length, k).toBeGreaterThan(5);
    }
  });

  it('REGLA INVIOLABLE: ningún permiso de alcance «toda la empresa» ni de administración del equipo se puede conceder a un asesor', () => {
    for (const k of MANAGEABLE_KEYS) {
      if (PERMISSION_META[k].reach === 'all') expect(isGrantable('advisor', k), k).toBe(false);
    }
    for (const k of ['inbox.view_all', 'contacts.view_all', 'sales.view_all', 'appointments.view_all', 'analytics.view_all', 'users.manage', 'billing.manage'] as const) {
      expect(isGrantable('advisor', k), k).toBe(false);
      expect(ceilingOf('advisor').has(k), k).toBe(false);
    }
    // todo lo `view_all` del catálogo está marcado de alcance «toda la empresa» (un permiso nuevo así no puede quedar otorgable por descuido)
    for (const k of PERMISSION_KEYS.filter((x) => x.endsWith('.view_all') && PERMISSIONS[x] === 'tenant')) expect(PERMISSION_META[k as keyof typeof PERMISSION_META].reach, k).toBe('all');
  });

  it('lo que el rol de asesor ya tiene cabe en su techo y el techo del administrador es su plantilla', () => {
    for (const k of ADVISOR) expect(ceilingOf('advisor').has(k), k).toBe(true);
    expect([...ceilingOf('client_admin')].sort()).toEqual([...ADMIN].sort());
  });
});

describe('permisos efectivos', () => {
  it('sin ajustes es la plantilla del rol', () => {
    expect([...effectivePermissions('advisor', ADVISOR, none)].sort()).toEqual([...ADVISOR].sort());
    expect([...effectivePermissions('client_admin', ADMIN, none)].sort()).toEqual([...ADMIN].sort());
  });

  it('un asesor puede recibir funciones (exportar, borrar, conectar canales) y perder otras', () => {
    const e = effectivePermissions('advisor', ADVISOR, { grant: ['contacts.export', 'contacts.delete', 'channels.manage'], deny: ['sales.create', 'inbox.transfer'] });
    for (const k of ['contacts.export', 'contacts.delete', 'channels.manage'] as const) expect(e.has(k), k).toBe(true);
    for (const k of ['sales.create', 'inbox.transfer'] as const) expect(e.has(k), k).toBe(false);
    expect(e.has('inbox.reply')).toBe(true); // lo demás sigue igual
  });

  it('un dato indebido NO concede nada: ni el alcance «toda la empresa», ni administrar usuarios, ni permisos de plataforma, aunque estén en la tabla', () => {
    const bad = ['contacts.view_all', 'inbox.view_all', 'analytics.view_all', 'users.manage', 'billing.manage', 'sales.manage', 'platform.plans.manage', 'agency.clients.read'] as PermissionKey[];
    const e = effectivePermissions('advisor', ADVISOR, { grant: bad, deny: [] });
    for (const k of bad) expect(e.has(k), k).toBe(false);
    expect([...e].sort()).toEqual([...ADVISOR].sort());
  });

  it('a un administrador se le pueden quitar permisos pero no el que protege al equipo, y conceder no le agrega nada', () => {
    const e = effectivePermissions('client_admin', ADMIN, { grant: ['platform.plans.manage' as PermissionKey], deny: ['contacts.delete', 'users.manage'] });
    expect(e.has('contacts.delete')).toBe(false);
    expect(e.has('users.manage')).toBe(true);
    expect(e.has('platform.plans.manage' as PermissionKey)).toBe(false);
  });
});

describe('validar lo que se quiere guardar', () => {
  const codes = (r: ReturnType<typeof validateOverrides>): string[] => r.map((x) => `${x.key}:${x.code}`);
  it('acepta lo válido', () => {
    expect(validateOverrides('advisor', { grant: ['contacts.export'], deny: ['sales.create'] }, ADMIN)).toEqual([]);
    expect(validateOverrides('advisor', none, new Set())).toEqual([]);
  });
  it('rechaza lo no otorgable con el motivo, lo desconocido, lo repetido y lo que quien otorga no tiene', () => {
    const r = validateOverrides('advisor', { grant: ['contacts.view_all', 'channels.manage', 'nope.nope' as PermissionKey, 'contacts.export'], deny: ['users.manage', 'contacts.export'] }, new Set<PermissionKey>(['contacts.export']));
    expect(codes(r).sort()).toEqual(['channels.manage:NOT_HELD', 'contacts.export:CONFLICT', 'contacts.view_all:NOT_GRANTABLE', 'nope.nope:UNKNOWN', 'users.manage:PROTECTED'].sort());
    expect(r.find((x) => x.key === 'contacts.view_all')!.message).toMatch(/solo lo suyo/);
  });
  it('a un administrador no se le concede nada', () => {
    expect(codes(validateOverrides('client_admin', { grant: ['contacts.export'], deny: [] }, ADMIN))).toEqual(['contacts.export:NOT_GRANTABLE']);
  });
});
