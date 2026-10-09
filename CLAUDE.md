# CLAUDE.md — Sales Smart 2.0

SaaS CRM multiempresa, multiusuario y omnicanal (CRM, Inbox, WhatsApp, GoHighLevel, telefonía, agentes IA, automatizaciones, comisiones). Construido **desde cero**; el repo antiguo (`josuequirozagencia/sales-smart`) es solo fuente de conocimiento: **no copies código de él**.

Propietario: Josué Quiroz (agencia de tráfico digital, Guayaquil). Idioma de trabajo, comentarios de producto, textos de interfaz y commits de documentación: **español**. Identificadores de código: **inglés**.

## Documentos que mandan (léelos antes de tocar un módulo)
- `docs/BUILD_SPEC.md` — contrato de construcción, hitos y criterios de aceptación.
- `docs/ADR.md` — decisiones (ADR-01..). Si algo contradice un ADR, **para y pregunta**.
- `docs/FLUJOS.md` — los 21 flujos de usuario. El modelo de datos está en `BUILD_SPEC` §6 y el contrato de API en §7 (no hay archivos aparte para no duplicar y que se desfasen).
- `docs/legacy-audit/` — auditoría del repo antiguo (Entrega 1, Listas Fase 27, Lectura profunda, Inventario). Solo consulta; **no copies código del repo antiguo**.
- `spikes/` — pruebas **descartables**. Su código no pasa al producto sin revisión y aprobación explícita.
- `prototype/sales-smart-2-prototipo.html` — referencia de pantallas y flujos (datos sintéticos; **no es código a reutilizar**).

## Cómo trabajar
1. Un hito a la vez (BUILD_SPEC §14). No adelantes módulos de hitos posteriores.
2. Antes de una funcionalidad importante: dependencias, impacto, seguridad, multi-tenancy, modelo de datos, errores, pruebas, escalabilidad, observabilidad. Escríbelo en el PR.
3. Una decisión de arquitectura nueva = un ADR nuevo (decisión, alternativas, ventajas, desventajas, motivo, impacto).
4. **No inventes** funcionalidades ni supongas lo que hacía el sistema antiguo. Sin información: nombra la incertidumbre, ofrece opciones con trade-offs y recomienda una.
5. Sin hacks temporales como solución definitiva. Sin complejidad innecesaria; **monolito modular**, no microservicios.
6. Cuestiona decisiones débiles y detecta inconsistencias entre documentos.

## Reglas inviolables
### Multi-tenancy
- Toda tabla de negocio: `organization_id uuid NOT NULL` + política RLS (`current_setting('app.org_id')`).
- La app **nunca** usa un rol con `BYPASSRLS` ni dueño de tablas. Roles: `app_owner` (migraciones), `app_rw` (API/workers), `app_platform` (solo módulo `platform`).
- Cada petición: transacción + `SET LOCAL app.org_id`. `TenantContext` (AsyncLocalStorage) obligatorio; los repositorios fallan sin él. Cada job de cola serializa `organization_id`.
- Nunca "cargar por id y luego comprobar la empresa": la consulta ya está acotada por RLS y por el repositorio.
- Archivos bajo `org/{id}/…` con URL firmada; vector store con filtro `organization_id` + `agent_id`; webhooks por identificador opaco de canal.
- Cada endpoint nuevo trae su **test de aislamiento A↔B**. La CI falla si una tabla de negocio no tiene política RLS.

### Seguridad
- Secretos validados al arrancar, **sin valores por defecto**; claves separadas (sesión, cifrado, firma de webhooks).
- Sin SQL interpolado (lint). Consultas parametrizadas.
- Credenciales de terceros cifradas y **nunca** devueltas al cliente (solo últimos 4).
- Datos de tarjeta nunca pasan por nuestro servidor (tokens del procesador).
- Costo, margen y credenciales de proveedores de plataforma: solo `super_admin`, solo en servidor; **jamás** en respuestas de API de cliente o agencia.
- Todo webhook/formulario/API pública: firma o token, rate limit, validación de esquema, idempotencia.
- Logs con `org_id` y `request_id`, PII redactada.
- Mensajes de autenticación genéricos (no revelan si un correo existe).

### Dinero y datos derivados
- Saldos (venta, créditos IA) **derivados** de pagos/libro; nunca campos editables.
- Descuento de créditos: transacción atómica con bloqueo por organización.
- Comisión y evento Purchase a Meta sobre el **total** de la venta (ADR-08/18). Purchase con ventana de gracia como job diferido cancelable.
- Borrado lógico en entidades de negocio; `audit_logs` y `sale_status_history` **append-only**.

### Integraciones por adaptador
`AuthProvider` · `WhatsAppProvider` (Meta Cloud, Evolution/QR **no oficial**) · `TelephonyProvider` (Twilio) · `VoiceAIProvider` (Retell/Vapi tras PoC) · `AIProvider` · `StorageAdapter` · `VectorStore` · `MailProvider` · `PaymentProvider` · `GhlAuth` (Private Token ahora). El núcleo solo ve tipos normalizados (`NormalizedMessage`); ningún módulo importa un SDK de proveedor. Cada adaptador tiene un **fake** y un **contract test**.

## Vocabulario del producto
- **Proveedor** = empresa externa tras un servicio (solo Súper Admin lo configura).
- **Conexión** = canal concreto enlazado a una organización (`channel_accounts`).
- **Integración** = enlace de datos con otra plataforma (GHL, Meta CAPI, calendario).
- **Cola/departamento** = donde se configura el reparto de leads, el horario y el catálogo de productos.
- Roles: `super_admin` → `agency` → `client_admin` → `advisor`. Cada **cliente paga su propio plan**.
- Etiquetas del sistema (no borrables): **Lead**, **Cita agendada**, **Venta**; solo las pone el sistema.

