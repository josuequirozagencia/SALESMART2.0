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
| Colas | BullMQ + Redis | Todo job lleva `organization_id` |
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
`provider_credentials` (de plataforma) · `ai_pricing` · `ai_org_pricing` (solo `super_admin`) · `plans` · `trial_config` · `access_sessions` (solo `super_admin`) · `platform_audit`. Se protegen por **rol de BD** + guard de aplicación, y tienen test que verifica que el rol `app_rw` no puede leerlas.

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
`inbox.view_all` · `inbox.reply` · `inbox.transfer` · `inbox.share` · `contacts.read|write|import|export` · `opportunities.read|write` · `pipelines.manage` · `sales.create|cancel` · **[v9, ADR-32 aprobado]** `sales.read_own` · `sales.register_payment` (alcance propio, enmienda 1) · `custom_fields.manage` · `campaigns.send` (alcance: contactos propios/compartidos; tope diario por asesor) · `groups.view|send|manage` (`send` y `manage` requieren `view`) · `appointments.manage` · `queues.manage` · `tags.manage` · `agents.manage|test` · `knowledge.manage` · `channels.manage` · `integrations.manage` · `forms.manage` · `automations.manage` · `commissions.view|manage` · `analytics.view` · `export` · `team.manage` · `billing.manage` · `platform.providers.manage` · `platform.agencies.manage` · `platform.trials.manage` · `platform.access_log.read`

Los permisos se evalúan en **un guard central**; la interfaz solo oculta, nunca protege. `commissions.view` admite alcance propio (el asesor solo ve la suya). La matriz rol→permiso sigue **PROVISIONAL** (ADR-29); los permisos [PROPUESTA v9] se añaden al catálogo por migración solo tras aprobar ADR-32.

---

## 6. Modelo de datos consolidado **[DECIDIDO + PROPUESTA]**

Convenciones: UUID v7, `created_at`, `updated_at`, `deleted_at` (borrado lógico donde aplique), `organization_id` + RLS en toda tabla de negocio, saldos **derivados** (nunca campos libres), dinero en `numeric(14,2)` + `currency`. Columnas `legacy_id`, `legacy_source` (nullable) en `contacts`, `companies`, `opportunities`, `conversations`, `messages`, `sales` (ADR-06).

### 6.1 Acceso y organizaciones
- `users` (email único, `password_hash` Argon2id, `email_verified_at`, `status`) · `auth_identities(user_id, provider, external_id)` · `sessions` · `refresh_tokens` (rotativos) · `email_verifications` · `password_resets` · `session_events` · `invitations`
- `organizations(kind ∈ platform|agency|client, parent_agency_id, created_by_agency_id, name, plan_id, status, timezone, …)` · `organization_members(user_id, organization_id, role, access_level, granted_by, revoked_at)` · `agency_grants` · `organization_ownership_history` · `access_sessions` *(plataforma)*
- `roles`, `permissions`, `role_permissions` (permisos por rol; roles de sistema + personalizados por organización en V1)
- `api_keys(hash, scope, expires_at, last_used_at)` (V1)

### 6.2 Pruebas y planes (ADR-23)
- `trials(organization_id, owner_user_id, started_at, ends_at, ext_status ∈ none|pending|approved|denied, ext_reason, ext_decided_by, ext_decided_at, ext_days_granted)` — **una extensión por cuenta**: restricción única en la lógica y `CHECK` sobre transiciones
- `trial_config` *(plataforma)*: `days=7`, `ext_days=3`, `retention_days=30`, créditos de bienvenida
- `signup_attempts(email_hash, ip_hash, at, outcome)` (anti-abuso) · `disposable_domains`
- `plans`, `subscriptions(organization_id, plan_id, status, current_period_end)`, `invoices` (V1)

