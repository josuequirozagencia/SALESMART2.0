import type { PermissionCatalog, PermissionItem, PermissionOverrides, TeamRole } from '../../lib/types';

/** Permisos que protegen al equipo: no se quitan por persona (el servidor lo vuelve a exigir). */
const PROTECTED = new Set(['users.manage']);

export const REACH_LABEL: Record<PermissionItem['reach'], string> = { own: 'Solo lo suyo', all: 'Toda la empresa', config: 'Configuración' };

/** ¿La plantilla del rol da este permiso? */
export const inTemplate = (role: TeamRole, item: PermissionItem): boolean => item.in_role[role];

/** Estado de un permiso con los ajustes puestos: plantilla ∪ concedidos − quitados. */
export function isOn(role: TeamRole, item: PermissionItem, o: PermissionOverrides): boolean {
  if (o.deny.includes(item.key)) return false;
  return inTemplate(role, item) || o.grant.includes(item.key);
}

/** Por qué un interruptor no se puede mover (texto para la persona), o `null` si se puede. Refleja las reglas del servidor, que son las que mandan. */
export function lockedReason(role: TeamRole, item: PermissionItem, o: PermissionOverrides): string | null {
  const base = inTemplate(role, item);
  if (PROTECTED.has(item.key)) return 'Protege al equipo: cambia el rol de la persona en su lugar.';
  if (base) return null; // quitarle una función de su plantilla siempre se puede
  if (role === 'client_admin') return 'No aplica a un administrador.';
  if (!item.grantable_to_advisor) return item.reach === 'all' ? 'Un asesor ve solo lo suyo: este permiso es solo para administradores.' : 'No se puede conceder a un asesor.';
  if (!item.holder_can_grant && !o.grant.includes(item.key)) return 'No puedes conceder un permiso que tú no tienes.';
  return null;
}

/** Cambia un permiso y devuelve los ajustes nuevos, mínimos: solo lo que se aparta de la plantilla. */
export function toggle(role: TeamRole, item: PermissionItem, o: PermissionOverrides, on: boolean): PermissionOverrides {
  const base = inTemplate(role, item);
  const grant = o.grant.filter((k) => k !== item.key);
  const deny = o.deny.filter((k) => k !== item.key);
  if (on !== base) (on ? grant : deny).push(item.key);
  return { grant, deny };
}

export const sameOverrides = (a: PermissionOverrides, b: PermissionOverrides): boolean => {
  const eq = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((k, i) => k === [...y].sort()[i]);
  return eq(a.grant, b.grant) && eq(a.deny, b.deny);
};

/** Cuántos permisos se apartan de la plantilla (para «3 ajustes»). */
export const overrideCount = (o: PermissionOverrides): number => o.grant.length + o.deny.length;

/** Los ajustes que ya no caben en el rol elegido se descartan (cambiar de rol los reinicia en el servidor). */
export const itemsOf = (c: PermissionCatalog): PermissionItem[] => c.groups.flatMap((g) => g.items);
