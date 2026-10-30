import { PERMISSION_KEYS, PERMISSIONS, ROLE_PERMISSIONS, type PermissionKey } from './catalog';

/**
 * Catálogo de permisos AGRUPADO y en español, y reglas de los ajustes por persona (M10.3, ADR-56 B3, enmienda a ADR-29).
 *
 * El permiso efectivo de una persona = plantilla de su rol, más lo que el administrador le CONCEDIÓ (`grant`), menos lo que le QUITÓ (`deny`), siempre recortado por el TECHO de su rol:
 *  - `client_admin`: su techo es su plantilla (todos los de organización); solo se le pueden quitar permisos (nunca el que protege al equipo: `users.manage`).
 *  - `advisor`: su techo es su plantilla más los permisos OTORGABLES. **Nunca** uno de alcance «toda la empresa» (`reach: 'all'`): un asesor ve solo lo suyo (decidido por el
 *    responsable, 2026-10-30) ni uno que administra al equipo o la facturación.
 * Esto es lógica pura (sin base de datos): el servidor la usa al resolver cada petición y al validar lo que otorga un administrador.
 */
export type PermissionGroupId = 'conversations' | 'contacts' | 'pipeline' | 'sales' | 'agenda' | 'analytics' | 'ai' | 'channels' | 'setup' | 'team';

export const PERMISSION_GROUPS: ReadonlyArray<{ id: PermissionGroupId; label: string }> = [
  { id: 'conversations', label: 'Conversaciones' },
  { id: 'contacts', label: 'Contactos' },
  { id: 'pipeline', label: 'Oportunidades' },
  { id: 'sales', label: 'Ventas' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'analytics', label: 'Analítica y descargas' },
  { id: 'ai', label: 'IA y automatización' },
  { id: 'channels', label: 'Canales e integraciones' },
  { id: 'setup', label: 'Configuración' },
  { id: 'team', label: 'Equipo y facturación' },
];

export interface PermissionMeta {
  group: PermissionGroupId;
  label: string;
  hint: string;
  /** `own`: solo lo de la persona · `all`: toda la empresa (nunca otorgable a un asesor) · `config`: cambia la configuración de la empresa. */
  reach: 'own' | 'all' | 'config';
  /** ¿Se puede conceder a un asesor? */
  grantable: boolean;
}

type TenantKey = { [K in PermissionKey]: (typeof PERMISSIONS)[K] extends 'tenant' ? K : never }[PermissionKey];
/** Los permisos que se muestran y ajustan por persona: los de organización, sin los de la consola de la agencia. */
export type ManageableKey = Exclude<TenantKey, 'agency.clients.read' | 'agency.clients.create'>;

const own = (group: PermissionGroupId, label: string, hint: string, grantable = true): PermissionMeta => ({ group, label, hint, reach: 'own', grantable });
const all = (group: PermissionGroupId, label: string, hint: string): PermissionMeta => ({ group, label, hint, reach: 'all', grantable: false });
const cfg = (group: PermissionGroupId, label: string, hint: string, grantable = true): PermissionMeta => ({ group, label, hint, reach: 'config', grantable });

