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
  // Consola de la agencia (M2.5, ADR-41). Solo el rol `agency` en SU organización; nunca dentro de un cliente.
  'agency.clients.read': 'tenant',
  'agency.clients.create': 'tenant',
  'platform.providers.manage': 'platform',
  'platform.agencies.manage': 'platform',
  'platform.trials.manage': 'platform',
  'platform.plans.manage': 'platform',
  'platform.companies.manage': 'platform',
  'platform.access_log.read': 'platform',
} as const satisfies Record<string, PermissionScope>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];
export const isPermissionKey = (k: string): k is PermissionKey => Object.hasOwn(PERMISSIONS, k);

export const ROLES = {
  super_admin: { scope: 'platform', description: 'Plataforma: agencias, planes, proveedores, pruebas y accesos' },
  agency: { scope: 'tenant', description: 'Agencia: administra su cartera de clientes; dentro de cada cliente actúa con el nivel de acceso de ese cliente (ADR-41)' },
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
 *  - agency: en SU organización, la consola «Mis clientes» (`agency.clients.*`). Dentro de un cliente NO usa esta fila: sus permisos salen
 *    del nivel de acceso por cliente (ver `accessLevelPermissions`, ADR-41).
 */
/** Permisos de la consola de la agencia: solo para el rol `agency` en su propia organización (nunca para el administrador de un cliente). */
export const AGENCY_CONSOLE_PERMISSIONS = ['agency.clients.read', 'agency.clients.create'] as const satisfies readonly PermissionKey[];
const tenantKeys = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'tenant' && !(AGENCY_CONSOLE_PERMISSIONS as readonly string[]).includes(k));
const platformKeys = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'platform');

export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly PermissionKey[]>> = {
  super_admin: platformKeys,
  agency: AGENCY_CONSOLE_PERMISSIONS,
  client_admin: tenantKeys,
  advisor: ['inbox.reply', 'contacts.read', 'opportunities.read'],
};

/**
 * Permisos de SOLO LECTURA (ver sin cambiar nada). Es el techo de quien entra a una empresa en modo lectura: el nivel «lectura» de una agencia
 * y cualquier acceso de agencia o de soporte a una empresa con la prueba vencida (ADR-41). Todo permiso que no está aquí es de escritura.
 * PROVISIONAL: cada módulo nuevo añade aquí sus permisos de lectura.
 */
export const READ_ONLY_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['inbox.view_all', 'contacts.read', 'opportunities.read', 'commissions.view', 'analytics.view']);

export type AccessLevel = 'read' | 'advisor' | 'admin';
export const isAccessLevel = (v: unknown): v is AccessLevel => v === 'read' || v === 'advisor' || v === 'admin';

/**
 * Permisos de quien entra a un cliente desde fuera (agencia, ADR-11/41) según su nivel:
 *  - admin → los del administrador del cliente;  advisor → los del asesor;  read → los del administrador, reducidos a los de solo lectura.
 * `readOnly` (prueba vencida del cliente) reduce cualquier nivel a los de solo lectura. Función pura: recibe los permisos ya cargados de BD.
 */
export function accessLevelPermissions(
  level: AccessLevel,
  base: { clientAdmin: ReadonlySet<PermissionKey>; advisor: ReadonlySet<PermissionKey> },
  readOnly = false,
): ReadonlySet<PermissionKey> {
  const picked = level === 'advisor' ? base.advisor : base.clientAdmin;
  const capped = level === 'read' || readOnly;
  return capped ? new Set([...picked].filter((k) => READ_ONLY_PERMISSIONS.has(k))) : picked;
}
