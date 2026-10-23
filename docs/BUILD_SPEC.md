# SALES SMART 2.0 — BUILD SPEC (Fase 28)

Fecha: 2026-10-03 · Estado: **aprobado (2026-10-03)**; los valores marcados PROPUESTA siguen provisionales · Fuentes: Entrega 1, ADR-01..23, Listas Fase 27, Flujos, prototipo v14.

> Este documento es el contrato de construcción. Lo que no esté aquí ni en un ADR **no se inventa**: se pregunta. Cada sección indica si es **[DECIDIDO]** (ADR o decisión de Josué), **[PROPUESTA]** (mi recomendación, por confirmar) o **[ABIERTO]** (falta información).

---

## 0. Cómo usar este documento
1. Vive en el repositorio nuevo como `docs/BUILD_SPEC.md`, junto con `docs/ADR.md` y `CLAUDE.md`. **Estado: aprobado por Josué el 2026-10-03.**
2. Se implementa por **hitos** (sección 14). Un hito no empieza hasta cerrar el anterior (definición de terminado incluida).
3. El prototipo (`sales-smart-2-prototipo.html`, v14) es la referencia de **pantallas y flujos**, no de código. Sus datos son sintéticos.
4. Todo cambio de arquitectura se registra como ADR nuevo (decisión, alternativas, ventajas, desventajas, motivo, impacto).
5. **Revisión 2026-10-05 (prototipo v9 validado por Josué):** se incorporaron campañas masivas del asesor, gestor de grupos de WhatsApp (QR), «Mis ventas» del asesor y los permisos asociados (§1, §5, §6.4–6.9, §9, §10.1, §15, §16). Lo derivado de v9 que implica decisiones nuevas está en **ADR-32 (PROPUESTO)** y marcado aquí como **[PROPUESTA v9]**; hasta aprobar ADR-32 no se implementa.

---

## 1. Alcance por fase

| Fase | Contenido |
|---|---|
| **MVP** | Fundaciones (auth, organizaciones, RLS, auditoría, observabilidad) · Contactos y listas · Oportunidades y pipelines · Inbox omnicanal con WhatsApp oficial · Etiquetas del sistema · Citas y recordatorios · Ventas con abono · Dashboard · Meta CAPI (Lead/Schedule/Purchase) · GHL (Private Token) · SLA · Registro con prueba de 7 días · Plataforma Súper Admin · Móvil · **«Mis ventas» del asesor (el asesor crea ventas, no las modifica) [PROPUESTA v9]** · Inbox: botón Enviar, panel de contacto oculto por defecto |
| **V1** | WhatsApp QR (Evolution) · Agentes IA + Knowledge Base/RAG · Créditos IA · Formularios embebibles · Telefonía + WebRTC (Twilio) · Automatizaciones · Comisiones · Planes y cobro · Clonado de configuración · API pública · Consentimiento · **Gestor de grupos de WhatsApp (solo QR, con permisos por asesor) [PROPUESTA v9]** · **Comisión propia del asesor, plan en solo lectura [PROPUESTA v9]** |
| **V2** | IA de voz (tras PoC) · Llamadas masivas · Campañas masivas · Cumpleaños · Marca blanca · Migración desde ChatIA · Exportar XLSX/PDF |

