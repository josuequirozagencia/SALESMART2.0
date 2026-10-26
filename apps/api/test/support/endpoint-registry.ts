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
  // Proveedores de la plataforma (M2.6, ADR-21/ADR-42). Pruebas: test/platform/providers.test.ts (acceso solo Súper Admin, secretos cifrados y nunca devueltos, activación, BD)
  { route: 'GET /v1/platform/providers', kind: 'platform', test: '../../platform/providers.test.ts' },
  { route: 'PUT /v1/platform/providers/:service/active', kind: 'platform', test: '../../platform/providers.test.ts' },
  { route: 'PUT /v1/platform/providers/:service/:provider/credentials', kind: 'platform', test: '../../platform/providers.test.ts' },
  { route: 'DELETE /v1/platform/providers/:service/:provider/credentials', kind: 'platform', test: '../../platform/providers.test.ts' },
  // Contactos (M3.1, ADR-43). Pruebas: test/contacts/contacts.test.ts (A↔B por endpoint, alcance propio del asesor, teléfono único, borrado lógico, auditoría, roles de BD)
  { route: 'GET /v1/contacts', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  { route: 'GET /v1/contacts/owners', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  { route: 'GET /v1/contacts/:id', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  { route: 'POST /v1/contacts', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  { route: 'PATCH /v1/contacts/:id', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  { route: 'DELETE /v1/contacts/:id', kind: 'tenant', isolationTest: '../../contacts/contacts.test.ts' },
  // Etiquetas, atribución y salida de eventos (M3.3, ADR-45). Pruebas: test/attribution/attribution.test.ts. El webhook es público: su credencial es el par (id opaco, secreto).
  { route: 'GET /v1/tags', kind: 'tenant', isolationTest: '../../attribution/attribution.test.ts' },
  { route: 'GET /v1/attribution/endpoint', kind: 'tenant', isolationTest: '../../attribution/attribution.test.ts' },
  { route: 'POST /v1/attribution/endpoint', kind: 'tenant', isolationTest: '../../attribution/attribution.test.ts' },
  { route: 'POST /v1/attribution/ctwa/:endpointId', kind: 'public' },
  // Importar y exportar contactos (M3.5, ADR-47). Pruebas: test/imports/imports.test.ts
  { route: 'POST /v1/contacts/export', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'GET /v1/contact-imports', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'POST /v1/contact-imports', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'GET /v1/contact-imports/:id', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'PATCH /v1/contact-imports/:id', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'POST /v1/contact-imports/:id/rows', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'GET /v1/contact-imports/:id/preview', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'POST /v1/contact-imports/:id/start', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'POST /v1/contact-imports/:id/process', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'POST /v1/contact-imports/:id/cancel', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  { route: 'GET /v1/contact-imports/:id/report', kind: 'tenant', isolationTest: '../../imports/imports.test.ts' },
  // Empresas, notas y tareas (M3.6, ADR-48). Pruebas: test/crm-extras/crm-extras.test.ts
  { route: 'GET /v1/companies', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/companies', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/companies/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'PATCH /v1/companies/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'DELETE /v1/companies/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/companies/:id/contacts', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/companies/:id/contacts', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/companies/:id/contacts/remove', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/companies/:id/notes', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/companies/:id/notes', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/contacts/:contactId/companies/:companyId', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'DELETE /v1/contacts/:contactId/companies/:companyId', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/contacts/:contactId/notes', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/contacts/:contactId/notes', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'PATCH /v1/notes/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'DELETE /v1/notes/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/tasks', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/tasks', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'GET /v1/tasks/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'PATCH /v1/tasks/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'DELETE /v1/tasks/:id', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/tasks/:id/complete', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  { route: 'POST /v1/tasks/:id/reopen', kind: 'tenant', isolationTest: '../../crm-extras/crm-extras.test.ts' },
  // Pipelines y etapas (M4.1, ADR-49). Pruebas: test/pipelines/pipelines.test.ts
  { route: 'GET /v1/pipelines', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'POST /v1/pipelines', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'PUT /v1/pipelines/order', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'PATCH /v1/pipelines/:id', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'DELETE /v1/pipelines/:id', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'POST /v1/pipelines/:id/stages', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'PUT /v1/pipelines/:id/stages/order', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'PATCH /v1/pipeline-stages/:id', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  { route: 'DELETE /v1/pipeline-stages/:id', kind: 'tenant', isolationTest: '../../pipelines/pipelines.test.ts' },
  // Oportunidades (M4.2, ADR-49). Pruebas: test/opportunities/opportunities.test.ts
  { route: 'GET /v1/opportunities', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'POST /v1/opportunities', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'GET /v1/opportunities/:id', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'PATCH /v1/opportunities/:id', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'DELETE /v1/opportunities/:id', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'POST /v1/opportunities/:id/move', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  { route: 'GET /v1/pipelines/:id/summary', kind: 'tenant', isolationTest: '../../opportunities/opportunities.test.ts' },
  // Conexiones de canales (M5.1, ADR-50). Pruebas: test/channels/channels.test.ts
  { route: 'GET /v1/channels', kind: 'tenant', isolationTest: '../../channels/channels.test.ts' },
  { route: 'POST /v1/channels', kind: 'tenant', isolationTest: '../../channels/channels.test.ts' },
  { route: 'PATCH /v1/channels/:id', kind: 'tenant', isolationTest: '../../channels/channels.test.ts' },
  { route: 'POST /v1/channels/:id/check', kind: 'tenant', isolationTest: '../../channels/channels.test.ts' },
  { route: 'DELETE /v1/channels/:id', kind: 'tenant', isolationTest: '../../channels/channels.test.ts' },
  // Webhook de Meta (M5.2, ADR-50): PÚBLICO; la credencial es la firma del aviso (HMAC con el secreto de la app de la plataforma), con límite de fallos por IP. Pruebas: test/channels/meta-webhook.test.ts
  { route: 'GET /v1/channels/meta/webhook', kind: 'public' },
  { route: 'POST /v1/channels/meta/webhook', kind: 'public' },
  // Colas y reparto (M5.3, ADR-07/ADR-50). Pruebas: test/queues/queues.test.ts (A↔B, permisos, reparto, concurrencia)
  { route: 'GET /v1/queues', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'POST /v1/queues', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'PATCH /v1/queues/:id', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'PUT /v1/queues/:id/members', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'DELETE /v1/queues/:id', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'POST /v1/queues/:id/simulate', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  { route: 'POST /v1/queues/:id/distribute', kind: 'tenant', isolationTest: '../../queues/queues.test.ts' },
  // Ventas, abonos y saldo (M6.2, ADR-51). Pruebas: test/sales/sales.test.ts (A↔B, permisos, dinero, idempotencia, concurrencia)
  { route: 'GET /v1/sales/options', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'GET /v1/sales/settings', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'PUT /v1/sales/settings', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'GET /v1/sales/change-requests', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales/change-requests/:id/resolve', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'GET /v1/sales', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'GET /v1/sales/:id', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales/:id/payments', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales/:id/corrections', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales/:id/cancel', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  { route: 'POST /v1/sales/:id/change-requests', kind: 'tenant', isolationTest: '../../sales/sales.test.ts' },
  // Citas y recordatorios (M6.3, ADR-13/51). Pruebas: test/appointments/appointments.test.ts (A↔B, permisos, topes, ventana de 24 h, recordatorios)
  { route: 'GET /v1/appointments/options', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'POST /v1/appointments', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'GET /v1/appointments', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'GET /v1/appointments/:id', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'PATCH /v1/appointments/:id', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'POST /v1/appointments/:id/cancel', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  { route: 'POST /v1/appointments/:id/complete', kind: 'tenant', isolationTest: '../../appointments/appointments.test.ts' },
  // Conexión con la API de Conversiones de Meta y panel de eventos (M6.4, ADR-45/51). Pruebas: test/attribution/meta.test.ts (A↔B, permisos, token jamás devuelto, envío por empresa)
  { route: 'GET /v1/meta/settings', kind: 'tenant', isolationTest: '../../attribution/meta.test.ts' },
  { route: 'PUT /v1/meta/settings', kind: 'tenant', isolationTest: '../../attribution/meta.test.ts' },
  { route: 'POST /v1/meta/settings/test', kind: 'tenant', isolationTest: '../../attribution/meta.test.ts' },
  { route: 'GET /v1/meta/events', kind: 'tenant', isolationTest: '../../attribution/meta.test.ts' },
  { route: 'POST /v1/meta/events/:id/retry', kind: 'tenant', isolationTest: '../../attribution/meta.test.ts' },
  // Tablero y analítica (M6.5, ADR-51). Pruebas: test/analytics/analytics.test.ts (A↔B, alcance propio, cifras, CSV auditado)
  { route: 'GET /v1/analytics/summary', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  { route: 'GET /v1/analytics/reports/:name', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  { route: 'POST /v1/analytics/export', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  { route: 'GET /v1/analytics/exports', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  { route: 'GET /v1/analytics/settings', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  { route: 'PUT /v1/analytics/settings', kind: 'tenant', isolationTest: '../../analytics/analytics.test.ts' },
  // GoHighLevel (M7.1, ADR-52). Pruebas: test/ghl/ghl.test.ts (A↔B, token jamás devuelto, secreto del webhook)
  { route: 'GET /v1/ghl/connection', kind: 'tenant', isolationTest: '../../ghl/ghl.test.ts' },
  { route: 'PUT /v1/ghl/connection', kind: 'tenant', isolationTest: '../../ghl/ghl.test.ts' },
  { route: 'POST /v1/ghl/connection/test', kind: 'tenant', isolationTest: '../../ghl/ghl.test.ts' },
  { route: 'POST /v1/ghl/connection/disconnect', kind: 'tenant', isolationTest: '../../ghl/ghl.test.ts' },
  { route: 'POST /v1/ghl/webhook/secret', kind: 'tenant', isolationTest: '../../ghl/ghl.test.ts' },
  // Avisos del Workflow de GHL (M7.2, ADR-52). Pública: id opaco + secreto en cabecera. Pruebas: test/ghl/ghl-events.test.ts
  { route: 'POST /v1/integrations/ghl/webhook/:routeId', kind: 'public' },
  { route: 'GET /v1/ghl/events', kind: 'tenant', isolationTest: '../../ghl/ghl-events.test.ts' },
  // Etiquetas bidireccionales con GHL (M7.3, ADR-52). Pruebas: test/ghl/ghl-tags.test.ts
  { route: 'GET /v1/ghl/outbox', kind: 'tenant', isolationTest: '../../ghl/ghl-tags.test.ts' },
  { route: 'POST /v1/ghl/outbox/:id/retry', kind: 'tenant', isolationTest: '../../ghl/ghl-tags.test.ts' },
  // Mensajes de GHL en el Inbox (M7.4, ADR-52). Pruebas: test/ghl/ghl-messages.test.ts
  { route: 'GET /v1/ghl/channel', kind: 'tenant', isolationTest: '../../ghl/ghl-messages.test.ts' },
  { route: 'PUT /v1/ghl/channel', kind: 'tenant', isolationTest: '../../ghl/ghl-messages.test.ts' },
  // Créditos IA (M8.1, ADR-53). Pruebas: test/ai/credits.test.ts (A↔B, concurrencia, costo y margen fuera de la API de cliente)
  { route: 'GET /v1/ai/credits', kind: 'tenant', isolationTest: '../../ai/credits.test.ts' },
  { route: 'GET /v1/platform/ai/pricing', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'PUT /v1/platform/ai/pricing', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'GET /v1/platform/ai/organizations', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'PUT /v1/platform/ai/organizations/:id/margin', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'POST /v1/platform/ai/organizations/:id/grants', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'GET /v1/platform/ai/organizations/:id/ledger', kind: 'platform', test: '../../ai/credits.test.ts' },
  { route: 'GET /v1/ghl/workflows', kind: 'tenant', isolationTest: '../../ghl/ghl-workflows.test.ts' },
  { route: 'POST /v1/ghl/contacts/:contactId/workflows', kind: 'tenant', isolationTest: '../../ghl/ghl-workflows.test.ts' },
  { route: 'GET /v1/ghl/contacts/:contactId/workflows', kind: 'tenant', isolationTest: '../../ghl/ghl-workflows.test.ts' },
  // Catálogo de productos por cola (M6.1, ADR-08/ADR-51). Pruebas: test/queues/products.test.ts (A↔B, permisos, precios exactos, límites)
  { route: 'GET /v1/queues/:id/products', kind: 'tenant', isolationTest: '../../queues/products.test.ts' },
  { route: 'POST /v1/queues/:id/products', kind: 'tenant', isolationTest: '../../queues/products.test.ts' },
  { route: 'PATCH /v1/queues/:id/products/:productId', kind: 'tenant', isolationTest: '../../queues/products.test.ts' },
  // Inbox (M5.4, ADR-16/50). Pruebas: test/inbox/inbox.test.ts (A↔B, visibilidad por persona, permisos, ventana de 24 h, envío con reintentos, notas, concurrencia)
  { route: 'GET /v1/conversations', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'GET /v1/conversations/options', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'GET /v1/conversations/:id', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'GET /v1/conversations/:id/messages', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/messages', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/notes', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/accept', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/take', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/close', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/conversations/:id/read', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  { route: 'POST /v1/messages/:id/retry', kind: 'tenant', isolationTest: '../../inbox/inbox.test.ts' },
  // Transferir y compartir (M5.5a, ADR-14/50). Pruebas: test/inbox/sharing.test.ts (A↔B, quién puede, visibilidad del colaborador, el lead se mueve, notas automáticas, auditoría)
  { route: 'GET /v1/conversations/:id/transfer-options', kind: 'tenant', isolationTest: '../../inbox/sharing.test.ts' },
  { route: 'POST /v1/conversations/:id/transfer', kind: 'tenant', isolationTest: '../../inbox/sharing.test.ts' },
  { route: 'POST /v1/conversations/:id/share', kind: 'tenant', isolationTest: '../../inbox/sharing.test.ts' },
  { route: 'DELETE /v1/conversations/:id/participants/:userId', kind: 'tenant', isolationTest: '../../inbox/sharing.test.ts' },
  // SLA, horario laboral y reasignación (M5.5b, ADR-07/50). Pruebas: test/inbox/sla.test.ts (A↔B, permisos, cronómetros, tiempo abierto, reasignación, feriados, horario de cola)
  { route: 'GET /v1/sla', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  { route: 'PUT /v1/sla/policy', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  { route: 'PUT /v1/sla/hours', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  { route: 'POST /v1/sla/holidays', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  { route: 'DELETE /v1/sla/holidays/:id', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  { route: 'PUT /v1/queues/:id/hours', kind: 'tenant', isolationTest: '../../inbox/sla.test.ts' },
  // Plantillas de WhatsApp (M5.6a, ADR-50). Pruebas: test/templates/templates.test.ts (A↔B, permisos, sincronización, selector de la conversación, envío con variables, errores de Meta)
  { route: 'GET /v1/channels/:id/templates', kind: 'tenant', isolationTest: '../../templates/templates.test.ts' },
  { route: 'POST /v1/channels/:id/templates/sync', kind: 'tenant', isolationTest: '../../templates/templates.test.ts' },
  { route: 'GET /v1/conversations/:id/templates', kind: 'tenant', isolationTest: '../../templates/templates.test.ts' },
  { route: 'POST /v1/conversations/:id/template', kind: 'tenant', isolationTest: '../../templates/templates.test.ts' },
  // Respuestas rápidas con variables (M5.6b, ADR-50). Pruebas: test/quick-replies/quick-replies.test.ts (A↔B, personales y compartidas, permisos, variables, resolución en la conversación)
  { route: 'GET /v1/quick-replies', kind: 'tenant', isolationTest: '../../quick-replies/quick-replies.test.ts' },
  { route: 'POST /v1/quick-replies', kind: 'tenant', isolationTest: '../../quick-replies/quick-replies.test.ts' },
  { route: 'PATCH /v1/quick-replies/:id', kind: 'tenant', isolationTest: '../../quick-replies/quick-replies.test.ts' },
  { route: 'DELETE /v1/quick-replies/:id', kind: 'tenant', isolationTest: '../../quick-replies/quick-replies.test.ts' },
  { route: 'GET /v1/conversations/:id/quick-replies', kind: 'tenant', isolationTest: '../../quick-replies/quick-replies.test.ts' },
  // Mensajes programados (M5.6c, ADR-50). Pruebas: test/scheduled/scheduled.test.ts (A↔B, permisos, ventana de 24 h, límites, cancelar, envío a su hora, cancelación automática, concurrencia)
  { route: 'GET /v1/conversations/:id/scheduled', kind: 'tenant', isolationTest: '../../scheduled/scheduled.test.ts' },
  { route: 'POST /v1/conversations/:id/scheduled', kind: 'tenant', isolationTest: '../../scheduled/scheduled.test.ts' },
  { route: 'DELETE /v1/conversations/:id/scheduled/:scheduledId', kind: 'tenant', isolationTest: '../../scheduled/scheduled.test.ts' },
  // Adjuntos y audio (M5.6d, ADR-50). Pruebas: test/attachments/attachments.test.ts (A↔B, permisos, tipos/tamaños, antivirus, envío con media, RLS)
  { route: 'POST /v1/conversations/:id/attachments', kind: 'tenant', isolationTest: '../../attachments/attachments.test.ts' },
  { route: 'GET /v1/attachments/:id/url', kind: 'tenant', isolationTest: '../../attachments/attachments.test.ts' },
  { route: 'POST /v1/conversations/:id/media', kind: 'tenant', isolationTest: '../../attachments/attachments.test.ts' },
  // Etiquetas personalizadas, listas y filtros (M3.4, ADR-46). Pruebas: test/lists/lists.test.ts
  { route: 'POST /v1/tags', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'PATCH /v1/tags/:id', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'DELETE /v1/tags/:id', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'GET /v1/contact-lists', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'POST /v1/contact-lists', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'PATCH /v1/contact-lists/:id', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'DELETE /v1/contact-lists/:id', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'POST /v1/contact-lists/:id/members', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  { route: 'POST /v1/contact-lists/:id/members/remove', kind: 'tenant', isolationTest: '../../lists/lists.test.ts' },
  // Campos personalizados (M3.2, ADR-44). Pruebas: test/custom-fields/custom-fields.test.ts (A↔B, permisos, tipos, obligatorios, archivado, valores en contactos, roles de BD)
  { route: 'GET /v1/custom-fields', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  { route: 'POST /v1/custom-fields', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  { route: 'PUT /v1/custom-fields/order', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  { route: 'PATCH /v1/custom-fields/:id', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  { route: 'POST /v1/custom-fields/:id/archive', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  { route: 'POST /v1/custom-fields/:id/restore', kind: 'tenant', isolationTest: '../../custom-fields/custom-fields.test.ts' },
  // Aceptación pública: el token de 256 bits es la credencial; límite por IP, errores uniformes. Pruebas: invitations.test.ts
  { route: 'POST /v1/auth/invitations/preview', kind: 'public' },
  { route: 'POST /v1/auth/invitations/accept', kind: 'public' },
];
