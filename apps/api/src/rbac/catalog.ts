/**
 * Catálogo canónico de permisos y matriz rol → permisos (Build Spec §5). ÚNICA fuente en código; la migración
 * `0010_rbac_seed` siembra las mismas filas y el test `rbac.test.ts` falla si la BD y este archivo divergen.
 * Los permisos son extensibles: cada módulo nuevo añade los suyos (y sus asignaciones) mediante una migración + este archivo.
 */
export type PermissionScope = 'platform' | 'tenant';

export const PERMISSIONS = {
  // M5.4 (ADR-16/50): ver las conversaciones a las que se tiene acceso (las propias; con `inbox.view_all`, todas). Responder, aceptar, finalizar y escribir notas va con `inbox.reply`.
  'inbox.read': 'tenant',
  'inbox.view_all': 'tenant',
  'inbox.reply': 'tenant',
  'inbox.transfer': 'tenant',
  'inbox.share': 'tenant',
  // M5.6b (ADR-50): compartir con toda la empresa, editar y borrar las respuestas rápidas COMPARTIDAS. Crear y usar las personales basta con `inbox.reply`.
  'quick_replies.manage': 'tenant',
  'contacts.read': 'tenant',
  'contacts.write': 'tenant',
  'contacts.import': 'tenant',
  'contacts.export': 'tenant',
  // M3.1 (ADR-43): sin `contacts.view_all` el alcance es PROPIO (contactos asignados a la persona); con él, todos los de la organización.
  'contacts.view_all': 'tenant',
  'contacts.delete': 'tenant',
  // M3.2 (ADR-44): definir los campos personalizados del contacto (tipo, opciones, obligatorio, visible en el formulario). Leerlos va con `contacts.read`.
  'custom_fields.manage': 'tenant',
  // M3.6 (ADR-48): crear, editar, borrar empresas de contactos y vincularles contactos. Verlas va con `contacts.read`; las notas y tareas de una empresa, con `contacts.write`.
  'companies.manage': 'tenant',
  'opportunities.read': 'tenant',
  'opportunities.write': 'tenant',
  'pipelines.manage': 'tenant',
  'sales.create': 'tenant',
  'sales.cancel': 'tenant',
  // M6.2 (ADR-51): ver las ventas propias, ver todas, registrar abonos y administrar los ajustes de ventas (moneda, ventana de gracia de Meta).
  'sales.read': 'tenant',
  'sales.view_all': 'tenant',
  'sales.register_payment': 'tenant',
  'sales.manage': 'tenant',
  'appointments.manage': 'tenant',
  // M6.3 (ADR-51): ver y gestionar las citas PROPIAS (las de sus conversaciones), y ver/gestionar las de toda la empresa.
  'appointments.read': 'tenant',
  'appointments.write': 'tenant',
  'appointments.view_all': 'tenant',
  'queues.manage': 'tenant',
  // M5.5b: política de respuesta (SLA), horario laboral y feriados de la empresa.
  'sla.manage': 'tenant',
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
  // M6.5 (ADR-51): sin `analytics.view_all` el tablero muestra solo lo propio; descargar reportes en CSV exige `analytics.export` (y, para el asesor, que el administrador no lo haya desactivado); `analytics.manage` ve el registro de descargas y decide si el asesor puede descargar.
  'analytics.view_all': 'tenant',
  'analytics.export': 'tenant',
  'analytics.manage': 'tenant',
  // M7.5 (ADR-52): inscribir un contacto en un flujo (Workflow) de GoHighLevel. El asesor solo sobre los contactos que ve.
  'ghl.enroll': 'tenant',
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
 *    (Spec §5.1/ADR-16). Cada módulo ampliará lo suyo cuando exista la funcionalidad. M3.1 (ADR-32 #3, ADR-43) le añade
 *    `contacts.write` con alcance PROPIO (sin `contacts.view_all`): crea contactos asignados a sí mismo y edita los suyos.
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
  // `contacts.write` del asesor es de alcance PROPIO (ADR-32 #3 / ADR-43): crea contactos asignados a sí mismo y edita los suyos.
  // M4.2 (ADR-49): `opportunities.write` del asesor es de alcance PROPIO (sus oportunidades), igual que sus contactos.
  advisor: ['inbox.read', 'inbox.reply', 'inbox.transfer', 'inbox.share', 'contacts.read', 'contacts.write', 'opportunities.read', 'opportunities.write', 'sales.read', 'sales.create', 'sales.register_payment', 'appointments.read', 'appointments.write', 'analytics.view', 'analytics.export', 'ghl.enroll'],
};

/**
 * Permisos de SOLO LECTURA (ver sin cambiar nada). Es el techo de quien entra a una empresa en modo lectura: el nivel «lectura» de una agencia
 * y cualquier acceso de agencia o de soporte a una empresa con la prueba vencida (ADR-41). Todo permiso que no está aquí es de escritura.
 * PROVISIONAL: cada módulo nuevo añade aquí sus permisos de lectura.
 */
export const READ_ONLY_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['inbox.read', 'inbox.view_all', 'contacts.read', 'contacts.view_all', 'opportunities.read', 'sales.read', 'sales.view_all', 'appointments.read', 'appointments.view_all', 'commissions.view', 'analytics.view', 'analytics.view_all']);

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
