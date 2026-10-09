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
];