**Nota v9:** las **campañas masivas** (incluidas las del asesor con plantilla/texto libre según la conexión) permanecen en **V2**; adelantarlas exige decidir cobro, límites y consentimiento (§15 #17).

**Fuera de alcance (descartado):** chat interno, anuncios, ayuda, Typebot/Dialogflow, marcador predictivo, OAuth de GHL Marketplace, login social (Google) en primera versión.

---

## 2. Stack **[DECIDIDO salvo lo marcado]**

| Capa | Elección | Nota |
|---|---|---|
| Lenguaje | TypeScript estricto (sin `any` implícito, sin `@ts-ignore` sin justificación) | |
| Backend | NestJS (monolito modular) | Un despliegue de API + un despliegue de workers, mismo código |
| Frontend | React + Vite + TypeScript, TanStack Query/Table, **una** librería UI | **[PROPUESTA]** Tailwind + shadcn/ui; tokens de color y tema como en el prototipo (violeta/verde/rojo, claro/oscuro) |
| BD | PostgreSQL 16 + RLS + pgvector | |
| ORM | Prisma o Drizzle | **[ABIERTO]** decidir con *spike* de 1 día: soporte de `SET LOCAL app.org_id` dentro de la transacción de cada petición. Si no es limpio → Drizzle/Kysely con SQL tipado |
| Colas | BullMQ + Redis | Todo job lleva `organization_id`. **M1.5 (ADR-33):** las tareas periódicas de plataforma (vencimiento de pruebas) corren en proceso sobre PostgreSQL con `SKIP LOCKED`, sin Redis; BullMQ se incorpora cuando haya trabajo por ítem con reintentos/diferido (M6) |
| Tiempo real | WebSocket (Socket.IO) con salas `org:{id}` y `user:{id}` | |
| Auth | `LocalAuthProvider` (Argon2id) detrás de `AuthProvider` | ADR-01 |
| Archivos | S3-compatible tras `StorageAdapter`, prefijo `org/{id}/`, URLs firmadas | |
| Correo transaccional | **[ABIERTO]** (Resend/SES/Postmark) tras `MailProvider` | Necesario para verificación y avisos de prueba |
| Pagos | **[ABIERTO]** pasarela tokenizada (PCI) tras `PaymentProvider` | La referencia mostraba AllDigital Pay; no confirmada |
| Observabilidad | Logs estructurados (pino) con `org_id`, `request_id`, redacción de PII · OpenTelemetry · Sentry | |
| Hosting/región | **Railway para dev/staging/piloto (ADR-30, aprobado 2026-10-05)**; producción y región se revalidan antes del piloto (latencia a Ecuador, residencia de grabaciones) | Bloquea el hito M0 solo para el despliegue, no para desarrollo local |

---

## 3. Estructura del repositorio **[PROPUESTA]**

```
sales-smart-2/
├─ CLAUDE.md
├─ docs/ (BUILD_SPEC.md, ADR.md, FLUJOS.md, legacy-audit/)
├─ spikes/         # pruebas descartables (no es código del producto)
├─ apps/
│  ├─ api/            # NestJS: HTTP + WebSocket
│  ├─ worker/         # NestJS standalone: BullMQ (mismo código de dominio)
│  └─ web/            # React + Vite
├─ packages/
│  ├─ shared/         # tipos, esquemas Zod, catálogo de permisos, eventos
│  └─ ui/             # componentes y tokens de tema
├─ prototype/         # sales-smart-2-prototipo.html (solo referencia)
└─ infra/             # docker-compose (pg, redis, minio, mailpit), CI
```

Módulos del backend (carpeta `apps/api/src/modules/*`), con **fronteras estrictas**: un módulo solo importa la API pública (`index.ts`) de otro; nunca sus repositorios.

`auth` · `organizations` (empresas, agencias, miembros, carteras, pruebas) · `rbac` · `audit` · `contacts` · `lists` · `custom-fields` · `pipelines` · `opportunities` · `conversations` (Inbox) · `channels` (adapters) · `messages` · `tags` · `queues` (reparto, catálogo) · `appointments` · `sales` · `commissions` · `dashboard` · `analytics` · `sla` · `attribution` (Meta CAPI + outbox) · `integrations-ghl` · `forms` · `agents` · `knowledge` (RAG) · `ai-credits` · `telephony` · `voice-ai` · `call-campaigns` · `automations` · `billing` · `platform` (Súper Admin: proveedores, planes, pruebas, accesos)

---

## 4. Multi-tenancy **[DECIDIDO — ADR Entrega 1 §5, ADR-11, 21, 22]**

### 4.1 Reglas inviolables
1. Toda tabla de negocio lleva `organization_id uuid NOT NULL` y una política RLS `organization_id = current_setting('app.org_id')::uuid`.
2. La aplicación **nunca** se conecta con un rol `BYPASSRLS` ni propietario de tablas. Cuatro roles de BD (enmienda ADR-25, aprobada 2026-10-04):
   - `app_owner`: solo migraciones (CI/CD).
   - `app_rw`: API y workers; RLS aplicada.
   - `app_identity`: solo **tablas de identidad** (§4.2); lo usan únicamente los módulos `auth` y `organizations` (`Database.withIdentity`, lint P12). Sin DELETE/TRUNCATE; sin acceso a tablas de negocio ni de plataforma.
   - `app_platform`: acceso a **tablas de plataforma** (sin `organization_id`: proveedores, precios de IA, planes, configuración de pruebas) y a consultas agregadas. Solo lo usa el módulo `platform` con guard `super_admin`.
3. Cada petición abre una transacción y ejecuta `SET LOCAL app.org_id = <org activa>` antes de cualquier consulta. Un `TenantContext` (AsyncLocalStorage) es obligatorio: los repositorios fallan si no existe.
4. Cada job de cola serializa `organization_id` y restablece el contexto al ejecutarse. Los jobs de plataforma (vencimiento de pruebas, purga) recorren organizaciones **una por una** con su contexto.
5. **Contexto activo** (agencia y Súper Admin): el token de acceso lleva `active_org_id`; cambiar de cuenta = emitir un nuevo token de acceso con otra organización, **tras validar** `organization_members` (agencia) o rol `super_admin`. Se valida en **cada** petición, no solo al cambiar.
6. Archivos: `org/{organization_id}/…`; URLs firmadas de corta duración; el nombre nunca viene del cliente.
7. Vector store: `organization_id` + `agent_id` como filtro obligatorio en toda recuperación.
8. Webhooks entrantes: se resuelven por un **identificador opaco por canal** (no por `organization_id` en la URL), con verificación de firma.

### 4.2 Tablas **sin** RLS por organización
**Identidad (ADR-25; rol `app_identity`):** `users` · `organizations` · `organization_members`; las futuras `auth_identities` · `sessions` · `refresh_tokens` · `agency_grants` entrarán en esta categoría (se añaden al catálogo del auditor al crearlas). Su aislamiento entre organizaciones se garantiza con lógica de aplicación + tests A↔B; `app_rw` y `app_platform` no tienen ningún privilegio sobre ellas.

**De plataforma (rol `app_platform`):**
`provider_credentials(service, provider, secrets_sealed, key_version, secret_hints, updated_by…)` y `provider_selection(service, provider)` (de plataforma; TODO valor cifrado con cifrado de sobre y nunca devuelto, solo los últimos 4: ADR-42; M2.6) · `ai_pricing` · `ai_org_pricing` (solo `super_admin`) · `access_sessions` (solo `super_admin`) · `platform_audit`. **`trials`, `trial_config` (ADR-33) `plans` (ADR-38) y `access_sessions` (ADR-41) son de identidad (corrige este listado):** el ciclo de vida de la prueba corre con `app_identity`. Se protegen por **rol de BD** + guard de aplicación, y tienen test que verifica que el rol `app_rw` no puede leerlas.

### 4.3 Tests de aislamiento (puerta de CI)
- Un test generado **por endpoint**: con dos organizaciones A y B, el usuario de A pide recursos de B por id, por filtro y por búsqueda → 404/vacío.
- Test de RLS directo en BD: con `app.org_id = A`, un `SELECT` sin filtro nunca devuelve filas de B.
- Test de que ninguna tabla de negocio carece de política RLS (consulta sobre `pg_policies` vs. `information_schema`).
- Lint: prohibido SQL crudo con interpolación; solo consultas parametrizadas.

---

## 5. Roles y permisos **[DECIDIDO — ADR-11, 16, 22]**

### 5.1 Roles
| Rol | Alcance |
|---|---|
| `super_admin` | Plataforma: agencias, carteras, planes, proveedores, créditos/márgenes, pruebas, accesos. Puede entrar a cualquier organización |
| `agency` | Organización tipo `agency`; ve «Mis clientes» y entra **solo** a los clientes de su cartera (`parent_agency_id = su org`), con nivel por cliente (sin acceso / solo lectura / asesor / administrador) |
| `client_admin` | Administra su organización |
| `advisor` | Ve sus chats y los que le compartieron; no ve filtro por asesor ni conversión por asesor. **[ADR-32 aprobado + enmienda 1]** Crea ventas y registra abonos de las suyas, pero no modifica valor/producto/comisión; ve «Mis ventas» y su comisión en solo lectura; campañas y grupos solo si el Cliente se los activa |

### 5.2 Catálogo de permisos (nombres canónicos, extensible)
`inbox.read` (**[M5.4, ADR-50]** ver; entra en el techo de solo lectura) · `inbox.view_all` · `inbox.reply` (**[M5.4]** aceptar, responder, notas, finalizar, marcar leída y reintentar; el asesor tiene `inbox.read` e `inbox.reply`) · `inbox.transfer` · `inbox.share` · `contacts.read|write|view_all|delete|import|export` · `companies.manage` (**[M3.6, ADR-48]** solo administrador: empresas de contactos) (**[M3.1, ADR-43]** sin `view_all` la persona ve y edita solo los contactos asignados a ella —el asesor crea los suyos—; `delete` solo el administrador; `view_all` es de solo lectura) · `opportunities.read|write` · `pipelines.manage` · `sales.create|cancel` · **[v9, ADR-32 aprobado]** `sales.read_own` · `sales.register_payment` (alcance propio, enmienda 1) · `custom_fields.manage` (**[M3.2, ADR-44]** solo el administrador; leer las definiciones va con `contacts.read` y llenar los valores con `contacts.write`) · `campaigns.send` (alcance: contactos propios/compartidos; tope diario por asesor) · `groups.view|send|manage` (`send` y `manage` requieren `view`) · `appointments.manage` · `queues.manage` · `tags.manage` · `agents.manage|test` · `knowledge.manage` · `channels.manage` · `integrations.manage` · `forms.manage` · `automations.manage` · `commissions.view|manage` · `analytics.view` · `export` · `team.manage` · `billing.manage` · **[M2.5, ADR-41]** `agency.clients.read|create` (solo el rol `agency` en su organización) · `platform.providers.manage` · `platform.agencies.manage` · `platform.trials.manage` · `platform.plans.manage` · `platform.companies.manage` · `platform.access_log.read`

Los permisos se evalúan en **un guard central**; la interfaz solo oculta, nunca protege. `commissions.view` admite alcance propio (el asesor solo ve la suya). La matriz rol→permiso sigue **PROVISIONAL** (ADR-29); los permisos [PROPUESTA v9] se añaden al catálogo por migración solo tras aprobar ADR-32.

---

## 6. Modelo de datos consolidado **[DECIDIDO + PROPUESTA]**

Convenciones: UUID v7, `created_at`, `updated_at`, `deleted_at` (borrado lógico donde aplique), `organization_id` + RLS en toda tabla de negocio, saldos **derivados** (nunca campos libres), dinero en `numeric(14,2)` + `currency`. Columnas `legacy_id`, `legacy_source` (nullable) en `contacts`, `companies`, `opportunities`, `conversations`, `messages`, `sales` (ADR-06).

### 6.1 Acceso y organizaciones
- `users` (email único, `password_hash` Argon2id, `email_verified_at`, `status`, **`full_name`, `phone` E.164 — capturados en el registro, ADR-34**) · `auth_identities(user_id, provider, external_id)` · `sessions` · `refresh_tokens` (rotativos) · `email_verifications` · `password_resets` · `session_events` · `invitations(organization_id, email, role, token_hash, expires_at, consumed_at, accepted_user_id, invited_by, sent_count, last_sent_at; única por (organización, correo); identidad, ADR-39; M2.3)`
- `organizations(kind ∈ platform|agency|client, parent_agency_id, created_by_agency_id, name, plan_id, status, timezone, **country (ISO 3166-1 alfa-2, NULL en el registro propio; obligatorio en el alta por invitación, ADR-39)**, …)` · `organization_members(user_id, organization_id, role, access_level, granted_by, revoked_at)` · `agency_grants` · `organization_ownership_history(organization_id, from_agency_id, to_agency_id, reason, notify_client, changed_by, changed_at; identidad, append-only; ADR-40; M2.4)` · `access_sessions(id, session_id, actor_user_id, actor_role, organization_id, started_at, ended_at, end_reason, ip_hash; identidad; solo la lee el Súper Admin; ADR-41; M2.5)` · `sessions.home_org_id` (origen de la sesión) · `organizations.agency_access_level ∈ read|advisor|admin` (nivel de la agencia en ese cliente; lo fija el Súper Admin). **Acceso de agencia (ADR-40):** una membresía `role='agency'` con `access_level ∈ read|advisor|admin` por persona de la agencia y cliente de su cartera; `reconcile` la mantiene; revocarla corta la sesión al instante
- `roles`, `permissions`, `role_permissions` (permisos por rol; roles de sistema + personalizados por organización en V1)
- `api_keys(hash, scope, expires_at, last_used_at)` (V1)

### 6.2 Pruebas y planes (ADR-23)
- `trials(organization_id, owner_user_id, started_at, ends_at, ext_status ∈ none|pending|approved|denied, ext_reason, ext_decided_by, ext_decided_at, ext_days_granted)` — **una extensión por cuenta**: restricción única en la lógica y `CHECK` sobre transiciones
- `trial_config` *(identidad, ADR-33; una sola fila)*: `days=7`, `extension_days=3`, `retention_days=30`, `welcome_credits=1000` — todo PROVISIONAL, solo en esta tabla
- `signup_attempts(email_hash, ip_hash, at, outcome)` (anti-abuso) · `disposable_domains`
- `plans(name único, description, max_users/max_connections/max_queues NULL=ilimitado, features jsonb, archived_at)` *(identidad, ADR-38; M2.2; `organizations.plan_id` con FK; sin precios)* · `subscriptions(organization_id, plan_id, status, current_period_end)`, `invoices` (V1, con Billing)

### 6.3 CRM
- `contacts(name, email, owner_id→users, source, consent ∈ unknown|granted|revoked, consent_updated_at, created_by, deleted_at)` y `contact_phones(contact_id, e164, is_primary, deleted_at)` — **M3.1, ADR-43**: teléfono E.164 único por empresa entre los vigentes (índice parcial), un solo principal por contacto, FK compuesta `(organization_id, contact_id)`, borrado lógico que libera el número; `app_rw` sin `DELETE`. La visibilidad por persona la aplica el servidor (alcance propio vs `contacts.view_all`), no la RLS; **M3.3:** atribución de Meta Ads en `contacts` (`ctwa_cl_id`, `first_touch_*` inmutable, `last_touch_*`) · `companies` · `contact_companies` · `contact_lists(name, kind ∈ dynamic|fixed, filters, columns, sort, owner_id, shared, deleted_at)` y `contact_list_members(list_id, contact_id)` (**M3.4, ADR-46**: una sola noción para «vistas» y «listas»; personales por defecto, compartir exige `contacts.view_all`; una lista nunca amplía lo que la persona puede ver)
- `custom_field_definitions(entity ∈ contact|opportunity|company, name, var_key, type, options, required, show_in_form, position, archived_at)` y `custom_field_values(entity, entity_id, definition_id, value_text|number|bool|date|datetime|json)` — **M3.2, ADR-44**: 13 tipos (texto, texto largo, número, moneda, porcentaje, fecha, fecha y hora, Sí/No, correo, teléfono, URL, selección única y múltiple; «Archivo» espera al almacenamiento); la variable `{{contact.clave}}` se genera del nombre, es única por empresa y entidad (incluso archivados) y no cambia; el tipo no cambia; se archiva, no se borra; un valor por fila con FK compuesta a la definición y vaciar deja la fila en NULL; `required ⇒ show_in_form`; tope de 50 campos por entidad (provisional). `contact_imports(file_name, file_hash, status ∈ staging|ready|running|done|cancelled, total_rows, headers, mapping, options, created_by, legal_basis_at, contadores)` y `contact_import_rows(import_id, row_no, data, status, reason, contact_id)` — **M3.5, ADR-47**: huella SHA-256 única por empresa entre las no canceladas (un archivo no se importa dos veces), filas en preparación que se vacían al terminar las creadas/actualizadas, `app_rw` sin `DELETE`. Los índices por tipo para filtrar se crearon en M3.4 (ADR-46); la columna `validation` sigue pendiente · `saved_views` *(no se crea: se unifica con `contact_lists`, ADR-46)*
- `pipelines(name, position, appointment_stage_id)` · `pipeline_stages(pipeline_id, name, position, kind ∈ open|won|lost, is_hidden, color)` · `opportunities(pipeline_id, stage_id, contact_id, amount, currency, owner_id, status, lost_reason, closed_at)` · `opportunity_field_overrides` *(aplazado)* · `stage_history(opportunity_id, from_stage_id, to_stage_id, user_id, origin, at)` — **M4.1, ADR-49**: borrado lógico en pipelines, etapas y oportunidades; una etapa ganada por pipeline y a lo sumo una perdida; nombres únicos sin distinguir mayúsculas; color = clave de una paleta de 8 pasteles; a lo sumo una oportunidad abierta por contacto y pipeline; `stage_history` solo de inserción
- `tags(name, color, is_system, system_key ∈ lead|appointment|sale, deleted_at)` y `contact_tags(contact_id, tag_id, set_by ∈ system|user)` (**M3.3, ADR-45**: las tres etiquetas del sistema se crean en cada empresa al primer uso, no se borran ni se renombran y solo las pone el sistema; las personalizadas llegan en M3.4) · `companies(name, website, phone, email, created_by, deleted_at)` y `contact_companies(contact_id, company_id)` (**M3.6, ADR-48**: nombre único sin distinguir mayúsculas entre las vigentes, hasta 5 empresas por contacto, el pivote admite DELETE) · `notes(contact_id | company_id, body, author_id, edited_at, deleted_at)` y `tasks(title, description, due_at, status ∈ open|done, completed_at, completed_by, assignee_id, contact_id?, company_id?, created_by, deleted_at)` (**M3.6**: borrado lógico; la nota es de un contacto o de una empresa, la tarea de a lo sumo uno) · `activities` · `assignments`

### 6.4 Inbox y canales
- `channels` · `channel_accounts(provider, is_official, credentials_encrypted, status, settings)` · `whatsapp_accounts(waba_id, phone_number_id)` · `qr_sessions` — **[M5.1, ADR-50: construidas `channel_accounts(provider ∈ meta_cloud|evolution, is_official, name, status ∈ active|disabled, credentials_sealed + key_version [bóveda de ADR-42, AAD «channel/<id>»], token_last4, settings, deleted_at)` y `whatsapp_accounts(channel_account_id, waba_id, phone_number_id, active, display_phone, verified_name, last_check_at, last_error)` —un número activo solo en una conexión— más la tabla de identidad `channel_routes(phone_number_id → organization_id, channel_account_id, active)` con la que el webhook único de Meta (M5.2) resuelve la empresa; sin DELETE: desconectar es borrado lógico que borra las credenciales y libera el número]**
- `conversations(contact_id, channel_account_id, owner_id, queue_id, status, close_reason, last_message_at)` — **única parcial** para impedir duplicadas abiertas (+ advisory lock) **[M5.2/M5.3, ADR-50: construida `conversations(contact_id, channel_account_id, queue_id, owner_id, assigned_at, status ∈ unassigned|pending|working|waiting|closed, last_message_at, last_inbound_at, unread_count)` (salvo `closed`, hay dueño ⇔ el estado no es `unassigned`) con el índice único parcial «una abierta (≠ closed) por contacto y canal» y el candado por (contacto, canal); `owner_id` y `queue_id` llegaron con M5.3; **M5.4** añade `peer_id` (a quién se le responde) y `closed_at`; el motivo de cierre (`close_reason`) llega con las ventas y las citas (M6)]**
- `webhook_events(channel_account_id, phone_number_id, payload jsonb, payload_hash único por empresa, status ∈ pending|done|failed, attempts, next_attempt_at, last_error, processed_at, redacted_at)` **[M5.2, ADR-50 #4]** — el aviso CRUDO de Meta ya asignado a su empresa (solo la parte de UN número); lo procesa la tarea `webhook-events` con `SKIP LOCKED`, reintentos con espera creciente (máx. 5) y SAVEPOINT por aviso; el contenido se vacía a los 30 días (provisional)
- `messages(external_id, channel_account_id, direction, sender_type ∈ human|ai|campaign|automation|system, body, status, sent_at)` — **único** `(channel_account_id, external_id)` **[M5.2, ADR-50: construida `messages(conversation_id, channel_account_id, external_id, direction ∈ in|out, sender_type ∈ contact|human|ai|campaign|automation|system, kind, body, media, meta, status ∈ received|queued|sent|delivered|read|failed|internal, error, sent_at, delivered_at, read_at, created_by, attempts, next_attempt_at)`; CHECK «entra ⇔ lo escribe el contacto» y «nota ⇔ estado `internal`» (M5.4: ninguna ruta de envío puede tomar una nota; la reacción del cliente a un mensaje vive en `meta.reaction` y `meta.reaction_at` de ese mensaje), único parcial `(canal, external_id)`; sin DELETE; los adjuntos entrantes guardan solo la referencia (`media`) hasta M5.6]** · `message_attachments` **[M5.6d, ADR-50: construida `message_attachments(id, conversation_id, message_id NULL→único, direction∈in|out, kind∈image|video|audio|document|sticker, mime_type, filename, size_bytes, storage_key, checksum, state∈pending|ready|infected|failed|expired, scan_status∈pending|clean|skipped|infected|error, source_media_id, error, attempts, next_attempt_at, created_by)`; RLS forzada + `FORCE ROW LEVEL SECURITY`; `app_rw` solo `SELECT, INSERT, UPDATE`; sin DELETE; `message_id` único por mensaje; `state=ready` exige `storage_key` + `scan_status∈clean|skipped`; clave `org/<orgId>/attachments/<uuid>`; migraciones `0058`/`0059`]** · `scheduled_messages` · `quick_messages` · `whatsapp_templates`
- **[PROPUESTA v9, V1, solo canal QR]** `wa_groups(channel_account_id, external_id, name, description, settings)` · `wa_group_participants(group_id, phone, is_admin, contact_id?)` · `wa_group_scheduled_messages(group_id, body, attachments, mention_all, schedule, recurrence_rule, status)`. Todas con `organization_id` y RLS. Los grupos son de toda la organización; el acceso por asesor lo da `groups.*` (asignación por asesor: pendiente §15 #16).
- `conversation_participants(role ∈ owner|collaborator, permission ∈ reply|view, revoked_at)` **[M5.5a, ADR-14/50: construida SOLO con los colaboradores —el dueño sigue siendo `conversations.owner_id`—: `conversation_participants(conversation_id, user_id, permission ∈ reply|view, added_by, added_at, revoked_at, revoked_by)`, un acceso vigente por persona y conversación (índice único parcial), sin DELETE; y `conversations.assignment_source ∈ distribution|manual` (el tope diario de la cola solo cuenta lo que repartió el reparto automático)]**
- `response_timers` · `sla_policies` · `business_hours` · `holidays` **[M5.5b, ADR-07/50: construidas, RLS forzada. `sla_policies(target_minutes, risk_minutes)` una por empresa; `business_hours(scope ∈ org|queue, queue_id, days)` con siete arreglos (domingo = 0) de tramos en minutos desde la medianoche local; `holidays(day, name, yearly, deleted_at)` con borrado lógico; `response_timers(conversation_id, kind ∈ first|followup, owner_id, started_at, due_at, reassign_at, stopped_at, stop_reason ∈ human_reply|closed|transferred|reassigned, response_seconds, replied_message_id)` con un único cronómetro abierto por conversación y sin DELETE. Columnas nuevas: `queues.respect_hours|reassign_minutes|max_rotations` y `conversations.rotations|tried_owners`. Permiso `sla.manage`]**
- `message_templates(channel_account_id, external_id, name, language, category ∈ marketing|utility|authentication|other, status ∈ approved|pending|rejected|paused|disabled|other, parameter_format, components, body_text, variables, sendable, unsupported_reason, rejected_reason, synced_at, deleted_at)` **[M5.6a, ADR-50: construida, RLS forzada, sin DELETE; única `(conexión, nombre, idioma)`; las plantillas se crean y aprueban en Meta y aquí solo se sincronizan por conexión; `whatsapp_accounts.templates_synced_at|templates_sync_error`]**

### 6.5 Colas, citas, ventas
- `queues(name, color, status, default_pipeline_id, schedule, messages)` · `queue_members(queue_id, user_id, active, weight)` · `queue_distribution_rules` · `queue_distribution_state` · `queue_products(queue_id, name, kind, price, active)` **[M5.3, ADR-07/50: construidas `queues(name, color, distribution_on, mode ∈ equal|weighted|load, batch, daily_cap, only_unassigned, deleted_at)` —las reglas de reparto van en la propia fila, una por cola—, `queue_members(queue_id, user_id, active, weight 1–100)` y `queue_distribution_state(queue_id, state jsonb)` (se bloquea al asignar); `channel_accounts.queue_id` es la cola por defecto de la conexión; sin DELETE. El horario y la reasignación llegaron con M5.5b y los mensajes de la cola con M5.5c (`greeting_text`, `out_of_hours_text`, `auto_close_hours`); `queue_products`, con M6]**
- `appointments` · `appointment_reminders(offset_minutes, channel, status, scheduled_at, sent_at)` · `appointment_reminder_limits` (config por organización: 3 / 5 para QR, Messenger, Instagram)
- `sales(amount, currency, queue_id, product_id, conversation_id, status, created_by)` · `sale_payments(sale_id, amount, method, paid_at)` · `sale_status_history` (nunca se borra) · saldo = `amount − Σ sale_payments` · **[ADR-32 enmienda 1]** `sale_payments` append-only (el asesor solo inserta, con `created_by`); sin «pago de comisión» por ahora (`commission_payouts` diferido) · `sale_change_requests(sale_id, requested_by, reason, status, resolved_by)`: el asesor pide corrección; solo quien tenga permiso de gestión de ventas la resuelve
- `commission_plans` (parámetros versionados en JSONB, `reversal_rule` desactivada por defecto) · `commission_plan_assignments` · `commissions` · `commission_splits` · `commission_payouts` · `goals`

### 6.6 Atribución y eventos
- `domain_events` (**outbox**, escrita en la misma transacción) · `meta_events(event_id único por org, type, status ∈ pending|sent|skipped|blocked|failed|expired|cancelled, attempts, send_after)` **[M3.3, ADR-45: tabla, puerto `CapiProvider` con fake y tarea de envío; el adaptador real y el disparo de Purchase llegan en M6]** · `attribution_endpoints(id opaco, organization_id, secret_hash)` *(identidad; punto de entrada del webhook de atribución)* · `meta_settings` (ventana de gracia, evento personalizado `SaleCanceled`) · `ctwa_clicks`
- `lead_attribution(utm, fbclid, ctwa_clid, page)`

### 6.7 Integraciones
- `ghl_connections(auth_type, token_encrypted, webhook_secret, location_id)` · `ghl_sync_state` · `external_ids` · `webhook_endpoints` · `webhook_deliveries` (idempotencia y reintentos)

### 6.8 IA
- `agents` y `agent_documents`, `agent_channels(channel_id UNIQUE)`, `agent_test_runs` (ADR-20) · `ai_conversation_state` (activo/pausado + motivo + versión) · `ai_tool_calls` · `knowledge_bases` · `knowledge_documents(status)` · `document_chunks(embedding vector, organization_id)`
- Créditos: `ai_wallets(balance_cache)` · `ai_ledger(kind ∈ use|topup|welcome|grant|test, credits, amount_usd, cost_usd, margin_pct, ref)` · `ai_packages` · `ai_auto_topup` · `payment_methods(processor_token, brand, last4, exp)` (ADR-19)

### 6.9 Formularios, telefonía, campañas (V1/V2)
**[PROPUESTA v9, V2]** `campaigns(connection_id, mode ∈ template|free_text, template_id?, body?, scheduled_at, status, created_by)` · `campaign_recipients(campaign_id, contact_id, status, error)` · límite diario por usuario (ajuste por membresía, por definir) · regla de «no contactar». `forms` · `form_fields` · `form_submissions` (único `(form_id, idempotency_key)`) · `telephony_accounts` · `phone_numbers` · `calls` · `call_events` · `recordings` · `transcriptions` · `call_summaries` · `call_campaigns` · `call_campaign_items` · `call_attempts` · `automations` + `automation_*` + `automation_runs`

### 6.10 Preferencias y auditoría
`user_dashboard_prefs(layout, hidden, default_range)` · `user_nav_pins` · `audit_logs(entity_type, entity_id, field, old_value, new_value, actor_user_id, acting_as, acting_org_id, source ∈ manual|ai|automation|ghl|meta|api, at)` **append-only** (revocar `UPDATE`/`DELETE` al rol de la app) · `platform_audit`

### 6.11 Reglas de integridad críticas
1. `messages (channel_account_id, external_id)` único.
2. Etiquetas del sistema no se borran ni renombran; **Venta** y **Cita agendada** solo las pone el sistema (ADR-08).
3. Una etapa ganada no se oculta ni se elimina sin reasignar; eliminar etapa con oportunidades las mueve a la anterior (ADR-12, 18).
4. El saldo de una venta y el saldo de créditos son **derivados**; descontar créditos es una transacción con bloqueo por organización (ADR-19).
5. Cambiar una oportunidad de «ganada» a otra etapa no borra la venta.
6. Mover un cliente de agencia solo cambia `parent_agency_id` y cierra las membresías de la agencia anterior en ese instante (ADR-22).
7. Una prueba solo admite una extensión; transición válida: `none → pending → approved|denied`.

---

## 7. Contrato de API **[PROPUESTA]**

- REST JSON versionado `/v1`, OpenAPI generado desde esquemas Zod de `packages/shared`.
- Autenticación: access token corto (15 min) + refresh rotativo revocable; cookie `HttpOnly` para la web.
- **Paginación por cursor**; filtros declarativos; ordenamiento con lista blanca de columnas.
- **Errores**: `{ "error": { "code": "...", "message": "...", "request_id": "...", "details": [] } }`. Mensajes de autenticación **genéricos** (no revelan si existe el correo).
- **Idempotencia**: cabecera `Idempotency-Key` en creación de ventas, pagos, envíos de formularios y webhooks.
- **Rate limit** por IP, por organización y por token; límites más estrictos en `/auth/*` (bloqueo tras 5 intentos fallidos con espera creciente).
- **Webhooks**: firma obligatoria, `200` inmediato y procesamiento asíncrono; reintentos con backoff.
- Tiempo real: eventos `conversation.updated`, `message.created`, `opportunity.moved`, `call.state`, `trial.extension_requested` (a salas por organización/usuario; el aviso de extensión va a la sala `platform`).

Endpoints de plataforma y de auth mínimos del MVP:
`POST /auth/signup` · `POST /auth/verify` · `POST /auth/resend` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/forgot` · `POST /auth/reset` · `POST /auth/password` (autenticado, ADR-28) · `GET /auth/me` (autenticado, M1.6/ADR-34) · `POST /context/switch {target|null}` · `GET /context/options` (clientes a los que se puede entrar) · `GET /platform/access-sessions` (solo Súper Admin) · `PUT /platform/organizations/:id/agency-access` · `GET /platform/providers` · `PUT /platform/providers/:service/active` · `PUT|DELETE /platform/providers/:service/:provider/credentials` (solo Súper Admin; M2.6, ADR-42) · `GET|POST /agency/clients` · `POST /agency/clients/:id/invitation/resend` (M2.5, ADR-41) · `GET /trials/me` · `POST /trials/me/extension` · `POST /platform/companies` (alta de empresa + invitación del dueño) · `POST /platform/companies/:id/invitation/resend` · `POST /auth/invitations/preview` · `POST /auth/invitations/accept` (públicos; M2.3, ADR-39) · `GET|POST /platform/plans`, `PATCH /platform/plans/:id`, `POST /platform/plans/:id/archive|restore`, `GET /platform/companies`, `PUT /platform/companies/:id/plan` (M2.2, ADR-38) · `GET /platform/trials` (M1.5; devuelve `items`, `next_cursor`, `pending_extensions` y `summary` con totales globales; el `POST` del borrador queda sin definir: la prueba nace sola al verificar el correo), `POST /platform/trials/:id/approve|deny` · `GET|POST /platform/agencies`, `POST /platform/agencies/:id/suspend|reactivate`, `GET /platform/agencies/:id/history`, `PUT /platform/organizations/:id/agency` (M2.4, ADR-40) · `GET /platform/access-sessions` · `GET|POST /contacts`, `GET /contacts/owners`, `GET|PATCH|DELETE /contacts/:id` (M3.1, ADR-43; lista con cursor, `q`, `owner=me|none|<id>`, `sort`/`order`; la respuesta trae `access {view_all, write, delete}`; 409 `PHONE_TAKEN`, 403 `OWNER_NOT_ALLOWED`) · `GET|POST /custom-fields`, `PUT /custom-fields/order`, `PATCH /custom-fields/:id`, `POST /custom-fields/:id/archive|restore` (M3.2, ADR-44; el listado trae `access {manage}`; los contactos reciben y devuelven `custom_fields {variable: valor}`; 409 `CUSTOM_FIELD_EXISTS|KEY_RESERVED|LIMIT|ARCHIVED|ORDER_STALE`) · `GET /tags` · `GET|POST /attribution/endpoint` · `POST /attribution/ctwa/:endpointId` (público; cabecera `X-Webhook-Secret`; idempotente por `ctwa_cl_id`) (M3.3, ADR-45; los contactos devuelven `tags` y `attribution`) · `POST /tags`, `PATCH|DELETE /tags/:id` (`tags.manage`), `GET|POST /contact-lists`, `PATCH|DELETE /contact-lists/:id`, `POST /contact-lists/:id/members[/remove]` y, en `GET /contacts`, los filtros `consent`, `tag` (todas), `cf=variable:operador[:valor]` y `list=<id>`; `tag_ids` en el alta y la edición de contactos (M3.4, ADR-46) · `GET|POST /contact-imports`, `GET|PATCH /contact-imports/:id`, `POST /contact-imports/:id/rows|start|process|cancel`, `GET /contact-imports/:id/preview|report` (CSV de omitidas y rechazadas) y `POST /contacts/export` (CSV con BOM; cabecera `X-Export-Count`) (M3.5, ADR-47; solo `contacts.import`/`contacts.export`, es decir el administrador; 409 `IMPORT_DUPLICATE_FILE|IMPORT_ROW_OUT_OF_ORDER|IMPORT_NOT_STAGING|IMPORT_NOT_READY|IMPORT_NOT_RUNNING|IMPORT_LOCKED`, 400 `EXPORT_TOO_LARGE`); la respuesta de `GET /contacts` trae además `access.import` y `access.export` · `GET|POST /companies`, `GET|PATCH|DELETE /companies/:id`, `GET|POST /companies/:id/contacts`, `POST /companies/:id/contacts/remove`, `GET|POST /companies/:id/notes`, `POST|DELETE /contacts/:contactId/companies/:companyId`, `GET|POST /contacts/:contactId/notes`, `PATCH|DELETE /notes/:id`, `GET|POST /tasks`, `GET|PATCH|DELETE /tasks/:id`, `POST /tasks/:id/complete|reopen` (M3.6, ADR-48; ver con `contacts.read`, notas y tareas con `contacts.write`, crear/editar/borrar empresas y vincular contactos con `companies.manage` —solo el administrador—; 409 `COMPANY_EXISTS|COMPANY_LIMIT`, 403 `NOTE_NOT_YOURS|TASK_NOT_YOURS|TASK_SCOPE|TASK_ASSIGNEE_NOT_ALLOWED`); los contactos devuelven `companies` · `GET|POST /pipelines`, `PUT /pipelines/order`, `PATCH|DELETE /pipelines/:id`, `POST /pipelines/:id/stages`, `PUT /pipelines/:id/stages/order`, `PATCH|DELETE /pipeline-stages/:id` · `GET|POST /opportunities`, `GET|PATCH|DELETE /opportunities/:id`, `POST /opportunities/:id/move`, `GET /pipelines/:id/summary` (M4.2, ADR-49; ver con `opportunities.read`, operar con `opportunities.write` —también el asesor, con alcance propio—; 409 `OPPORTUNITY_OPEN_EXISTS|STAGE_HIDDEN`; el monto es texto con 2 decimales) (M4.1, ADR-49; ver con `opportunities.read`, configurar con `pipelines.manage` —el administrador—; el listado trae las etapas, también las ocultas, y `access {manage, write}`; 409 `PIPELINE_EXISTS|PIPELINE_LIMIT|PIPELINE_LAST|PIPELINE_HAS_OPPORTUNITIES|STAGE_EXISTS|STAGE_LIMIT|STAGE_KIND_TAKEN|STAGE_KIND_HAS_OPPORTUNITIES|STAGE_WON_REQUIRED|STAGE_WON_HIDDEN|STAGE_LAST_OPEN|STAGE_HAS_CLOSED_OPPORTUNITIES|*_ORDER_STALE`) · `GET|POST /channels`, `PATCH|DELETE /channels/:id`, `POST /channels/:id/check` (M5.1, ADR-50; solo `channels.manage` —el administrador; una agencia con nivel «administrador» también, con «lectura» no—; el listado trae `vault {available}`; al conectar y al cambiar el token el servidor consulta a Meta y rechaza lo que no sirve; el token nunca se devuelve, solo `token_last4`; 400 `CHANNEL_TOKEN_INVALID|CHANNEL_NUMBER_NOT_FOUND`, 409 `CHANNEL_EXISTS|CHANNEL_NUMBER_IN_USE|CHANNEL_LIMIT|CHANNEL_CREDENTIALS_UNREADABLE`, 503 `CHANNEL_VAULT_UNAVAILABLE|CHANNEL_PROVIDER_UNAVAILABLE`; las conexiones traen `last_event_at`, la hora del último aviso de Meta) · `GET|POST /channels/meta/webhook` (M5.2, ADR-50 #2; PÚBLICO, un solo webhook para todas las empresas: la empresa sale del `phone_number_id` del aviso, nunca de la URL; el POST se lee crudo y se verifica con `X-Hub-Signature-256` —HMAC-SHA256 con el secreto de la app de la plataforma—; el GET devuelve el desafío como texto plano solo con el token de verificación correcto; 403 `WEBHOOK_REJECTED`, 503 `WEBHOOK_NOT_CONFIGURED`, 413, 429 tras 30 fallos por minuto desde una IP; un número desconocido responde 200 sin efecto) · `GET /platform/providers` trae `webhook_url` en WhatsApp oficial · `GET|POST /queues`, `PATCH|DELETE /queues/:id`, `PUT /queues/:id/members`, `POST /queues/:id/simulate`, `POST /queues/:id/distribute` y `queue_id` en las conexiones (M5.3, ADR-07/50; solo `queues.manage` —el administrador—; el listado trae por cola sus asesores con peso y carga, sus conexiones y los «sin asignar»; 409 `QUEUE_EXISTS|QUEUE_LIMIT|QUEUE_IN_USE|QUEUE_DISTRIBUTION_OFF`, 400 `CHANNEL_QUEUE_NOT_FOUND`) · `GET /conversations`, `GET /conversations/options`, `GET /conversations/:id`, `GET /conversations/:id/messages`, `POST /conversations/:id/messages|notes|accept|take|close|read`, `POST /messages/:id/retry` (M5.4, ADR-16/50; ver con `inbox.read` —con `inbox.view_all` todas las conversaciones de la empresa, sin él solo las asignadas a la persona—, escribir con `inbox.reply`; lo que no se ve responde 404; el listado lleva pestañas `tab=working|pending|closed`, filtros `owner|queue|channel|tag|unread|q`, cursor y, en la primera página, `counts`; cada conversación trae `window {open, expires_at}` y `can {reply, note, accept, take, close}`; responder devuelve el mensaje con su estado `queued|sent|failed`; 409 `WINDOW_CLOSED|CONVERSATION_CLOSED|CONVERSATION_UNASSIGNED|CONVERSATION_STATE|CHANNEL_DISABLED|MESSAGE_NOT_FAILED`, 403 `NOT_OWNER|NOT_ASSIGNABLE`) · `GET /conversations/:id/transfer-options`, `POST /conversations/:id/transfer`, `POST /conversations/:id/share`, `DELETE /conversations/:id/participants/:userId` (M5.5a, ADR-14/50; transferir con `inbox.transfer`, compartir y quitar el acceso con `inbox.share` —el asesor y el administrador—; solo su dueño o quien ve todo, y quitar también la propia persona; transferir deja la conversación «pendiente» para el destinatario y mueve el lead; las conversaciones traen `participants`, `my_access` y `can.transfer|share`; 409 `ALREADY_OWNER|PARTICIPANT_LIMIT|CONVERSATION_NOT_ACCEPTED`, 400 `TRANSFER_TARGET_NOT_ALLOWED|SHARE_TARGET_NOT_ALLOWED`) · `GET /channels/:id/templates` · `POST /channels/:id/templates/sync` (`channels.manage`) · `GET /conversations/:id/templates` · `POST /conversations/:id/template` (`inbox.reply`; M5.6a, ADR-50: plantillas de WhatsApp sincronizadas desde Meta por conexión y envío con variables dentro o fuera de las 24 h; 409 `TEMPLATE_NOT_AVAILABLE|CHANNEL_TOKEN_INVALID|CHANNEL_NUMBER_NOT_FOUND`, 400 con `params.<variable>` si un valor no vale) · `GET /quick-replies` (`inbox.read`) · `POST /quick-replies` · `PATCH /quick-replies/:id` · `DELETE /quick-replies/:id` (`inbox.reply`; compartir y cambiar las compartidas exige `quick_replies.manage`; M5.6b, ADR-50; 409 `QUICK_REPLY_EXISTS|QUICK_REPLY_LIMIT`, 403 `QUICK_REPLY_SHARE_NOT_ALLOWED|QUICK_REPLY_NOT_YOURS`) · `GET /conversations/:id/quick-replies` (`inbox.reply`: las que la persona puede usar, ya resueltas con los datos del contacto de la conversación) · `GET /conversations/:id/scheduled` (`inbox.read`) · `POST /conversations/:id/scheduled` · `DELETE /conversations/:id/scheduled/:scheduledId` (`inbox.reply`; M5.6c, ADR-50: mensajes programados, solo dentro de la ventana de 24 h; 409 `SCHEDULE_OUTSIDE_WINDOW|SCHEDULE_LIMIT|SCHEDULE_NOT_PENDING`, 403 `SCHEDULE_NOT_YOURS`) · `GET /sla` · `PUT /sla/policy` · `PUT /sla/hours` · `POST /sla/holidays` · `DELETE /sla/holidays/:id` (`sla.manage`) · `PUT /queues/:id/hours` (`queues.manage`) (M5.5b, ADR-07/50: política de respuesta, horario semanal de la empresa —`days: null` = abierta siempre— y de una cola, y feriados; la conversación trae `sla` y la lista acepta `?sla=late|risk|ok`; la cola trae `respect_hours`, `reassign_minutes`, `max_rotations`, `hours` y `open_now`; 409 `HOLIDAY_EXISTS|HOLIDAY_LIMIT`)

---

## 8. Eventos de dominio y outbox **[DECIDIDO]**

Se escriben en `domain_events` dentro de la transacción de negocio; un worker los publica. Lista inicial:
`contact.created` · `lead.created` · `conversation.opened|assigned|transferred|shared|closed` · `message.received|sent` · `appointment.created` · `sale.created|cancelled` · `payment.received` · `opportunity.stage_changed` · `form.submitted` · `trial.started|extension_requested|extension_decided|expired` · `agency.client_added|removed` · `credits.granted|used`

Consumidores: atribución Meta (`lead.created`→Lead, `appointment.created`→Schedule, `sale.created`→Purchase con ventana de gracia, `sale.cancelled`→cancela el job o emite `SaleCanceled` opcional), etiquetas del sistema, SLA, automatizaciones, auditoría, correo/notificaciones.

---

## 9. Adaptadores (interfaces) **[DECIDIDO — ADR-01..05, 19]**

| Interfaz | Implementaciones | Notas |
|---|---|---|
| `AuthProvider` | `LocalAuthProvider` (ahora), `ClerkAuthProvider` (posible) | `user.id` interno siempre |
| `WhatsAppProvider` | `MetaCloudProvider`, `EvolutionProvider` (QR, **no oficial**, marcado en datos y UI) | El núcleo solo habla `NormalizedMessage`. **[PROPUESTA v9]** Capacidad opcional `groups` (listar/crear grupos, participantes, enviar a grupo): solo `EvolutionProvider`; `MetaCloudProvider` no la implementa (verificar §15 #15). Capacidad `campaign_mode`: la conexión oficial exige plantilla aprobada, la QR admite texto libre con límites bajos |
| `TelephonyProvider` | `TwilioProvider` | Preparado para Telnyx/SIP |
| `VoiceAIProvider` | `RetellProvider`, `VapiProvider` | Decide el PoC |
| `AIProvider` | OpenAI (clave de plataforma) | «Usar mi propia clave» por organización |
| `StorageAdapter` · `VectorStore` · `MailProvider` · `PaymentProvider` | S3-compatible · pgvector · por definir · por definir | |
| `GhlAuth` | `PrivateTokenProvider` (ahora), `OAuthProvider` (solo diseñado) | Con Private Token no hay suscripción de webhooks: el Workflow sigue manual |

Cada adaptador tiene **un fake** para pruebas y un **contract test** que ambos deben pasar.

---

## 10. Reglas de negocio por módulo (resumen verificable)

Cada regla enlaza su ADR; los criterios de aceptación completos están en la sección 14.

- **Acceso y prueba (ADR-23):** autorregistro crea organización + usuario `client_admin`; la prueba arranca al **verificar el correo**; 7 días con todo habilitado y sin tarjeta; una extensión de 3 días solicitada con motivo → pendiente → Súper Admin aprueba/rechaza (insignia, pestaña Pruebas, correo). Aprobada antes del vencimiento suma al fin; después, cuenta desde la aprobación. Al vencer: cuenta en pausa (solo lectura mínima y pantalla de planes), datos retenidos 30 días y luego purga programada con aviso previo. Anti-abuso: dominios desechables, correo duplicado, captcha real, límite por IP, mensajes genéricos.
- **Agencias y carteras (ADR-11, 18, 22):** solo el Súper Admin crea agencias y mueve clientes entre carteras; facturación siempre del cliente; agencia retirada → clientes a administración directa; el historial de **accesos** solo lo lee el Súper Admin; la marca «actuando como» **sí** es visible al cliente en su auditoría.
- **Reparto (ADR-07):** configurado por cola (modo, pesos por miembro, lote, tope diario, reasignación, solo no asignados, horario); ponderado suave con créditos persistidos y rotación atómica.
- **Etiquetas, venta y catálogo (ADR-08):** ver §6.11; Purchase a Meta con el **total**; comisión sobre el total con reversión configurable (ADR-18).
- **Meta CAPI (ADR-18):** `event_id` estable, `event_time` real (≤7 días), ventana de gracia configurable (defecto 30–60 min, máx. 24 h) como job diferido cancelable; Lead por cada clic nuevo; hash SHA-256 de datos del usuario; 5 reintentos con backoff; `SaleCanceled` opcional y apagado por defecto. **Validar en Events Manager antes de construir** si un evento enviado puede retirarse.
- **Pipelines (ADR-12, 18):** múltiples; etapas editables/ocultables; etapa de cita opcional; `Schedule` se dispara por la cita.
- **Citas (ADR-13):** tope de 3 recordatorios, 5 si la fuente/canal es QR, Messenger o Instagram; validado **en servidor**; estado de entrega visible.
- **Transferir/compartir (ADR-14):** transferir cambia dueño (SLA y comisión); compartir no; visibilidad `owner_id = yo OR participante activo` aplicada en servidor y RLS. **[M5.5a y M5.5b: construido; el cronómetro del SLA pasa al nuevo y la reasignación por no responder reinicia el ciclo, ver ADR-50]**
- **Composer (ADR-17):** notas internas nunca salen al cliente; fuera de 24 h en WhatsApp oficial solo plantillas; adjuntos por URL firmada + antivirus.
- **Créditos IA (ADR-19):** margen y costo solo en servidor y solo legibles por `super_admin`; saldo derivado del libro; descuento atómico; alerta de saldo bajo y de límite de OpenAI.
- **Agentes (ADR-20):** un agente por canal; documentos de la misma organización; la prueba no envía mensajes reales ni crea contactos y consume créditos como `kind = test` **[PROPUESTA]**; un agente sin documentos no inventa datos.
- **Formularios (ADR-09):** token público de solo envío, dominios autorizados, límite por IP, trampa + captcha, validación en servidor, mismo `event_id` en Pixel y CAPI.
- **Llamadas masivas (ADR-10):** progresivo y vista previa; sin predictivo; resultado obligatorio por llamada; grabación solo con aviso.
- **Analítica y exportación (ADR-18):** cada pestaña con «ver reporte» y CSV; exportar exige permiso `export` y queda en auditoría; **conversión lead→venta por cohorte** con muestra mínima de 20 leads para el ranking.

---

### 10.1 Reglas derivadas del prototipo v9 **[PROPUESTA v9 — requieren ADR-32]**
- **Ventas del asesor (ADR-32 + enmienda 1):** el asesor crea ventas (`sales.create`) y **registra abonos** de las suyas (`sales.register_payment`: fila append-only; abono > saldo se rechaza; saldo y «cobrada» los calcula el servidor; queda en `audit_logs`). No modifica valor, producto, comisión ni plan; la corrección se pide con `sale_change_requests`. Ninguna API de edición de venta acepta al rol `advisor`. No existe «pago de comisión» visible por ahora.
- **Alta manual de contacto:** «+ Contacto» con campos estándar y personalizados; teléfono único por empresa (E.164); origen `manual` en auditoría; el asesor solo crea contactos asignados a sí mismo. El administrador gestiona los campos extra (tipo, opciones, obligatorio, visible en el formulario) con `custom_fields.manage`.
- **Acceso a contactos del asesor:** «Mis contactos» (propios) + «Compartidos»; extiende ADR-14 (hoy definido para conversaciones) a contactos; se aplica en servidor y RLS.
- **Campañas (V2):** el tipo de conexión decide el modo: oficial ⇒ plantilla aprobada; QR ⇒ texto libre con límites bajos. Límite efectivo = mínimo(tope del asesor, tope de la conexión). Se respeta «no contactar».
- **Grupos (V1, solo QR):** sin proveedor QR no hay módulo de grupos; el envío programado y recurrente corre en el worker (idempotente); `@todos` y adjuntos según capacidad del proveedor.
- **Interfaz:** el botón Enviar y Enter envían (Shift+Enter = salto de línea); el panel de datos del contacto inicia oculto. La interfaz solo oculta; el servidor decide.

---

## 11. Seguridad (checklist de construcción)

1. Variables de entorno validadas al arrancar (Zod); **sin valores por defecto** de secretos; la app **no inicia** si faltan.
2. Claves **separadas y rotables**: firma de sesión, cifrado de credenciales de terceros, firma de webhooks. Nunca reutilizar una para otra (corrige B9).
3. Sin usuarios ni contraseñas por defecto; el primer `super_admin` se crea con un comando de *bootstrap* que genera una contraseña única (corrige B3).
4. Credenciales de terceros cifradas (envelope encryption); **nunca** vuelven a la interfaz (solo últimos 4). *Implementado en M2.6 (ADR-42): AES-256-GCM, clave de datos por fila envuelta por `PROVIDER_CREDENTIALS_KEY`, rotable.*
5. Tokens de API **hasheados**, con scope, caducidad y rate limit (corrige B6).
6. Sesiones revocables; el guard verifica que el usuario siga activo y la versión de sesión (corrige B8).
7. Toda ruta pública (webhooks, formularios, API) con firma/token, rate limit y validación de esquema (corrige B7).
8. Sin SQL interpolado (lint); consultas parametrizadas (corrige B1).
9. Archivos: assets por id, URL firmada, validación MIME, antivirus, sin `/public` abierto (corrige B19/B23).
10. HTTP saliente (webhooks, HTTP request de automatizaciones) con **allowlist**, bloqueo de IP privadas y límite de tamaño (corrige B20).
11. Datos de tarjeta **nunca** tocan el servidor (campos del procesador, tokens).
12. PII redactada en logs; retención de grabaciones/transcripciones definida antes de V1 telefonía **[ABIERTO]**.
13. Dependencias auditadas en CI; sin dependencias deprecadas.
14. Cabeceras de seguridad, CORS estricto, CSRF para cookies, CSP.

---

## 12. Pruebas **[DECIDIDO — Entrega 1 §12]**

| Nivel | Qué | Herramienta |
|---|---|---|
| Unitarias | Dominio puro: reparto ponderado, cálculo de saldo y comisión, reglas de prueba/extensión, SLA | Vitest |
| Integración | Con PostgreSQL real (testcontainers) incluyendo **RLS** y Redis | Vitest + Testcontainers |
| **Aislamiento A↔B** | Una prueba por endpoint (generada) + pruebas RLS directas | Puerta de CI |
| Contract tests | Cada `Provider` real y su fake pasan el mismo conjunto | Vitest |
| Webhooks | Firma inválida, repetidos, fuera de orden | Vitest |
| E2E | Registro → verificación → prueba → extensión → aprobación; Inbox; venta → Purchase diferido; cambio de cuenta de agencia | Playwright |
| Carga básica | Reparto y envío de mensajes concurrentes; descuento de créditos concurrente (sin saldo negativo) | k6 |
| Tests heredados como especificación | `ResponseTimeReportService`, `KanbanPipelines`, `GhlSalientes`, `EliminarConexion` | Casos de prueba iniciales |

**Cobertura:** no se fija un porcentaje global; sí **obligatorios** los de aislamiento, dinero (ventas, pagos, créditos, comisiones) y autenticación.

---

## 13. Despliegue y entornos **[PROPUESTA / hosting ABIERTO]**

- Entornos: `local` (docker-compose: Postgres+pgvector, Redis, MinIO, Mailpit) · `staging` · `production`.
- CI (GitHub Actions): lint (incl. SQL interpolado) → tipos → unitarias → integración (testcontainers) → **aislamiento A↔B** → build → E2E en staging.
- Migraciones **solo hacia adelante** con `app_owner`; cada migración que crea una tabla de negocio incluye su política RLS (verificado en CI).
- Contenedores separados `api` y `worker`; escalado independiente. Backups de PostgreSQL con prueba de restauración periódica.
- Secretos en gestor de secretos del proveedor; rotación documentada.
- Observabilidad: panel de colas, alertas (saldo/consumo OpenAI, desconexión de canales QR, fallo de CAPI, errores de webhooks).

---

## 14. Hitos de implementación y criterios de aceptación

> Cada hito termina con: pruebas verdes (incl. aislamiento), documentación actualizada y revisión del prototipo correspondiente.

**M0 — Fundaciones**
Monorepo, CI, docker-compose, configuración validada, logger, errores, `TenantContext`, roles de BD, migración base, bootstrap del `super_admin`.
*Aceptación:* con A y B, una consulta sin filtro nunca devuelve filas ajenas; la app no arranca sin secretos; el test que verifica política RLS en toda tabla de negocio falla si falta una.

**M1 — Auth, organizaciones y acceso**
`LocalAuthProvider` (registro, verificación, login, refresh rotativo, logout, olvido/reset), `organizations`, `organization_members`, RBAC, auditoría, **pantallas de acceso del prototipo**, prueba de 7 días y extensión de 3 días con aprobación del Súper Admin, pantalla de vencida.
*Aceptación:* flujo completo de ADR-23 en E2E; una segunda solicitud de extensión se rechaza; bloqueo tras 5 intentos; correo desechable/duplicado rechazado; mensajes de error genéricos.

**M2 — Plataforma y agencias**
Consola Súper Admin (empresas y planes, agencias, carteras, pestaña Pruebas, accesos), cambio de contexto sin cerrar sesión, `access_sessions`, marca `acting_as` en auditoría del cliente.
*Aceptación:* la agencia no entra a clientes fuera de su cartera; quitar un cliente cierra el acceso al instante; solo `super_admin` lee `access_sessions` (test de rol de BD). **Hecho en M2.5 (ADR-41) y M2.6 (ADR-42, proveedores): M2 completo.**

**M3 — CRM base**
Contactos (columnas configurables, vistas guardadas, listas, importar/exportar CSV con selección), campos personalizados tipados, etiquetas del sistema, empresas, notas y tareas.
*Aceptación:* importación idempotente con reporte de errores; exportar solo lo seleccionado y auditado; etiquetas del sistema no se borran.
*Avance:* **M3.1 (contactos núcleo) hecha 2026-10-16** (ADR-43, APROBADO): alta, edición, borrado lógico, búsqueda, orden, filtro por responsable y paginación por cursor; teléfonos E.164 únicos por empresa; el asesor ve y edita solo lo suyo; auditoría por campo; marco de la empresa (`AppShell`) y pantalla «Contactos». **M3.2 (campos personalizados) hecha 2026-10-16** (ADR-44, APROBADO): definiciones tipadas con variable estable, archivar en vez de borrar, obligatorios en el alta manual, valores tipados en el contacto con auditoría por campo y pantalla Configuración › Campos personalizados. **M3.3 (etiquetas del sistema y atribución) hecha 2026-10-16** (ADR-45, APROBADO): etiquetas `Lead`/`Cita agendada`/`Venta` puestas solo por el sistema, webhook de clics de Click-to-WhatsApp con primer toque inmutable y último toque, salida de eventos con ventana de gracia cancelable (sin envío real hasta M6) y «Origen del lead» en la ficha. **M3.4 (etiquetas personalizadas, listas, filtros y columnas) hecha 2026-10-16** (ADR-46, APROBADO): etiquetas que administra el administrador y se ponen al crear o editar el contacto, filtros por consentimiento, etiquetas y campos personalizados con índices por tipo, listas dinámicas y fijas (personales o compartidas), tabla con columnas configurables y selección. **M3.5 (importar y exportar CSV) construida 2026-10-17** (ADR-47, APROBADO): el navegador lee el CSV y manda las filas por lotes; vista previa con las mismas reglas del proceso; duplicados por teléfono (omitir o completar solo lo vacío); consentimiento «sin definir» por defecto o «con consentimiento» con base legal registrada; importación reanudable conducida por la pantalla; reporte de omitidas y rechazadas; exportación de selección, vista o todos con auditoría y protección contra fórmulas. **M3.6 (empresas, notas y tareas) construida 2026-10-17** (ADR-48, APROBADO con la enmienda de que solo el administrador gestiona empresas; **cierra M3**): empresas de contactos (no el tenant) compartidas por toda la organización con vínculo N:N a contactos (hasta 5 por contacto) y el alcance por persona sobre sus contactos, notas internas editables solo por su autor, tareas con responsable, vencimiento y vínculo a un contacto o una empresa, pestañas Datos · Notas · Tareas · Empresas en la ficha del contacto y pantallas «Empresas» y «Tareas».

**M4 — Pipelines y oportunidades**
Pipelines múltiples, etapas editables/ocultables, Kanban con colores pastel y filtros, detalle en panel lateral, historial de etapas.
*Aceptación:* reglas ADR-12/18 (eliminar etapa, etapa ganada, etapa de cita).
*Avance:* **M4.1 (pipelines y etapas) construida 2026-10-18** (ADR-49, APROBADO): pipeline «Ventas» creado al primer uso, varios pipelines (hasta 10) con etapas (hasta 15) abiertas, una ganada y una perdida opcional, color pastel, ocultar, reordenar, etapa de cita, eliminar etapa que reasigna sus oportunidades, y la sección «Oportunidades» con el tablero de columnas plegables y el editor de etapas; las tablas de oportunidades e historial ya existen. **M4.2 (oportunidades) construida 2026-10-18**: crear (desde el tablero o la ficha del contacto), mover (arrastre o «Mover a…»), motivo de pérdida obligatorio, una abierta por contacto y pipeline, tablero con tarjetas, resumen y total por etapa, filtros (búsqueda, responsable, origen, etiqueta, valor mínimo), panel lateral con el historial de etapas y alcance propio para el asesor (que gana `opportunities.write`).

**M5 — Inbox y WhatsApp oficial**
`NormalizedMessage`, `MetaCloudProvider`, conversaciones idempotentes, colas y reparto ponderado, transferir/compartir, composer completo, plantillas, SLA y cronómetros, filtros por rol, tiempo real, móvil.
*Aceptación:* webhook repetido no duplica mensajes; el asesor no ve chats ajenos (servidor); nota interna jamás sale al cliente; fuera de 24 h solo plantilla.
*Avance:* plan por rebanadas en `docs/M5_PLAN.md` (ADR-50, APROBADO). **M5.1 (conexiones) construida 2026-10-18**: el administrador conecta cada número de WhatsApp oficial (nombre, WABA ID, Phone number ID y token permanente), el servidor lo comprueba con Meta antes de guardarlo, lo cifra con la bóveda y no lo devuelve; comprobar, renombrar, rotar el token, desactivar y desconectar; un número solo puede estar activo en una empresa. Puerto `WhatsAppProvider` con fake, adaptador de Meta (probado solo contra un servidor simulado) y contract test. **M5.2 (entrada de mensajes) construida 2026-10-18** (precisiones de ADR-50 APROBADAS el 2026-10-19): webhook único de Meta con firma `X-Hub-Signature-256` y verificación inicial (credenciales de la app en «Proveedores», que muestra la dirección a pegar en Meta), avisos guardados con su empresa y procesados por una tarea con reintentos, contacto por teléfono (existente o nuevo sin consentimiento), una conversación abierta por contacto y canal, mensajes idempotentes, estados enviado/entregado/leído/fallido que nunca retroceden y «Conexiones» con la hora del último aviso de Meta. **M5.3 (colas y reparto) construida 2026-10-19** (precisiones de ADR-50 APROBADAS el 2026-10-19): colas con asesores y peso, reparto por rotación, ponderado o menos conversaciones abiertas con lote, tope diario (en la zona horaria de la empresa) y cartera primero; cada conexión tiene su cola por defecto; la conversación nueva queda «pendiente» con su asesor (o «sin asignar») y quien escribe por primera vez es un lead; simulador y «Repartir ahora». **M5.4 (bandeja y respuesta de texto) construida 2026-10-19** (precisiones de ADR-50 APROBADAS el 2026-10-19): sección «Inbox» con la lista (Trabajando / Pendientes / Finalizadas, filtros, no leídas y conteos) y el hilo, donde se ven las reacciones de los clientes; el asesor acepta, responde por WhatsApp (dentro de las 24 h; el mensaje sale al instante y, si el proveedor falla, se reintenta con espera creciente y queda con su estado y su error), deja notas internas que nunca salen al cliente y finaliza; quien ve todo toma las conversaciones sin asignar; cada persona ve solo lo suyo (404 uniforme); el envío real con Meta queda por validar. **M5.5a (transferir y compartir) construida 2026-10-19** (precisiones de ADR-50 APROBADAS el 2026-10-19; M5.5 se parte en 5.5a y 5.5b): el dueño o quien ve todo transfiere la conversación (queda «pendiente» para el destinatario, el lead se mueve con ella y quien la tenía puede seguir como colaborador) o la comparte (con permiso de responder o solo ver y dejar notas) y quita el acceso; cada traspaso deja un aviso automático en el historial y todo se audita; el colaborador la ve en su bandeja, deja notas y, con permiso, responde cuando el dueño ya aceptó; transferir o tomar a mano no consume el tope diario de la cola. **M5.5b (SLA y horarios) construida 2026-10-19** (precisiones de ADR-50 APROBADAS el 2026-10-19; los mensajes de saludo y fuera de horario y el cierre automático pasan a M5.5c): objetivo de respuesta (15 min y aviso de 3 por omisión), horario laboral de la empresa o propio de cada cola, feriados manuales y zona horaria; el cronómetro de cada conversación cuenta solo tiempo abierto, corre desde que se asigna (o desde el mensaje del cliente en un seguimiento) y lo detiene el primer mensaje humano; la cola puede reasignar a otra persona si nadie responde en N minutos (máximo de rotaciones, sin repetir persona, moviendo el lead, con aviso y auditoría automática) y «respetar el horario» deja la conversación sin asignar mientras la cola está cerrada; en la web, «SLA y horario», la sección de horario y reasignación de cada cola, el chip de cada conversación y el filtro «Tiempo de respuesta». **M5.5c (mensajes automáticos de la cola) construida 2026-10-19** (precisiones de ADR-50 APROBADAS el 2026-10-19): cada cola puede tener un saludo (una vez por conversación nueva), un aviso de fuera de horario (en lugar del saludo, una vez por periodo cerrado) y horas de inactividad tras las cuales se finaliza sola una conversación «esperando al cliente»; salen como mensajes automáticos (`sender_type = automation`) que no cuentan como respuesta humana ni mueven la conversación, y se configuran en la cola (`PATCH /queues/:id`: `greeting`, `out_of_hours_message`, `auto_close_hours`). **M5.6a (plantillas de WhatsApp) construida 2026-10-19 con el proveedor simulado, sin validar contra Meta real** (M5.6 se parte en 5.6a plantillas, 5.6b respuestas rápidas, 5.6c mensajes programados y 5.6d adjuntos y audio; precisiones de ADR-50 APROBADAS el 2026-10-20): las plantillas de cada conexión se sincronizan desde Meta (a mano, cada 30 min y al abrir el selector) y se listan —las que no se pueden enviar desde aquí, con el motivo—; el asesor las envía desde la conversación con sus variables (con atajos de datos del contacto y vista previa), dentro o fuera de las 24 h, y cuenta como respuesta humana; el administrador las revisa y sincroniza en Configuración › Conexiones › «Plantillas». Tabla `message_templates` y columnas `whatsapp_accounts.templates_synced_at|templates_sync_error`. **M5.6b (respuestas rápidas con variables) construida 2026-10-20, precisiones de ADR-50 APROBADAS el 2026-10-20:** escribir «/» en el redactor inserta una respuesta guardada (personal o compartida por el administrador) ya con los datos del cliente, de quien escribe y de la empresa; si falta un dato queda marcado y no deja enviar. Tabla `quick_replies` y permiso `quick_replies.manage`. **M5.6c (mensajes programados) construida 2026-10-21, precisiones de ADR-50 APROBADAS el 2026-10-21:** un texto que sale solo a la hora elegida (dentro de la ventana de 24 h), cancelable, que se cancela solo si el cliente responde antes; tabla `scheduled_messages` y tarea `scheduled-messages` cada 15 s.

**M6 — Citas, ventas y Meta**
Citas con recordatorios (topes por fuente), ventas con abono y catálogo por cola, dashboard, **outbox + atribución Meta** (Lead/Schedule/Purchase con ventana de gracia), analítica con CSV.
*Aceptación:* Purchase anulado dentro de la ventana nunca se envía; mismo `event_id` en reintentos; saldo = total − pagos.
*Avance:* plan por rebanadas en `docs/M6_PLAN.md` (ADR-51, decisiones APROBADAS el 2026-10-23). **M6.1 (catálogo de productos por cola) construida 2026-10-23**: tabla `queue_products` (migraciones 0060–0061; sin DELETE, se desactiva; precio `numeric(14,2)` como texto; hasta 200 por cola), `organizations.currency` (USD por omisión), `GET|POST /v1/queues/:id/products` y `PATCH …/:productId` (`queues.manage`) y en la web la sección «Catálogo de productos y servicios» de cada cola.

**M7 — GoHighLevel**
`PrivateTokenProvider`, webhook con secreto en tiempo constante, mensajes entrantes/salientes, etiquetas bidireccionales, inscripción a flujos.
*Aceptación:* contract tests con fake de GHL; token cifrado y jamás devuelto.

**M8 — IA: agentes, conocimiento y créditos**
Agentes (galería, 5 pestañas, foto), simulador de prueba, Knowledge Base con RAG (pgvector), créditos con libro y recarga, `ToolRegistry` con permisos y auditoría.
*Aceptación:* el agente no responde con datos que no están en sus documentos; descuento atómico sin saldo negativo bajo concurrencia; margen no aparece en ninguna respuesta de API de cliente.

**M9 — WhatsApp QR, formularios y automatizaciones**
`EvolutionProvider`, formularios embebibles (`embed.js`), motor trigger/condición/acción.

**M10 — Telefonía y comisiones**
`TwilioProvider`, WebRTC, grabación; comisiones con planes, split y reversión.

**M11 — Voz IA y llamadas masivas (V2)**
Tras el PoC Retell vs. Vapi.

**Billing y planes:** se inserta antes del primer cliente de pago; depende de decidir la pasarela.

---

## 15. Pendientes y suposiciones críticas

| # | Tema | Estado | Bloquea |
|---|---|---|---|
| 1 | Hosting y región | PARCIAL: Railway aprobado para staging/piloto (ADR-30); producción por revalidar | Despliegue (M0 staging) |
| 2 | ORM y `SET LOCAL` para RLS (spike 1 día) | ABIERTO | M0 |
| 3 | Proveedor de correo transaccional | **RESUELTO: Resend (ADR-37, 2026-10-11)**; falta validar el envío real y el DNS de `growthconsulting.digital` | Despliegue |
| 4 | Pasarela de pago | ABIERTO | Billing, recarga de créditos |
| 5 | PoC Retell vs. Vapi | ABIERTO | M11 |
| 6 | Retención de grabaciones y transcripciones | ABIERTO | Telefonía |
| 7 | Prueba real en Events Manager: ¿se puede retirar un evento? | ABIERTO | M6 |
| 8 | Valores de ejemplo: 1000 créditos de bienvenida, $0,01/crédito, margen 100 %, retención 30 días de prueba | PROPUESTA | Billing |
| 9 | Anti-abuso del registro: captcha real | **RESUELTO: Cloudflare Turnstile (ADR-37, 2026-10-11)**; falta crear el sitio y las claves | Despliegue |
| 10 | Prueba del agente consume créditos `kind = test` | PROPUESTA | M8 |
| 11 | Logos oficiales de marca para Conexiones | PENDIENTE | Pulido |
| 12 | Normativa local (llamadas masivas, consentimiento, protección de datos) | A revisar con asesoría | V2 |
| 13 | Ítems de certeza «I» de la Fase 27 (R11, R15, R16, R17, R19, X1) | Confirmar al construir cada pantalla | Cada módulo |
| 14 | Archivos del repo actual sin leer (ver Fase 27 §5.2) | Pueden aportar reglas finas | Ninguno |
| 15 | ¿La API oficial de Meta permite alguna gestión de grupos? (sin verificar) | ABIERTO | Gestor de grupos |
| 16 | Grupos: ¿asignación por asesor o de toda la organización? (hoy: toda la organización) | ABIERTO | Gestor de grupos |
| 17 | Campañas del asesor: cobro, límites, calentamiento de números QR, consentimiento y «no contactar»; costo de plantillas de marketing | ABIERTO (V2) | Campañas masivas |
| 18 | Regla de acceso a contactos del asesor (extiende ADR-14) | APROBADO (ADR-32, 2026-10-09) | Contactos/M3 |
| 19 | Spike de WhatsApp QR (Evolution) sobre Railway con chip de prueba | APROBADO (ADR-31); en curso | EvolutionProvider/M9 |
| 21 | Un plan asignado saca a la empresa de la prueba; el cobro es manual hasta la pasarela (ADR-38, APROBADO 2026-10-12) | **CONFIRMADO** | Billing |
| 20 | Limpieza de tablas de identidad sin dar `DELETE` a `app_identity`: **RESUELTO (ADR-35, 2026-10-11)**. Pendiente: purga de datos de negocio a los 30 días de prueba vencida | PARCIAL | M3+ (purga) |

---

## 16. Mapa prototipo → módulos
Login/registro/verificación/vencida → `auth`, `trials` · Dashboard → `dashboard` · Inbox → `conversations`, `channels` · Contactos/listas → `contacts`, `lists` · Oportunidades → `pipelines`, `opportunities` · Agenda y tareas → `appointments`, `tasks` · Formularios → `forms` · Mensajes rápidos → `quick-messages` · Conexiones → `channels` · Colas y asignación → `queues` · Agentes IA → `agents`, `knowledge` · Créditos IA → `ai-credits` · Telefonía → `telephony` · Analytics y asesores/comisiones → `analytics`, `commissions` · Configuración → `organizations`, `custom-fields`, `sla` · Plataforma (Empresas y planes, Agencias, Carteras, Pruebas, Accesos, Proveedores) → `platform` · **[v9]** Mis ventas → `sales` · Campañas masivas → `campaigns` (V2) · Grupos de WhatsApp → `wa-groups` (V1)