### 6.3 CRM
- `contacts` (nombre, teléfonos normalizados E.164, email, `owner_id`, `source`, `consent`, …) · `contact_phones` · `companies` · `contact_companies` · `contact_lists(name)` · `contact_list_members`
- `custom_field_definitions(entity ∈ contact|opportunity|company, type, options, var_key, validation, show_in_form, required, position)` · `custom_field_values(entity, entity_id, definition_id, value_text|number|bool|date|json)` con índices por tipo · `saved_views(columns, order, filters, owner, shared)`
- `pipelines(name, position, appointment_stage_id)` · `pipeline_stages(pipeline_id, name, position, kind ∈ open|won|lost, is_hidden, color)` · `opportunities(pipeline_id, stage_id, contact_id, amount, owner_id, lost_reason)` · `opportunity_field_overrides` · `stage_history(opportunity_id, from_stage_id, to_stage_id, user_id, origin)`
- `tags(is_system, system_key ∈ lead|appointment|sale, color)` · `taggings` · `notes` · `tasks` · `activities` · `assignments`

### 6.4 Inbox y canales
- `channels` · `channel_accounts(provider, is_official, credentials_encrypted, status, settings)` · `whatsapp_accounts(waba_id, phone_number_id)` · `qr_sessions`
- `conversations(contact_id, channel_account_id, owner_id, queue_id, status, close_reason, last_message_at)` — **única parcial** para impedir duplicadas abiertas (+ advisory lock)
- `messages(external_id, channel_account_id, direction, sender_type ∈ human|ai|campaign|automation|system, body, status, sent_at)` — **único** `(channel_account_id, external_id)` · `message_attachments(storage_key, mime, size, checksum, scan_status)` · `scheduled_messages` · `quick_messages` · `whatsapp_templates`
- **[PROPUESTA v9, V1, solo canal QR]** `wa_groups(channel_account_id, external_id, name, description, settings)` · `wa_group_participants(group_id, phone, is_admin, contact_id?)` · `wa_group_scheduled_messages(group_id, body, attachments, mention_all, schedule, recurrence_rule, status)`. Todas con `organization_id` y RLS. Los grupos son de toda la organización; el acceso por asesor lo da `groups.*` (asignación por asesor: pendiente §15 #16).
- `conversation_participants(role ∈ owner|collaborator, permission ∈ reply|view, revoked_at)`
- `response_timers` · `sla_policies` · `business_hours` · `holidays`

### 6.5 Colas, citas, ventas
- `queues(name, color, status, default_pipeline_id, schedule, messages)` · `queue_members(queue_id, user_id, active, weight)` · `queue_distribution_rules` · `queue_distribution_state` · `queue_products(queue_id, name, kind, price, active)`
- `appointments` · `appointment_reminders(offset_minutes, channel, status, scheduled_at, sent_at)` · `appointment_reminder_limits` (config por organización: 3 / 5 para QR, Messenger, Instagram)
- `sales(amount, currency, queue_id, product_id, conversation_id, status, created_by)` · `sale_payments(sale_id, amount, method, paid_at)` · `sale_status_history` (nunca se borra) · saldo = `amount − Σ sale_payments` · **[ADR-32 enmienda 1]** `sale_payments` append-only (el asesor solo inserta, con `created_by`); sin «pago de comisión» por ahora (`commission_payouts` diferido) · `sale_change_requests(sale_id, requested_by, reason, status, resolved_by)`: el asesor pide corrección; solo quien tenga permiso de gestión de ventas la resuelve
- `commission_plans` (parámetros versionados en JSONB, `reversal_rule` desactivada por defecto) · `commission_plan_assignments` · `commissions` · `commission_splits` · `commission_payouts` · `goals`

### 6.6 Atribución y eventos
- `domain_events` (**outbox**, escrita en la misma transacción) · `meta_events(event_id único por org, type, status ∈ pending|sent|skipped|blocked|failed|expired|cancelled, attempts, send_after)` · `meta_settings` (ventana de gracia, evento personalizado `SaleCanceled`) · `ctwa_clicks`
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
`POST /auth/signup` · `POST /auth/verify` · `POST /auth/resend` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/forgot` · `POST /auth/reset` · `POST /auth/password` (autenticado, ADR-28) · `POST /context/switch` · `POST /trials/me/extension` · `GET|POST /platform/trials`, `POST /platform/trials/:id/approve|deny` · `GET|POST /platform/agencies`, `PUT /platform/organizations/:id/agency` · `GET /platform/access-sessions`

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
- **Transferir/compartir (ADR-14):** transferir cambia dueño (SLA y comisión); compartir no; visibilidad `owner_id = yo OR participante activo` aplicada en servidor y RLS.
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
4. Credenciales de terceros cifradas (envelope encryption); **nunca** vuelven a la interfaz (solo últimos 4).
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
*Aceptación:* la agencia no entra a clientes fuera de su cartera; quitar un cliente cierra el acceso al instante; solo `super_admin` lee `access_sessions` (test de rol de BD).

**M3 — CRM base**
Contactos (columnas configurables, vistas guardadas, listas, importar/exportar CSV con selección), campos personalizados tipados, etiquetas del sistema, empresas, notas y tareas.
*Aceptación:* importación idempotente con reporte de errores; exportar solo lo seleccionado y auditado; etiquetas del sistema no se borran.

**M4 — Pipelines y oportunidades**
Pipelines múltiples, etapas editables/ocultables, Kanban con colores pastel y filtros, detalle en panel lateral, historial de etapas.
*Aceptación:* reglas ADR-12/18 (eliminar etapa, etapa ganada, etapa de cita).

**M5 — Inbox y WhatsApp oficial**
`NormalizedMessage`, `MetaCloudProvider`, conversaciones idempotentes, colas y reparto ponderado, transferir/compartir, composer completo, plantillas, SLA y cronómetros, filtros por rol, tiempo real, móvil.
*Aceptación:* webhook repetido no duplica mensajes; el asesor no ve chats ajenos (servidor); nota interna jamás sale al cliente; fuera de 24 h solo plantilla.

**M6 — Citas, ventas y Meta**
Citas con recordatorios (topes por fuente), ventas con abono y catálogo por cola, dashboard, **outbox + atribución Meta** (Lead/Schedule/Purchase con ventana de gracia), analítica con CSV.
*Aceptación:* Purchase anulado dentro de la ventana nunca se envía; mismo `event_id` en reintentos; saldo = total − pagos.

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
| 3 | Proveedor de correo transaccional | ABIERTO | M1 |
| 4 | Pasarela de pago | ABIERTO | Billing, recarga de créditos |
| 5 | PoC Retell vs. Vapi | ABIERTO | M11 |
| 6 | Retención de grabaciones y transcripciones | ABIERTO | Telefonía |
| 7 | Prueba real en Events Manager: ¿se puede retirar un evento? | ABIERTO | M6 |
| 8 | Valores de ejemplo: 1000 créditos de bienvenida, $0,01/crédito, margen 100 %, retención 30 días de prueba | PROPUESTA | Billing |
| 9 | Anti-abuso del registro: captcha real (hCaptcha/Turnstile) | PROPUESTA | M1 |
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

---

## 16. Mapa prototipo → módulos
Login/registro/verificación/vencida → `auth`, `trials` · Dashboard → `dashboard` · Inbox → `conversations`, `channels` · Contactos/listas → `contacts`, `lists` · Oportunidades → `pipelines`, `opportunities` · Agenda y tareas → `appointments`, `tasks` · Formularios → `forms` · Mensajes rápidos → `quick-messages` · Conexiones → `channels` · Colas y asignación → `queues` · Agentes IA → `agents`, `knowledge` · Créditos IA → `ai-credits` · Telefonía → `telephony` · Analytics y asesores/comisiones → `analytics`, `commissions` · Configuración → `organizations`, `custom-fields`, `sla` · Plataforma (Empresas y planes, Agencias, Carteras, Pruebas, Accesos, Proveedores) → `platform` · **[v9]** Mis ventas → `sales` · Campañas masivas → `campaigns` (V2) · Grupos de WhatsApp → `wa-groups` (V1)