/** Un permiso nuevo de organización NO compila hasta que se describa aquí (así ninguno queda sin grupo ni sin decisión de si se puede otorgar). */
export const PERMISSION_META: Readonly<Record<ManageableKey, PermissionMeta>> = {
  'inbox.read': own('conversations', 'Ver sus conversaciones', 'Abrir el Inbox y leer las conversaciones que tiene asignadas o le compartieron.'),
  'inbox.reply': own('conversations', 'Responder y escribir notas', 'Aceptar, responder al cliente, dejar notas internas y finalizar sus conversaciones.'),
  'inbox.transfer': own('conversations', 'Transferir conversaciones', 'Pasar una conversación suya a otra persona.'),
  'inbox.share': own('conversations', 'Compartir conversaciones', 'Darle acceso a otra persona a una conversación suya.'),
  'inbox.view_all': all('conversations', 'Ver todas las conversaciones', 'Ver y responder las conversaciones de toda la empresa.'),
  'quick_replies.manage': cfg('conversations', 'Respuestas rápidas compartidas', 'Crear y editar las respuestas rápidas que usa todo el equipo.'),
  'contacts.read': own('contacts', 'Ver sus contactos', 'Ver los contactos que tiene asignados.'),
  'contacts.write': own('contacts', 'Crear y editar sus contactos', 'Crear contactos y editar los suyos.'),
  'contacts.view_all': all('contacts', 'Ver todos los contactos', 'Ver, filtrar y asignar los contactos de toda la empresa.'),
  'contacts.delete': own('contacts', 'Borrar contactos', 'Borrar contactos (queda registro de quién lo hizo).'),
  'contacts.import': own('contacts', 'Importar contactos', 'Subir contactos desde un archivo CSV.'),
  'contacts.export': own('contacts', 'Exportar contactos', 'Descargar contactos en CSV (cada descarga queda registrada).'),
  'companies.manage': cfg('contacts', 'Administrar empresas de contactos', 'Crear, editar y borrar empresas y vincularles contactos.'),
  'custom_fields.manage': cfg('contacts', 'Campos personalizados', 'Crear y cambiar los campos extra del contacto.'),
  'tags.manage': cfg('contacts', 'Etiquetas', 'Crear, renombrar y borrar etiquetas personalizadas.'),
  'opportunities.read': own('pipeline', 'Ver sus oportunidades', 'Ver las oportunidades que tiene asignadas.'),
  'opportunities.write': own('pipeline', 'Crear y mover sus oportunidades', 'Crear oportunidades y moverlas de etapa.'),
  'pipelines.manage': cfg('pipeline', 'Pipelines y etapas', 'Crear pipelines y cambiar sus etapas.'),
  'sales.read': own('sales', 'Ver sus ventas', 'Ver las ventas que registró.'),
  'sales.create': own('sales', 'Registrar ventas', 'Registrar una venta desde una conversación.'),
  'sales.register_payment': own('sales', 'Registrar abonos', 'Registrar abonos sobre sus ventas.'),
  'sales.cancel': own('sales', 'Anular y corregir ventas', 'Anular una venta o corregir un abono.'),
  'sales.view_all': all('sales', 'Ver todas las ventas', 'Ver las ventas de toda la empresa.'),
  'sales.manage': cfg('sales', 'Ajustes de ventas', 'Moneda y ventana de gracia del evento de compra.', false),
  'appointments.read': own('agenda', 'Ver sus citas', 'Ver las citas de sus conversaciones.'),
  'appointments.write': own('agenda', 'Agendar y cambiar citas', 'Crear, reprogramar, cancelar y completar sus citas.'),
  'appointments.manage': own('agenda', 'Gestionar citas (heredado)', 'Permiso heredado: lo cubren «ver» y «agendar».', false),
  'appointments.view_all': all('agenda', 'Ver la agenda de todos', 'Ver las citas de toda la empresa.'),
  'analytics.view': own('analytics', 'Ver su tablero', 'Ver el tablero y los reportes de lo suyo.'),
  'analytics.export': own('analytics', 'Descargar reportes', 'Descargar reportes en CSV de lo suyo.'),
  'analytics.view_all': all('analytics', 'Ver la analítica de toda la empresa', 'Ver el tablero y los reportes de todos.'),
  'analytics.manage': cfg('analytics', 'Registro de descargas', 'Ver quién descargó qué y decidir si los asesores pueden descargar.', false),
  'commissions.view': own('analytics', 'Ver su comisión', 'Ver sus comisiones (llega con el módulo de comisiones).'),
  'commissions.manage': cfg('analytics', 'Administrar comisiones', 'Definir los planes de comisión.', false),
  'agents.manage': cfg('ai', 'Agentes de IA', 'Crear y configurar agentes de IA.'),
  'agents.test': own('ai', 'Probar agentes de IA', 'Usar el simulador de un agente (gasta créditos).'),
  'knowledge.manage': cfg('ai', 'Biblioteca de conocimiento', 'Subir y borrar los documentos que lee la IA.'),
  'automations.manage': cfg('ai', 'Automatizaciones', 'Crear y activar automatizaciones.'),
  'ai.credits.view': own('ai', 'Ver los créditos de IA', 'Ver el saldo y los movimientos de créditos.'),
  'ghl.enroll': own('channels', 'Inscribir en flujos de GoHighLevel', 'Inscribir un contacto en un flujo.'),
  'channels.manage': cfg('channels', 'Conectar canales', 'Conectar, cambiar y desconectar los números de WhatsApp.'),
  'integrations.manage': cfg('channels', 'Integraciones', 'GoHighLevel y la API de Conversiones de Meta.'),
  'forms.manage': cfg('channels', 'Formularios', 'Crear formularios y publicarlos.'),
  'queues.manage': cfg('setup', 'Departamentos', 'Crear departamentos, su equipo, horario y reparto.'),
  'sla.manage': cfg('setup', 'Tiempos de respuesta y horario', 'Objetivo de respuesta, horario laboral y feriados.'),
  export: cfg('setup', 'Exportar (heredado)', 'Permiso heredado sin uso.', false),
  'users.manage': cfg('team', 'Administrar usuarios', 'Invitar, cambiar roles y permisos, desactivar y quitar personas del equipo.', false),
  'billing.manage': cfg('team', 'Plan y facturación', 'Ver y cambiar el plan y los pagos.', false),
};

