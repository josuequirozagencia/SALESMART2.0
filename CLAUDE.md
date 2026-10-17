# CLAUDE.md — Sales Smart 2.0

SaaS CRM multiempresa, multiusuario y omnicanal (CRM, Inbox, WhatsApp, GoHighLevel, telefonía, agentes IA, automatizaciones, comisiones). Construido **desde cero**; el repo antiguo (`josuequirozagencia/sales-smart`) es solo fuente de conocimiento: **no copies código de él**.

Propietario: Josué Quiroz (agencia de tráfico digital, Guayaquil). Idioma de trabajo, comentarios de producto, textos de interfaz y commits de documentación: **español**. Identificadores de código: **inglés**.

## Documentos que mandan (léelos antes de tocar un módulo)
- `docs/BUILD_SPEC.md` — contrato de construcción, hitos y criterios de aceptación.
- `docs/ADR.md` — decisiones (ADR-01..). Si algo contradice un ADR, **para y pregunta**.
- `docs/DESPLIEGUE_RAILWAY.md` — guía de despliegue (staging/piloto) con lo que hay que VALIDAR en el primer despliegue (ADR-30, ADR-36).
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
pnpm dev:web        # web (Vite, puerto 5173) con proxy /v1 → API en 3000; en dev.sh/.env: MAIL_PROVIDER=console y CAPTCHA_PROVIDER=fake; en la web VITE_CAPTCHA_PROVIDER=fake
pnpm e2e:web        # build + E2E en navegador real (Playwright) con BD, API y web efímeras; requiere TEST_PG_ADMIN_URL (PW_CHANNEL=msedge|chrome usa un navegador ya instalado)
pnpm audit          # vulnerabilidades moderadas o superiores (CI lo exige)
```
CI: `.github/workflows/ci.yml` (PostgreSQL 16 efímero + PgBouncer real; audit, typecheck, lint, test, e2e). `REQUIRE_PGBOUNCER=1` hace obligatoria la prueba de PgBouncer (sin esa variable se omite si falta el binario).

## Decisiones aún abiertas (no las decidas tú)
Hosting/región (Railway aprobado para piloto; producción por revalidar) · pasarela de pago · PoC voz (Retell vs. Vapi) · retención de grabaciones · validación en Events Manager de retirar eventos de Meta · valores de ejemplo de créditos y retención de prueba.

## Estado del trabajo
- **M0 — Fundaciones: cerrado** (ver `docs/M0_PROGRESO.md`): monorepo, config, logger, roles PG (`app_owner`/`app_rw`/`app_platform`/`app_identity`), TenantContext, RLS, identidad (ADR-25), capa HTTP segura, CI, PgBouncer verificado.
- **M1 — Auth, organizaciones y acceso: en curso** (plan en `docs/M1_PLAN.md`). Hecha y aprobada la rebanada **M1.1** (sesiones, `/v1/auth/login|refresh|logout`, resolvedor real, bloqueo por intentos; ADR-26 aprobado: refresh de un solo uso SIN ventana de gracia; todas las rutas bajo `/v1` salvo `/health`). **M1.2** (registro/verificación, ADR-27) aprobada: correo y CAPTCHA solo como puertos con fakes (sin proveedor; `none` ⇒ 503); contraseña mínima 8; lista de dominios desechables con `pnpm db:load-disposable-domains`. **M1.3** (olvido/reset/cambio de contraseña, ADR-28) aprobada; acceso `@SelfService()`. **M1.4** (RBAC + auditoría, ADR-29) aprobada 2026-10-05: `@RequirePermission(...)` obligatorio en rutas tenant/platform; matriz rol→permiso PROVISIONAL (`src/rbac/catalog.ts` + migración); auditoría con `writeAudit(tx, …)` en la misma transacción. Hosting inicial: Railway para staging/piloto (ADR-30, aprobado 2026-10-05). Prototipo v9 validado por el responsable de producto (2026-10-05); los cambios al Build Spec derivados (campañas, grupos, ventas del asesor) aún NO aplicados. **M1.5** (pruebas de 7 días, extensión única, vencimiento, cuenta en pausa; tareas periódicas en PostgreSQL con `SKIP LOCKED`, ADR-33 APROBADO) hecha y aprobada 2026-10-09, CI verde (PG 16, Node 22). **M1.6** (pantallas de acceso en React, `apps/web`; E2E del flujo ADR-23 en navegador real; ADR-34 APROBADO; el registro captura nombre y WhatsApp) hecha y aprobada 2026-10-11. **M1 completo.** **M2 (plataforma y agencias) en curso:** M2.1 hecha — pestaña «Pruebas»; **M2.2 hecha 2026-10-12 — «Empresas y planes»** (catálogo de planes, lista de empresas y asignación de plan; ADR-38 APROBADO: un plan saca a la empresa de la prueba; cobro manual hasta la pasarela). **M2.3 hecha 2026-10-14 — «Nueva empresa» con invitación al dueño** (F01; ADR-39 PROPUESTO, con país obligatorio —Ecuador por defecto— e invitación de 7 días aprobados): tabla `invitations` (identidad), `organizations.country`, pantalla pública `/accept-invite`, estado `invited` en la lista; el enlace se devuelve al Súper Admin solo si el correo no sale. **M2.4 hecha 2026-10-15 — «Agencias y carteras»** (lado del Súper Admin; ADR-40 PROPUESTO): alta de agencias con invitación, cartera (agregar, mover y quitar clientes con historial append-only y aviso por correo), suspender/reactivar, acceso de la agencia como membresías que `reconcile` mantiene (revocar corta el acceso al instante); el correo pasó a infraestructura compartida `src/mail`. **M2.5 hecha 2026-10-15 — «Cambio de contexto, soporte y accesos»** (ADR-41 PROPUESTO): `POST /context/switch` (sin tokens nuevos; derecho validado en cada petición; 404 uniforme), banner «Administrando X»/«Soporte», selector de cliente, «Mis clientes» y «Registrar cliente» de la agencia, nivel de acceso por cliente (lectura/asesor/administrador, lo fija el Súper Admin), solo lectura con la prueba vencida, marca `acting_as` en la auditoría del cliente y `access_sessions` (identidad; solo la lee el Súper Admin) con su pestaña «Accesos»; quitar el acceso devuelve la sesión a su origen. **M2.6 hecha 2026-10-16 — «Proveedores»** (ADR-42 APROBADO; **M2 completo**): catálogo en código de 12 servicios, credenciales de la plataforma cifradas con cifrado de sobre (AES-256-GCM, clave maestra `PROVIDER_CREDENTIALS_KEY` opcional por ahora y obligatoria antes de abrir a usuarios reales, rotable): TODO valor (también URL y región) se guarda cifrado y nunca se devuelve (solo últimos 4), proveedor en uso por servicio, tablas de plataforma `provider_credentials`/`provider_selection` (solo `app_platform`), auditoría de plataforma en la misma transacción y pestaña «Proveedores» solo para el Súper Admin. Diferidos con decisión pendiente: que el cliente revoque a su agencia, dar/retirar el rol de agencia a una empresa existente, retención de `access_sessions`, cómo leen los adaptadores las credenciales (M5), «Probar conexión» y el re-envuelto masivo de la clave. **M3 (CRM base) en curso:** **M3.1 hecha 2026-10-16 — «Contactos núcleo»** (ADR-43 APROBADO el 2026-10-16: el asesor crea y edita lo suyo, borrar solo el administrador, sin papelera por ahora): tablas `contacts`/`contact_phones` (RLS forzada, borrado lógico, teléfono E.164 único por empresa entre los vigentes, FK compuesta), permisos `contacts.view_all`/`contacts.delete` y el asesor con `contacts.write` de alcance propio (cambia la matriz provisional de ADR-29), visibilidad por persona aplicada en el servidor (404 uniforme), auditoría por campo, API `/v1/contacts` (cursor, búsqueda, orden, responsable; devuelve `access` para la UI) y en la web el marco `AppShell` de la empresa con la pantalla «Contactos». **M3.2 hecha 2026-10-16 — «Campos personalizados»** (ADR-44 APROBADO el 2026-10-16): tablas `custom_field_definitions`/`custom_field_values` (RLS forzada, FK compuesta, sin DELETE), 13 tipos validados en el servidor, variable `{{contact.clave}}` estable, archivar en vez de borrar, obligatorios en el alta manual, permiso `custom_fields.manage` (administrador), `custom_fields` dentro de la API de contactos con auditoría por campo, y en la web Configuración › Campos personalizados y campos dinámicos en el formulario de contacto. **M3.3 hecha 2026-10-16 — «Etiquetas del sistema y atribución de Meta»** (ADR-45 APROBADO): tablas `tags`/`contact_tags` (etiquetas del sistema solo las pone el servicio `SystemTagsService`), atribución first/last touch en `contacts`, punto de entrada por empresa `POST /v1/attribution/ctwa/:id` con secreto propio (tabla de identidad `attribution_endpoints`), salida de eventos `meta_events` con puerto `CapiProvider` (fake) y ventana de gracia cancelable —el adaptador real y el disparo de Purchase llegan en M6—, y en la web Configuración › Atribución de Meta y «Origen del lead» en el contacto. **M3.4 hecha 2026-10-16 — «Etiquetas personalizadas, listas y columnas»** (ADR-46 APROBADO el 2026-10-17): etiquetas personalizadas (`tags.manage`, `tag_ids` en el contacto), filtros por consentimiento/etiquetas/campos personalizados (`cf=variable:operador:valor`) con índices por tipo, `contact_lists` unificando vistas y listas (dinámicas con filtros, fijas con contactos; personales o compartidas con `contacts.view_all`) y `DELETE` solo en los pivotes `contact_tags` y `contact_list_members`; en la web la tabla de contactos con columnas configurables, selección, pestañas de listas y Configuración › Etiquetas. Siguen M3.5 importar/exportar CSV · M3.6 empresas, notas y tareas. Además aprobados e implementados el 2026-10-11: ADR-35 (limpieza de identidad), ADR-36 (un solo origen + proxy; guía `docs/DESPLIEGUE_RAILWAY.md`) y ADR-37 (Resend + Turnstile; falta validar el envío real).
- **Antes de producción:** calibrar los parámetros `AUTH_*` y las retenciones de la limpieza de identidad (provisionales). La limpieza de tablas de identidad está resuelta (ADR-35: función `SECURITY DEFINER` + job `identity-cleanup`; `app_identity` sigue sin DELETE).
- Tablas de identidad: solo `Database.withIdentity` desde `modules/auth` y `modules/organizations` (lint P12). Nunca el rol `app_rw` para identidad.
