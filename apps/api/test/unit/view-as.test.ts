import { describe, expect, it } from 'vitest';
import { accessLevelPermissions, narrowToViewAs, PERMISSION_KEYS, READ_ONLY_PERMISSIONS, ROLE_PERMISSIONS, viewAsOptions, VIEW_AS_ROLES, type AccessLevel, type PermissionKey, type ViewAsRole } from '../../src/rbac';

// «Ver como» (M10.5, ADR-56 B4): una REDUCCIÓN. Propiedad: para toda combinación (quién mira, dónde, rol visto) lo que se ve es un subconjunto de lo que quien mira ya podía.
const ROLES = ['super_admin', 'agency', 'client_admin', 'advisor'] as const;
const KINDS = ['platform', 'agency', 'client'] as const;
const ACTING = [null, 'super_admin', 'agency'] as const;
const LEVELS: Array<AccessLevel | null> = [null, 'read', 'advisor', 'admin'];
const set = (keys: readonly PermissionKey[]): ReadonlySet<PermissionKey> => new Set(keys);
const templates: Record<ViewAsRole, ReadonlySet<PermissionKey>> = { agency: set(ROLE_PERMISSIONS.agency), client_admin: set(ROLE_PERMISSIONS.client_admin), advisor: set(ROLE_PERMISSIONS.advisor) };

/** Lo que de verdad puede quien mira, como lo calcula `PermissionService.forContext` (sin ajustes personales). */
function actorPermissions(a: { role: string; orgKind: string; actingAs: 'super_admin' | 'agency' | null; accessLevel: AccessLevel | null }): ReadonlySet<PermissionKey> {
  if (!a.actingAs) return set(ROLE_PERMISSIONS[a.role as keyof typeof ROLE_PERMISSIONS] ?? []);
  if (a.actingAs === 'agency' && a.accessLevel === null) return new Set();
  if (a.actingAs === 'super_admin' && a.orgKind === 'agency') return templates.agency;
  return accessLevelPermissions((a.actingAs === 'agency' ? a.accessLevel : 'admin') as AccessLevel, { clientAdmin: templates.client_admin, advisor: templates.advisor }, false);
}

describe('«Ver como»: quién puede elegir qué', () => {
  it('un asesor, la plataforma y una agencia en su casa no tienen nada que elegir; nadie puede ver como un rol MAYOR al que ya tiene', () => {
    for (const role of ROLES) for (const orgKind of KINDS) for (const actingAs of ACTING) for (const accessLevel of LEVELS) {
      const o = viewAsOptions({ role, orgKind, actingAs, accessLevel });
      const label = JSON.stringify({ role, orgKind, actingAs, accessLevel });
      if (role === 'advisor' && !actingAs) expect(o, label).toEqual([]);
      if (orgKind === 'platform') expect(o, label).toEqual([]);
      if (!actingAs && role !== 'client_admin') expect(o, label).toEqual([]);
      if (!actingAs && role === 'client_admin') expect(o, label).toEqual(orgKind === 'client' ? ['advisor'] : []);
      // una agencia con nivel «asesor» no puede ver como administrador; sin nivel, nada
      if (actingAs === 'agency' && accessLevel === 'advisor') expect(o, label).not.toContain('client_admin');
      if (actingAs === 'agency' && accessLevel === null) expect(o, label).toEqual([]);
      expect(o.every((r) => VIEW_AS_ROLES.includes(r)), label).toBe(true);
    }
  });

  it('el Súper Admin ve como Agencia dentro de una agencia y como Administrador/Asesor dentro de una empresa', () => {
    expect(viewAsOptions({ role: 'super_admin', orgKind: 'agency', actingAs: 'super_admin', accessLevel: null })).toEqual(['agency']);
    expect(viewAsOptions({ role: 'super_admin', orgKind: 'client', actingAs: 'super_admin', accessLevel: null })).toEqual(['client_admin', 'advisor']);
  });
});

describe('«Ver como»: efecto = intersección, solo lectura', () => {
  it('PROPIEDAD: para toda combinación (quién, dónde, rol visto) lo efectivo ⊆ lo del actor ∩ la plantilla del rol visto ∩ solo lectura (nunca se amplía nada)', () => {
    let combos = 0;
    for (const role of ROLES) for (const orgKind of KINDS) for (const actingAs of ACTING) for (const accessLevel of LEVELS) {
      const actor = actorPermissions({ role, orgKind, actingAs, accessLevel });
      for (const viewing of viewAsOptions({ role, orgKind, actingAs, accessLevel })) {
        combos += 1;
        const eff = narrowToViewAs(actor, templates[viewing], viewing);
        for (const k of eff) {
          const label = `${role}/${orgKind}/${actingAs}/${accessLevel} → ${viewing}: ${k}`;
          expect(actor.has(k), label).toBe(true);
          expect(templates[viewing].has(k), label).toBe(true);
          expect(READ_ONLY_PERMISSIONS.has(k) || k === 'agency.clients.read', label).toBe(true);
        }
      }
    }
    expect(combos).toBeGreaterThan(10);
  });

  it('un administrador viendo como Asesor pierde todo «ver todo» y toda escritura; el asesor visto es solo lo suyo', () => {
    const eff = narrowToViewAs(templates.client_admin, templates.advisor, 'advisor');
    for (const k of PERMISSION_KEYS) if (k.endsWith('.view_all')) expect(eff.has(k), k).toBe(false);
    for (const k of ['contacts.write', 'contacts.delete', 'sales.create', 'users.manage', 'channels.manage', 'queues.manage'] as PermissionKey[]) expect(eff.has(k), k).toBe(false);
    expect(eff.has('contacts.read')).toBe(true);
    expect(eff.has('inbox.read')).toBe(true);
  });

  it('un permiso que el rol visto no trae no aparece aunque quien mira lo tenga; uno que quien mira no tiene tampoco aparece aunque el rol visto lo traiga', () => {
    const actor = set(['contacts.read', 'contacts.write', 'sales.read']);
    const template = set(['contacts.read', 'inbox.read']);
    expect([...narrowToViewAs(actor, template, 'advisor')]).toEqual(['contacts.read']);
  });
});