export const MANAGEABLE_KEYS = Object.keys(PERMISSION_META) as ManageableKey[];
export const isManageable = (k: string): k is ManageableKey => Object.hasOwn(PERMISSION_META, k);

/** Los que protegen al equipo: ni siquiera un administrador se los puede quitar a otro por ajuste (se cambia el rol, con la regla del último administrador). */
export const PROTECTED_FROM_DENY: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['users.manage']);

export type OverrideRole = 'client_admin' | 'advisor';
export const isOverrideRole = (r: string): r is OverrideRole => r === 'client_admin' || r === 'advisor';

/** ¿Se le puede CONCEDER este permiso a una persona con este rol? (un administrador ya los tiene todos: conceder no aplica). */
export function isGrantable(role: OverrideRole, key: PermissionKey): boolean {
  if (role === 'client_admin') return false;
  return isManageable(key) && PERMISSION_META[key].grantable;
}

/** El techo de un rol: lo máximo que una persona con ese rol puede llegar a tener. */
export function ceilingOf(role: OverrideRole): ReadonlySet<PermissionKey> {
  const base = ROLE_PERMISSIONS[role];
  return new Set<PermissionKey>([...base, ...(role === 'advisor' ? PERMISSION_KEYS.filter((k) => isGrantable('advisor', k)) : [])]);
}

export interface PermissionOverrides {
  grant: readonly PermissionKey[];
  deny: readonly PermissionKey[];
}
export const NO_OVERRIDES: PermissionOverrides = { grant: [], deny: [] };

/**
 * Permisos efectivos de una persona. `base` es lo que su rol da (cargado de la base de datos); los ajustes se aplican y un `grant` solo entra si el techo del rol lo permite (un dato indebido en los
 * ajustes no concede nada) y un `deny` solo quita.
 */
export function effectivePermissions(role: OverrideRole, base: ReadonlySet<PermissionKey>, overrides: PermissionOverrides): ReadonlySet<PermissionKey> {
  const out = new Set<PermissionKey>(base);
  for (const k of overrides.grant) if (isGrantable(role, k)) out.add(k);
  for (const k of overrides.deny) if (!PROTECTED_FROM_DENY.has(k)) out.delete(k);
  // El techo se respeta por construcción: un  solo entra si es otorgable a ese rol, y  solo quita
  return out;
}

/** Los errores de un conjunto de ajustes que alguien quiere guardar, o `[]` si es válido. `holder` = lo que tiene quien los otorga en su contexto. */
export function validateOverrides(role: OverrideRole, overrides: PermissionOverrides, holder: ReadonlySet<PermissionKey>): Array<{ key: string; code: 'UNKNOWN' | 'NOT_GRANTABLE' | 'NOT_HELD' | 'PROTECTED' | 'CONFLICT'; message: string }> {
  const issues: Array<{ key: string; code: 'UNKNOWN' | 'NOT_GRANTABLE' | 'NOT_HELD' | 'PROTECTED' | 'CONFLICT'; message: string }> = [];
  const seen = new Set<string>();
  for (const k of [...overrides.grant, ...overrides.deny]) {
    if (seen.has(k)) issues.push({ key: k, code: 'CONFLICT', message: 'Ese permiso aparece más de una vez' });
    seen.add(k);
  }
  for (const k of overrides.grant) {
    if (!isManageable(k)) issues.push({ key: k, code: 'UNKNOWN', message: 'Ese permiso no existe' });
    else if (!isGrantable(role, k)) issues.push({ key: k, code: 'NOT_GRANTABLE', message: role === 'advisor' && PERMISSION_META[k].reach === 'all' ? 'Un asesor ve solo lo suyo: este permiso es solo para administradores' : 'Ese permiso no se puede conceder a esta persona' });
    else if (!holder.has(k)) issues.push({ key: k, code: 'NOT_HELD', message: 'No puedes conceder un permiso que tú no tienes' });
  }
  for (const k of overrides.deny) {
    if (!isManageable(k)) issues.push({ key: k, code: 'UNKNOWN', message: 'Ese permiso no existe' });
    else if (PROTECTED_FROM_DENY.has(k)) issues.push({ key: k, code: 'PROTECTED', message: 'Ese permiso protege al equipo: cambia el rol de la persona en su lugar' });
  }
  return issues;
}