## Convenciones de código
- TypeScript estricto; sin `any` implícito; `@ts-ignore` solo con comentario y ticket.
- Módulos NestJS con frontera: se importa solo el `index.ts` público de otro módulo.
- Validación con esquemas Zod compartidos (`packages/shared`); el servidor valida siempre, la UI es solo ayuda.
- UUID v7; dinero `numeric(14,2)` + `currency`; fechas en UTC con zona por organización para presentación y SLA.
- Errores: `{ error: { code, message, request_id, details } }`. Paginación por cursor. `Idempotency-Key` en ventas, pagos, formularios y webhooks.
- Migraciones solo hacia adelante; cada tabla nueva de negocio incluye su política RLS en la misma migración.
- Commits pequeños, mensajes claros; PR con: qué, por qué, impacto en multi-tenancy/seguridad, pruebas.
- Sin `console.log`; usar el logger estructurado.

## Pruebas (obligatorias)
Unitarias de dominio · integración con PostgreSQL real (testcontainers, **incluye RLS**) · **aislamiento A↔B por endpoint** · contract tests de adaptadores · webhooks (firma inválida, repetidos, fuera de orden) · E2E con Playwright. Obligatorio cubrir: aislamiento, dinero (ventas, pagos, créditos, comisiones) y autenticación.

## Comandos
```
pnpm i              # dependencias (Node 22, pnpm 10)
pnpm build          # shared → api (la API compilada necesita shared compilado)
pnpm typecheck      # tsc en todos los paquetes
pnpm lint           # ESLint con reglas ADR24-P1…P12 (noInlineConfig: no se pueden desactivar con comentarios)
pnpm test           # Vitest; requiere TEST_PG_ADMIN_URL (superusuario de un PostgreSQL desechable)
pnpm test:iso       # solo test/isolation (RLS, roles, políticas, lint-rules, migraciones, concurrencia, canario)
pnpm check          # typecheck + lint + test
pnpm db:bootstrap   # roles + base (superusuario; ver .env.tools.example)
pnpm db:migrate     # con app_owner (DATABASE_URL_OWNER)
pnpm db:audit       # audita el catálogo de PostgreSQL contra ADR-24
pnpm bootstrap:super-admin   # primer super_admin (BOOTSTRAP_SUPER_ADMIN_EMAIL); imprime la contraseña UNA vez; idempotente
pnpm dev:setup      # .env con contraseñas aleatorias (gitignored) + PostgreSQL en docker compose + roles + migraciones + audit
pnpm dev            # API con recarga; NO recibe las variables TOOLS_* ni la contraseña de admin
pnpm e2e            # build + arranca dist/main.js como proceso real contra una BD migrada
pnpm audit          # vulnerabilidades moderadas o superiores (CI lo exige)
```
CI: `.github/workflows/ci.yml` (PostgreSQL 16 efímero + PgBouncer real; audit, typecheck, lint, test, e2e). `REQUIRE_PGBOUNCER=1` hace obligatoria la prueba de PgBouncer (sin esa variable se omite si falta el binario).

## Decisiones aún abiertas (no las decidas tú)
Hosting/región · proveedor de correo · pasarela de pago · PoC voz (Retell vs. Vapi) · retención de grabaciones · validación en Events Manager de retirar eventos de Meta · valores de ejemplo de créditos y retención de prueba.

## Estado del trabajo
- **M0 — Fundaciones: cerrado** (ver `docs/M0_PROGRESO.md`): monorepo, config, logger, roles PG (`app_owner`/`app_rw`/`app_platform`/`app_identity`), TenantContext, RLS, identidad (ADR-25), capa HTTP segura, CI, PgBouncer verificado.
- **M1 — Auth, organizaciones y acceso: en curso** (plan en `docs/M1_PLAN.md`). Hecha y aprobada la rebanada **M1.1** (sesiones, `/v1/auth/login|refresh|logout`, resolvedor real, bloqueo por intentos; ADR-26 aprobado: refresh de un solo uso SIN ventana de gracia; todas las rutas bajo `/v1` salvo `/health`). **M1.2** (registro/verificación, ADR-27) aprobada: correo y CAPTCHA solo como puertos con fakes (sin proveedor; `none` ⇒ 503); contraseña mínima 8; lista de dominios desechables con `pnpm db:load-disposable-domains`. **M1.3** (olvido/reset/cambio de contraseña, ADR-28) aprobada; acceso `@SelfService()`. **M1.4** (RBAC + auditoría, ADR-29) aprobada 2026-10-05: `@RequirePermission(...)` obligatorio en rutas tenant/platform; matriz rol→permiso PROVISIONAL (`src/rbac/catalog.ts` + migración); auditoría con `writeAudit(tx, …)` en la misma transacción. Hosting inicial: Railway para staging/piloto (ADR-30, aprobado 2026-10-05). Prototipo v9 validado por el responsable de producto (2026-10-05); los cambios al Build Spec derivados (campañas, grupos, ventas del asesor) aún NO aplicados. **M1.5** (pruebas de 7 días, extensión única, vencimiento, cuenta en pausa; tareas periódicas en PostgreSQL con `SKIP LOCKED`, ADR-33 PROPUESTO) hecha 2026-10-09, pendiente de aprobación y de una pasada verde en CI (PG 16, Node 22). Siguiente: M1.6 pantallas.
- **Antes de producción:** estrategia de limpieza de `sessions`/`auth_throttle` y demás tablas de identidad (sin dar DELETE a `app_identity`; opciones en ADR-33) y calibrar los parámetros `AUTH_*` (provisionales).
- Tablas de identidad: solo `Database.withIdentity` desde `modules/auth` y `modules/organizations` (lint P12). Nunca el rol `app_rw` para identidad.
