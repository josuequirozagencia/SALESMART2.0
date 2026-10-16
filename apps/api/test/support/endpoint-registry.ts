/**
 * Registro de endpoints HTTP y su clasificación de aislamiento (ADR-24: "A↔B por endpoint").
 *  - 'public':   sin autenticación ni datos de negocio (salud, login...).
 *  - 'platform': solo super_admin (test de rol/guard obligatorio).
 *  - 'tenant':   toca datos de negocio → DEBE tener suite A↔B en test/isolation/endpoints/<isolationTest> que
 *                mencione la ruta (se genera con describeTenantEndpointIsolation).
 * `endpoint-registry.test.ts` descubre las rutas REALES de Nest y falla si hay alguna sin clasificar o mal clasificada.
 */
export type EndpointEntry =
  | { route: string; kind: 'public' }
  | { route: string; kind: 'platform'; test: string }
  /** Cualquier principal autenticado operando solo sobre su propio usuario (@SelfService): el test debe demostrar que no admite ids ajenos. */
  | { route: string; kind: 'self'; test: string }
  | { route: string; kind: 'tenant'; isolationTest: string };

export const ENDPOINTS: readonly EndpointEntry[] = [
  { route: 'GET /health', kind: 'public' },
  { route: 'GET /health/ready', kind: 'public' },
  // Acceso (M1.1): públicas por naturaleza; se protegen con límite de intentos, errores genéricos y CSRF. Pruebas: auth.test.ts
  { route: 'POST /v1/auth/login', kind: 'public' },
  { route: 'POST /v1/auth/refresh', kind: 'public' },
  { route: 'POST /v1/auth/logout', kind: 'public' },
  { route: 'GET /v1/auth/me', kind: 'self', test: '../../auth/auth.test.ts' },
  // Registro (M1.2): públicas; protegidas con CAPTCHA, límites por IP/correo y respuestas uniformes. Pruebas: signup.test.ts
  { route: 'POST /v1/auth/signup', kind: 'public' },
  { route: 'POST /v1/auth/verify', kind: 'public' },
  { route: 'POST /v1/auth/resend', kind: 'public' },
  // Contraseña (M1.3). Pruebas: test/auth/password.test.ts
  { route: 'POST /v1/auth/forgot', kind: 'public' },
  { route: 'POST /v1/auth/reset', kind: 'public' },
  { route: 'POST /v1/auth/password', kind: 'self', test: '../../auth/password.test.ts' },
  // Pruebas gratuitas (M1.5). Pruebas: test/trials/trials.test.ts (A↔B, una sola extensión, concurrencia, pausa, job SKIP LOCKED)
  { route: 'GET /v1/trials/me', kind: 'self', test: '../../trials/trials.test.ts' },
  { route: 'POST /v1/trials/me/extension', kind: 'tenant', isolationTest: '../../trials/trials.test.ts' },
  { route: 'GET /v1/platform/trials', kind: 'platform', test: '../../trials/trials.test.ts' },
  { route: 'POST /v1/platform/trials/:id/approve', kind: 'platform', test: '../../trials/trials.test.ts' },
  { route: 'POST /v1/platform/trials/:id/deny', kind: 'platform', test: '../../trials/trials.test.ts' },
  // Empresas y planes (M2.2). Pruebas: test/platform/plans-companies.test.ts
  { route: 'GET /v1/platform/plans', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'POST /v1/platform/plans', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'PATCH /v1/platform/plans/:id', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'POST /v1/platform/plans/:id/archive', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'POST /v1/platform/plans/:id/restore', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'GET /v1/platform/companies', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  { route: 'PUT /v1/platform/companies/:id/plan', kind: 'platform', test: '../../platform/plans-companies.test.ts' },
  // «Nueva empresa» con invitación (M2.3, ADR-39). Pruebas: test/platform/invitations.test.ts (acceso, A↔B, un solo uso, caducidad, concurrencia, límites)
  { route: 'POST /v1/platform/companies', kind: 'platform', test: '../../platform/invitations.test.ts' },
  { route: 'POST /v1/platform/companies/:id/invitation/resend', kind: 'platform', test: '../../platform/invitations.test.ts' },
  // Agencias y carteras (M2.4, ADR-22/ADR-40). Pruebas: test/platform/agencies.test.ts (acceso, A↔B, acceso al instante, suspensión, historial, BD)
  { route: 'GET /v1/platform/agencies', kind: 'platform', test: '../../platform/agencies.test.ts' },
  { route: 'POST /v1/platform/agencies', kind: 'platform', test: '../../platform/agencies.test.ts' },
  { route: 'POST /v1/platform/agencies/:id/suspend', kind: 'platform', test: '../../platform/agencies.test.ts' },
  { route: 'POST /v1/platform/agencies/:id/reactivate', kind: 'platform', test: '../../platform/agencies.test.ts' },
  { route: 'GET /v1/platform/agencies/:id/history', kind: 'platform', test: '../../platform/agencies.test.ts' },
  { route: 'PUT /v1/platform/organizations/:id/agency', kind: 'platform', test: '../../platform/agencies.test.ts' },
  // Cambio de contexto, soporte del Súper Admin y registro de accesos (M2.5, ADR-41). Pruebas: test/platform/context.test.ts
  // (agencia solo entra a su cartera, 404 uniforme, acceso al instante, Súper Admin en soporte, marca acting_as, access_sessions solo para el Súper Admin, A↔B)
  { route: 'POST /v1/context/switch', kind: 'self', test: '../../platform/context.test.ts' },
  { route: 'GET /v1/context/options', kind: 'self', test: '../../platform/context.test.ts' },
  { route: 'GET /v1/platform/access-sessions', kind: 'platform', test: '../../platform/context.test.ts' },
  { route: 'PUT /v1/platform/organizations/:id/agency-access', kind: 'platform', test: '../../platform/context.test.ts' },
  { route: 'GET /v1/agency/clients', kind: 'tenant', isolationTest: '../../platform/context.test.ts' },
  { route: 'POST /v1/agency/clients', kind: 'tenant', isolationTest: '../../platform/context.test.ts' },
  { route: 'POST /v1/agency/clients/:id/invitation/resend', kind: 'tenant', isolationTest: '../../platform/context.test.ts' },
  // Aceptación pública: el token de 256 bits es la credencial; límite por IP, errores uniformes. Pruebas: invitations.test.ts
  { route: 'POST /v1/auth/invitations/preview', kind: 'public' },
  { route: 'POST /v1/auth/invitations/accept', kind: 'public' },
];
