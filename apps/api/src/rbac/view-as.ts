import { READ_ONLY_PERMISSIONS, type AccessLevel, type PermissionKey } from './catalog';

/**
 * «Ver como» (M10.5, ADR-56 B4): mirar la aplicación como la vería otro ROL (no otra persona), solo para comprobar menús, pantallas y botones. Es una REDUCCIÓN pura:
 * los permisos efectivos son los de quien mira ∩ la plantilla del rol visto ∩ solo lectura; nunca se amplía nada.
 */
export type ViewAsRole = 'agency' | 'client_admin' | 'advisor';
export const VIEW_AS_ROLES: readonly ViewAsRole[] = ['agency', 'client_admin', 'advisor'];
export const isViewAsRole = (v: unknown): v is ViewAsRole => v === 'agency' || v === 'client_admin' || v === 'advisor';

/** Lo único de la agencia que se ve «como agencia»: la lista de sus clientes (solo leerla). */
const AGENCY_VIEW_READS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['agency.clients.read']);

/**
 * Qué roles puede elegir quien mira, según DÓNDE está y QUIÉN es (se vuelve a calcular en cada petición; un destino que no aplica es 404 uniforme):
 *  - Súper Admin dentro de una agencia (soporte) → Agencia; dentro de una empresa → Administrador y Asesor.
 *  - Agencia dentro de un cliente de su cartera → Administrador y Asesor, nunca más que su nivel de acceso (con «asesor», solo Asesor).
 *  - Administrador en su propia empresa → Asesor.
 *  - Todo lo demás (Asesor, la consola de plataforma, una agencia en su casa) → nada.
 */
export function viewAsOptions(a: { role: string; orgKind: string; actingAs: 'super_admin' | 'agency' | null; accessLevel: AccessLevel | null }): ViewAsRole[] {
  if (a.actingAs === 'super_admin') {
    if (a.orgKind === 'agency') return ['agency'];
    if (a.orgKind === 'client') return ['client_admin', 'advisor'];
    return [];
  }
  if (a.actingAs === 'agency') {
    if (a.orgKind !== 'client' || a.accessLevel === null) return [];
    return a.accessLevel === 'advisor' ? ['advisor'] : ['client_admin', 'advisor'];
  }
  return a.role === 'client_admin' && a.orgKind === 'client' ? ['advisor'] : [];
}

/**
 * Permisos mientras se ve como otro rol: lo que ya tiene quien mira ∩ la plantilla BASE del rol visto (sin ajustes personales de nadie) ∩ solo lectura. Siempre un subconjunto de
 * lo que quien mira ya puede: un asesor jamás «ve como administrador», y sin `*.view_all` se ven solo los registros propios.
 */
export function narrowToViewAs(actor: ReadonlySet<PermissionKey>, template: ReadonlySet<PermissionKey>, viewing: ViewAsRole): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const k of actor) if (template.has(k) && (READ_ONLY_PERMISSIONS.has(k) || (viewing === 'agency' && AGENCY_VIEW_READS.has(k)))) out.add(k);
  return out;
}
