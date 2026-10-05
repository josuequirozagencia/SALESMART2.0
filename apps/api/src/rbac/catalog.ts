/**
 * Catálogo canónico de permisos y matriz rol → permisos (Build Spec §5). ÚNICA fuente en código; la migración
 * `0010_rbac_seed` siembra las mismas filas y el test `rbac.test.ts` falla si la BD y este archivo divergen.
 * Los permisos son extensibles: cada módulo nuevo añade los suyos (y sus asignaciones) mediante una migración + este archivo.
 */
export type PermissionScope = 'platform' | 'tenant';

export const PERMISSIONS = {
  'inbox.view_all': 'tenant',
  'inbox.reply': 'tenant',
  'inbox.transfer': 'tenant',
  'inbox.share': 'tenant',
  'contacts.read': 'tenant',
  'contacts.write': 'tenant',
  'contacts.import': 'tenant',
  'contacts.export': 'tenant',
  'opportunities.read': 'tenant',
  'opportunities.write': 'tenant',
  'pipelines.manage': 'tenant',
  'sales.create': 'tenant',
  'sales.cancel': 'tenant',
  'appointments.manage': 'tenant',
  'queues.manage': 'tenant',
  'tags.manage': 'tenant',
  'agents.manage': 'tenant',
  'agents.test': 'tenant',
  'knowledge.manage': 'tenant',
  'channels.manage': 'tenant',
  'integrations.manage': 'tenant',
  'forms.manage': 'tenant',
  'automations.manage': 'tenant',
  'commissions.view': 'tenant',
  'commissions.manage': 'tenant',
  'analytics.view': 'tenant',
  export: 'tenant',
  'team.manage': 'tenant',
  'billing.manage': 'tenant',
  'platform.providers.manage': 'platform',
  'platform.agencies.manage': 'platform',
  'platform.trials.manage': 'platform',
  'platform.access_log.read': 'platform',
} as const satisfies Record<string, PermissionScope>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];
export const isPermissionKey = (k: string): k is PermissionKey => Object.hasOwn(PERMISSIONS, k);

export const ROLES = {
  super_admin: { scope: 'platform', description: 'Plataforma: agencias, planes, proveedores, pruebas y accesos' },
  agency: { scope: 'tenant', description: 'Agencia: administra su cartera de clientes (el nivel por cliente se define en M2)' },
  client_admin: { scope: 'tenant', description: 'Administra su organización' },
  advisor: { scope: 'tenant', description: 'Ve sus chats y los que le compartieron' },
} as const satisfies Record<string, { scope: PermissionScope; description: string }>;
export type RoleKey = keyof typeof ROLES;

/**
 * MATRIZ ROL → PERMISOS. **PROVISIONAL (M1.4)** — el Build Spec define los roles y el catálogo pero no la matriz completa.
 * Criterio de menor privilegio, derivable del Spec:
 *  - super_admin: todos los permisos de plataforma.
 *  - client_admin: TODOS los permisos de organización («administra su organización»).
 *  - advisor: línea base mínima (responder chats, leer contactos y oportunidades). No tiene `inbox.view_all`
 *    (Spec §5.1/ADR-16). Cada módulo ampliará lo suyo cuando exista la funcionalidad.
 *  - agency: SIN permisos propios en M1; su acceso a clientes y el nivel por cliente (sin acceso / lectura / asesor /
 *    administrador) se definen en M2 (ADR-11/22).
 */
const tenantKeys = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'tenant');
const platformKeys = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'platform');

export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly PermissionKey[]>> = {
  super_admin: platformKeys,
  agency: [],
  client_admin: tenantKeys,
  advisor: ['inbox.reply', 'contacts.read', 'opportunities.read'],
};
