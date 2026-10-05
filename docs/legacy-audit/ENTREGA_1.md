# SALES SMART 2.0 — ENTREGA 1: AUDITORÍA + ARQUITECTURA

Fecha: 2026-10-02 · Repo auditado: `josuequirozagencia/sales-smart` (rama por defecto, HEAD `4c5d040`, solo lectura)

> **Alcance real de esta entrega.** Es una auditoría de primera pasada sobre un repo de ~1.745 archivos (1.156 `.ts`, 443 `.js`, 353 migraciones). Revisé estructura, dependencias, docs, autenticación, cobertura de `companyId` en modelos, una muestra dirigida de servicios/controladores, rutas públicas, GHL y agentes IA. **No es exhaustiva**: donde digo "151 `findByPk`" no verifiqué las 151, verifiqué las que cito. Cada hallazgo indica su nivel de certeza. La Fase 25 (prototipo) y la Fase 28 (Build Spec) quedan para las siguientes entregas, como acordamos.

---

## 1. Executive Summary

1. **El Sales Smart actual es un fork de Whaticket/Multiflow ("ChatIA 4.7.9")**, no un producto construido desde cero. Su núcleo es *tickets de WhatsApp* (Baileys), no un CRM con contactos, empresas y oportunidades. Eso explica casi todo lo demás.
2. **Multi-tenancy por convención, no por diseño.** El aislamiento depende de que cada desarrollador recuerde filtrar por `companyId` en cada query. Hay evidencia concreta de que no siempre ocurre (sección 5). Para un SaaS multiempresa esto es el riesgo n.º 1.
3. **Hay hallazgos de seguridad reales**: inyección SQL con interpolación directa, secretos JWT con valor por defecto, credenciales de seed conocidas y consultas por ID sin filtro de empresa.
4. **Lo valioso no es el código sino el conocimiento de dominio**: la integración GHL (token cifrado, webhook con comparación en tiempo constante), los agentes IA con estado separado de la asignación, la medición de tiempo de respuesta, y los 24 tests de servicios.
5. **Recomendación: confirmar la reconstrucción desde cero**, extrayendo reglas de negocio (no código) de GHL, agentes IA, Meta Conversions y respuesta/SLA. El stack actual (Sequelize 5, React 17 + Material-UI v4 + v5 mezclados, Node 21) acumula deuda que no conviene heredar.
6. **Brechas totales frente a 2.0**: no existe telefonía/WebRTC ni IA de voz, no existe RAG con embeddings, no hay empresas/oportunidades como entidades CRM propias, y comisiones no existen.

---

## 2. Auditoría — Stack y estructura (Fase 1)

| Área | Hallazgo | Certeza |
|---|---|---|
| Backend | Express 4 + Sequelize 5.22 + sequelize-typescript, Bull 3 (colas), Socket.IO 4, Node 21.6 | Verificado (package.json) |
| Frontend | React 17, react-scripts 5, **Material-UI v4 y MUI v5 a la vez**, react-router v5, react-query v3 | Verificado |
| WhatsApp QR | `@whiskeysockets/baileys` fijado a un commit de GitHub | Verificado |
| WhatsApp oficial | Servicio separado `api_oficial` en **NestJS + Prisma + RabbitMQ (amqplib) + Redis** | Verificado |
| Transcripción | `api_transcricao` en Python (`main.py`) | Verificado, no leído a fondo |
| BD | PostgreSQL 13, **317 migraciones, 64 tablas** según SETUP.md | Del documento |
| IA | OpenAI, Gemini, OpenRouter; documentos PDF/Word vía `pdf-parse`/`mammoth` | Verificado |
| Pagos | Stripe, MercadoPago, Gerencianet (`gn-api-sdk`) | Verificado |
| Deploy | Docker, Railway, instalador shell, `multiflow_deploy/deploy_fastalk.sh` | Verificado |
| Monolito gigante | `wbotMessageListener.ts` = **5.013 líneas**; `queues.ts` 2.391; `ActionsWebhookService.ts` 2.156 | Verificado |
| Calidad | 266 `@ts-ignore`/`as any`, 455 `console.log` fuera de tests | Verificado (conteo) |
| Tests | 24 specs de servicios; ninguno para aislamiento de tenant | Verificado |
| Dependencias dudosas | `request@2.88.2` (deprecado), `xlsx` vendorizado como tgz, `cluster@0.7.7`, `backend@file:` (auto-referencia) | Verificado |

**Mezcla de lenguajes y herencia:** nombres en portugués (`api_transcricao`, `Baileys`), español (servicios `Atender…`, `Seguimientos`) e inglés. Señal de fork sucesivo.

---

## 3. Funcionalidades actuales (Fase 2)

| Funcionalidad | Estado | Calidad | Veredicto |
|---|---|---|---|
| Tickets / atención WhatsApp (Baileys) | Completo | Funciona, código monolítico | **REDISEÑAR** (modelo conversación) |
| WhatsApp oficial (Cloud API) | Completo, servicio aparte | Arquitectura razonable (cola + Prisma) | **REDISEÑAR** como adapter |
| Facebook / Instagram | Presente (`facebookMessageListener`) | Media | **REDISEÑAR** |
| GoHighLevel (canal) | Completo para entrada/salida de mensajes y etiquetas | **Buena** | **RECUPERAR reglas**, reescribir código |
| Contactos | Existe; campos extra vía `ContactCustomField` (clave/valor sin tipos) | Débil para 2.0 | **REDISEÑAR** |
| Etiquetas (Tags) | Existe + sincronía con GHL | Buena | **RECUPERAR** concepto |
| Kanban | `KanbanPipeline` + test `KanbanPipelines.spec` | Parcial | **REDISEÑAR** |
| Ventas | Modelo `Sale` existe | A revisar | **REDISEÑAR** (historial/reapertura) |
| Agentes IA | Completo fase 1: motor, canales, estado IA por ticket, seguimientos, sandbox | **Buena** | **RECUPERAR diseño** |
| Conocimiento del agente | Texto pegado o PDF/Word; **sin embeddings ni vector DB** | Básico | **NUEVO** (RAG real) |
| Flow Builder | 24 nodos en frontend, `FlowBuilderService` | Complejo | **REDISEÑAR** (automatizaciones) |
| Campañas masivas | `CampaignService` | Media | **DESCARTAR o diferir** |
| Tiempo de respuesta | `ResponseTimeReportService` + test | Existe, a validar contra SLA 2.0 | **REDISEÑAR** |
| Meta Conversions API | Documentado + `ProcessConversionJob` | Buena | **RECUPERAR** |
| Créditos IA / planes / suscripciones | Existe | Es negocio SaaS propio | **RECUPERAR** concepto |
| Snapshots / clonar empresa | `ConfigSnapshot`, `CompanyConfigClone` | Útil | **RECUPERAR** concepto |
| Chat interno, anuncios, ayuda | Heredado de Whaticket | Bajo valor | **DESCARTAR** |
| Typebot / Dialogflow / integraciones de colas | Heredado | Bajo valor | **DESCARTAR** |
| **Telefonía / voz / WebRTC** | **No existe** (búsqueda de twilio/telnyx/webrtc/sip = 0 archivos) | — | **NUEVO** |
| **Empresas (CRM B2B), oportunidades con overrides, comisiones, auditoría de campos** | **No existen** como entidad | — | **NUEVO** |

---

## 4. Bugs y riesgos (Fase 3)

| # | Nivel | Hallazgo | Ubicación | Causa / impacto | Cómo evitarlo en 2.0 | Certeza |
|---|---|---|---|---|---|---|
| B1 | **CRÍTICO** | **Inyección SQL**: el `messageId` se interpola en el SQL | `services/MessageServices/ShowMessageService.ts:7` (`... where id = '${messageId}'`), llamado desde `MessageController.ts:334` | Entrada del cliente dentro de SQL crudo. Permite leer otras tablas y, al no filtrar por empresa, mensajes de otros tenants | Prohibir SQL crudo con interpolación (lint), usar solo consultas parametrizadas / query builder | Verificado el código; **no verifiqué si `messageId` llega validado** antes de ese punto |
| B2 | **CRÍTICO** | **Secretos JWT con valor por defecto** (`"mysecret"`, `"myanothersecret"`) | `config/auth.ts:2,4` | Si falta la variable de entorno, el sistema arranca igual y cualquiera puede forjar tokens de cualquier empresa | Arranque que falla si falta el secreto; validación de env al boot | Verificado |
| B3 | **CRÍTICO** | **Credencial de seed conocida** `admin@multi100.com.br` / `adminpro` | `database/seeds/…create-default-user.ts:14`; documentada en SETUP.md | Si el seed corre en producción, hay un admin con contraseña pública | Sin usuarios por defecto; bootstrap con contraseña única generada | Verificado |
| B4 | **ALTO** | Lecturas por ID **sin filtro de empresa** | `ChatService/ShowService.ts` (`Chat.findByPk(id)`), `ChatService/UpdateService`, `AddUsersToGroupService`, `AnnouncementService/*`, `TagServices/ShowService`, `BlockUnblockContactService:44`, `SyncTagsService:43` | Un usuario autenticado de la empresa A puede pedir el ID de un registro de B. Conteo: **151 `findByPk`** en servicios/controladores, solo revisé los citados | `tenant` obligatorio por construcción (ver sección 5) | Verificado en los citados; el resto **por revisar** |
| B5 | **ALTO** | Autorización tras la lectura, con mensaje de error equivocado | `ContactServices/ShowContactService.ts` carga por ID y luego compara `companyId`; el error dice "no es posible **excluir**" en una lectura | El patrón "cargar y luego comprobar" es correcto en resultado pero frágil; ya se ve copiado sin la comprobación en otros servicios | Patrón único: la consulta ya incluye el tenant | Verificado |
| B6 | **ALTO** | Token de API pública sin vínculo explícito a empresa | `middleware/tokenAuth.ts`: `Whatsapp.findOne({ where: { token } })`; no deja `req.user` | El token vive en la fila de conexión; el middleware no fija la empresa en la petición (los controladores deberían derivarla). Además el token se guarda y compara **en claro** | Tokens de API hasheados, con alcance (scope) y empresa en el contexto | Verificado el middleware; **comportamiento de `ApiController` por verificar** |
| B7 | **ALTO** | Rutas sin `isAuth`: `apiRoutes` (usa `tokenAuth`), `webHookRoutes` (GET/POST sin protección visible), parte de `authRoutes` y `subScriptionRoutes` | `routes/` | `webHookRoutes` expone `index` y `webHook` sin middleware; hay que confirmar la verificación de firma/verify-token dentro del controlador | Todo webhook con verificación de firma obligatoria y *rate limit* | Verificado que no hay middleware; **la verificación interna no la leí** |
| B8 | **MEDIO** | `isAuth` no comprueba que el usuario siga activo ni la versión de la sesión; el token vive 15 min pero `updateUser()` se llama en cada petición | `middleware/isAuth.ts` | Un usuario desactivado conserva acceso hasta expirar el token | Revocación por sesión / versión de token | Verificado |
| B9 | **MEDIO** | Cifrado de tokens cae a `JWT_SECRET` si no hay `TOKEN_ENCRYPTION_KEY` | `helpers/SecretBox.ts:53` | Una sola clave sirve para firmar sesiones y cifrar credenciales de terceros; rotar una rompe la otra | Claves separadas, rotación, KMS | Verificado |
| B10 | **MEDIO** | 26 modelos **sin columna `companyId`** (de 83) | `models/` (lista abajo) | Algunos son hijos legítimos (tablas puente) y otros no (`Webhook`, `FlowBuilder`, `Chatbot`, `TicketNote`, `LogTicket`, `Partner`, `CampaignShipping`) | `organization_id` NOT NULL en **toda** tabla de negocio | Verificado la lista; **cuáles son realmente un problema, por revisar** |
| B11 | **MEDIO** | Archivos monolito: `wbotMessageListener.ts` 5.013 líneas | `services/WbotServices/` | Imposible de testear y de razonar; concentra la lógica de negocio del Inbox | Pipeline de mensajes en módulos pequeños con adapters | Verificado |
| B12 | **MEDIO** | Sequelize 5 y Bull 3 fuera de soporte | `package.json` | Sin parches de seguridad; tipado débil | ORM/colas actuales | Verificado |
| B13 | **BAJO** | 455 `console.log`, 266 `@ts-ignore`/`as any`, `request@2.88.2` deprecado | varios | Ruido, logs con datos sensibles posibles, deuda | Logger estructurado con redacción de PII; lint estricto | Verificado (conteo) |
| B14 | **BAJO** | Nodemon vigila toda `backend/` y sirve `dist/` | SETUP.md | Fricción de desarrollo | Entorno de dev reproducible (Docker compose) | Del documento |

**Modelos sin `companyId`** (verificado): AiCreditSettings, AiModelPricing, AppointmentReminder, Baileys, CampaignShipping, ChatUser, Chatbot, Company, CompanyConfigClone, ConfigSnapshot, ContactCustomField, ContactTag, DialogChatBots, FilesOptions, FlowBuilder, Help, LogTicket, Partner, Plan, QueueOption, QueueStates, QuickMessageComponent, TicketNote, TicketTag, UserQueue, Versions, Webhook, WhatsappQueue.

---

## 5. Multi-tenancy (Fase 4)

### Diagnóstico
- El `companyId` viaja en el JWT y se pone en `req.user`. Hasta ahí bien.
- Pero **cada servicio decide por su cuenta** si filtra. No hay un mecanismo que lo obligue. Los hallazgos B1, B4 y B10 son consecuencias directas.
- No hay tests de aislamiento entre empresas (los 24 specs son funcionales).

### Arquitectura propuesta para 2.0 (defensa en profundidad, 3 capas)

| Capa | Mecanismo | Por qué |
|---|---|---|
| **1. Base de datos** | PostgreSQL con **Row Level Security (RLS)**: toda tabla de negocio lleva `organization_id NOT NULL` y una política `organization_id = current_setting('app.org_id')::uuid`. Cada petición ejecuta `SET LOCAL app.org_id = …` dentro de su transacción | Si un desarrollador olvida el filtro, la BD **igualmente no devuelve** filas ajenas. Es la única capa que no depende de la disciplina humana |
| **2. Aplicación** | Un único `TenantContext` por petición (AsyncLocalStorage) y repositorios que lo exigen. Sin acceso directo al ORM desde controladores | Evita el patrón "cargar por ID y luego comprobar" |
| **3. Verificación** | Lint que prohíbe SQL crudo interpolado + suite de tests de aislamiento A↔B que se ejecuta en CI para **cada endpoint** | Convierte la regla en algo que rompe el build |

Además: archivos en storage con prefijo `org/{id}/…` y URLs firmadas de corta duración; colecciones del vector store con `organization_id` y filtro obligatorio; el contexto de tenant viaja en cada job de cola; los webhooks entrantes se resuelven por un identificador opaco por canal y no por un `companyId` visible en la URL.

**Trade-off:** RLS añade complejidad operativa (pool de conexiones, migraciones, rol de servicio). Alternativa "un esquema por tenant" aísla más pero complica migraciones y analytics entre empresas. **Recomiendo RLS + `organization_id`**, que escala a miles de empresas pequeñas, que es el perfil de tus clientes.

---

## 6. Integraciones (Fases 8–12 respecto al código actual)

| Integración | Estado actual | Qué recuperar |
|---|---|---|
| **GHL** | Canal unidireccional con refuerzo: entrada por *webhook de Workflow* con secreto en la URL (comparación `timingSafeEqual`, misma respuesta para "no existe" y "secreto malo"), salida por API, etiquetas en ambos sentidos, inscripción a flujos, plantillas | Reglas y límites **documentados en `docs/GOHIGHLEVEL.md`**. Limitación clave: con un *Private Integration Token* **no se pueden crear suscripciones de webhook**; eso requiere una app OAuth del Marketplace. Para 2.0 bidireccional real, **decidir entre Marketplace OAuth o seguir con Workflows** (ver decisión D5) |
| WhatsApp oficial | Microservicio NestJS aparte con RabbitMQ y Prisma | Separación entrada→cola→proceso. Rediseñar como adapter |
| WhatsApp QR | Baileys fijado a un commit | Aislar tras `QrProviderAdapter` (Baileys hoy, otro mañana). Riesgo: proveedor no oficial puede romperse o bloquear números |
| Meta (FB/IG) | Listener propio de ~1.060 líneas | Normalizar al mismo mensaje común |
| Meta Conversions API | Con job y documento | Recuperar tal cual como módulo |
| Telefonía / voz | **No existe** | Nuevo (sección 7) |

---

## 7. Listas RECUPERAR / REDISEÑAR / DESCARTAR / NUEVO (Fase 27)

**RECUPERAR (conocimiento y reglas, no código):**
- Reglas GHL: webhook con secreto, respuesta uniforme, tokens cifrados que nunca vuelven a la UI (solo últimos 4 caracteres), sincronía de etiquetas bidireccional.
- Agentes IA: **estado de la IA separado de la asignación** (`AiAgentTicketStates`), prioridad humana (un mensaje del asesor pausa la IA), un agente por conexión, seguimientos, sandbox de pruebas, clave nunca devuelta.
- Meta Conversions API y su job.
- Tags, créditos IA, planes, snapshots/clonado de empresa (como idea de producto).
- Tests como especificación de comportamiento (`ResponseTimeReportService`, `KanbanPipelines`, `GhlSalientes`, `EliminarConexion`).

**REDISEÑAR:**
- Modelo central: de `Ticket` a `Contact → Conversation → Message` + `Opportunity` separada.
- Campos personalizados: de clave/valor sin tipo a definiciones tipadas reutilizables.
- Inbox: pipeline normalizado por adapters (rompe `wbotMessageListener`).
- Kanban/pipelines, ventas, tiempo de respuesta (SLA con calendario laboral y feriados).
- Flow Builder → motor de automatizaciones (trigger / condición / acción) sobre campos.
- Auth/RBAC, sesiones revocables, tokens de API con scope.

**DESCARTAR:**
- Chat interno, anuncios, ayuda, campañas masivas (diferir), Typebot, Dialogflow, integraciones de cola heredadas, Material-UI v4, Sequelize 5, Bull 3, el seed con credenciales, `api_transcricao` tal como está (se reemplaza por proveedor STT detrás de un adapter).

**NUEVO:**
- Empresas (cuentas B2B), oportunidades con overrides de campos, tabla de contactos configurable con vistas guardadas, captura de datos por IA hacia campos, RAG real (embeddings + vector DB), telefonía + WebRTC, IA de voz, comisiones configurables, auditoría antes/después con origen, RLS.

---

## 8. Arquitectura 2.0 (Fase 22)

**Principio:** monolito modular (un repositorio, un despliegue de API, módulos con fronteras claras) + workers para trabajo asíncrono. **No microservicios**, como pide la instrucción del proyecto.

| Componente | Decisión recomendada | Alternativa | Motivo |
|---|---|---|---|
| Frontend | React + TypeScript + Vite, una sola librería UI, TanStack Query/Table | Next.js | CRM autenticado: no necesita SSR; Vite es más simple |
| Backend | **Node.js + TypeScript con NestJS** (módulos, DI, guards) | Fastify "a mano" | Ya tienes NestJS en `api_oficial`; los módulos de Nest fuerzan fronteras. Trade-off: más ceremonia |
| BD | **PostgreSQL 16 + RLS + pgvector** | BD vectorial aparte | Un solo motor para datos, JSONB de campos y embeddings en la fase 1; extraer a Qdrant si crece. Detrás de `VectorStore` adapter |
| ORM | **Prisma o Drizzle** con transacciones por petición | Sequelize | Tipado real. Ojo: RLS exige `SET LOCAL` dentro de la transacción (verificar soporte del ORM elegido en un spike) |
| Colas | **BullMQ (Redis)** | RabbitMQ | Menos piezas; ya conoces Redis. Cada job lleva `organization_id` |
| Tiempo real | WebSocket (Socket.IO o equivalente) con rooms `org:{id}` | SSE | Inbox y Kanban necesitan bidireccional |
| Auth | Sesiones con tokens cortos + refresh revocable, MFA opcional | Proveedor externo (Clerk/Auth0) | Decisión D1 |
| RBAC | Roles + permisos por recurso/acción, evaluado en un guard central | Solo roles fijos | Asesores freelance exigen permisos finos |
| Storage | S3-compatible tras `StorageAdapter`, prefijo por org | Disco local | |
| **Channel Layer** | `ChannelAdapter` (WhatsApp Cloud, WhatsApp QR, Messenger, Instagram, GHL) → `NormalizedMessage` → Conversation Engine | Lógica por canal | Un nuevo canal = un adapter |
| **Telefonía** | `TelephonyProvider` (comprar/portar números, TwiML-like, WebRTC, grabación, eventos) | Acoplar a un proveedor | Proveedor sin decidir (D3) |
| **Voice AI** | Pipeline STT → LLM con herramientas → TTS, o proveedor de voz tiempo-real, detrás de `VoiceAgentProvider` | | Latencia y costo se deciden con prueba (D4) |
| **AI Engine** | Un `ToolRegistry` común (buscar/crear/modificar contacto, mover etapa, tarea, mensaje, transferir) usado por chat y voz; cada herramienta pasa por permisos y auditoría | Prompts sueltos | La IA ejecuta acciones solo a través de la misma capa que los humanos |
| **RAG** | Upload → storage → parser → chunking → embeddings → pgvector → recuperación con filtro `organization_id` + `agent_id` → fuente opcional | | Mostrar fuente = ON/OFF es flag por agente |
| **Automation Engine** | Triggers por eventos de dominio (outbox), condiciones sobre campos, acciones idempotentes, `automation_runs` con reintentos | Flow Builder visual primero | Primero el motor; el editor visual después |
| Analytics | Vistas/tablas agregadas por org; lecturas en réplica si hace falta | Data warehouse | Simplicidad |
| Audit | Tabla append-only `audit_logs` (antes/después/quién/cuándo/origen) escrita en la misma transacción | Logs de aplicación | |
| Observabilidad | Logs estructurados con `org_id`/`request_id` y redacción de PII, métricas, trazas (OpenTelemetry), Sentry | | |

### Decisiones abiertas que necesito de ti (suposiciones críticas explícitas)
- **D1 – Auth propia vs. proveedor.** Recomiendo propia con tokens revocables para no depender de un tercero; el costo es mantener recuperación de contraseña/MFA.
- **D2 – Proveedor de WhatsApp QR.** Sin decidir. Cualquiera es no oficial: riesgo de bloqueo de números. El adapter lo mitiga, no lo elimina.
- **D3 – Proveedor de telefonía.** Sin decidir. Los criterios: cobertura de números en Ecuador/LatAm, WebRTC, grabación, costo por minuto. Hace falta una comparación antes del modelo definitivo.
- **D4 – Voz IA.** Costo y latencia por llamada determinan viabilidad comercial. Recomiendo un *spike* de 2 días con 2 proveedores.
- **D5 – GHL bidireccional.** Hoy depende de Workflows manuales por cliente (paso manual documentado). Una **app OAuth en el Marketplace de GHL** permitiría suscripción automática a eventos. Es más trabajo y requiere aprobación; decide si el onboarding manual es aceptable para tus clientes.
- **D6 – ¿Migrarás datos de clientes actuales a 2.0?** Condiciona el modelo (el actual no tiene empresas/oportunidades) y el calendario.

---

## 9. Modelo de datos conceptual (Fase 23)

Convenciones: todas las tablas de negocio llevan `organization_id` (NOT NULL, RLS), `id` UUID, `created_at`, `updated_at`, `deleted_at` (borrado lógico donde aplique).

**Núcleo y acceso**
`organizations` · `users` · `memberships` (user↔org + rol; permite un usuario en varias empresas) · `roles` · `permissions` · `role_permissions` · `sessions` · `api_keys` (hash + scope)

**CRM**
`contacts` · `companies` · `contact_companies` · `pipelines` · `stages` · `opportunities` · `tags` · `taggings` (polimórfica) · `activities` · `notes` · `tasks` · `assignments` (historial de dueño)

**Campos personalizados** (corrección sobre la lista original: se separa definición, valor y configuración visual)
- `custom_field_definitions` (entidad: contact/opportunity/company; tipo; opciones; clave de variable `{{contact.ciudad}}`; validación)
- `custom_field_values` (entidad, `entity_id`, definición, valor tipado en columnas `value_text/number/bool/date/json`; **índices por tipo** para filtrar y segmentar)
- `field_layouts` (configuración **global** de campos de oportunidad por pipeline: orden, visibilidad)
- `opportunity_field_overrides` (por oportunidad: agregar/ocultar/reordenar/valor; **no toca** `field_layouts`)
- `saved_views` (tabla de contactos: columnas, orden, filtros, dueño, compartida o no)

**Inbox / canales**
`channels` (tipo) · `channel_accounts` (credenciales cifradas, estado, proveedor) · `whatsapp_accounts` (detalle Cloud API: WABA, phone_number_id) · `qr_sessions` · `conversations` · `messages` (con `external_id` único por cuenta, estado, dirección) · `message_attachments` · `conversation_participants` · `response_timers` · `sla_policies` · `business_hours` · `holidays`

**Integraciones**
`ghl_connections` (location, token cifrado, secreto de webhook) · `ghl_sync_state` · `external_ids` (mapa entidad interna ↔ externa) · `webhook_endpoints` · `webhook_deliveries` (idempotencia y reintentos)

**Telefonía / voz**
`telephony_accounts` · `phone_numbers` · `calls` (dirección, estado, duración, agente humano o IA) · `call_events` · `recordings` · `transcriptions` · `call_summaries`

**IA y conocimiento**
`ai_agents` (personalidad, objetivo, información adicional, modelo, `show_sources`) · `ai_agent_channels` · `ai_agent_conversation_state` (activo/pausado + motivo + versión, como hoy) · `ai_tool_calls` (qué hizo la IA y con qué permiso) · `knowledge_bases` · `knowledge_documents` (estado: subido/procesando/listo/error; activo) · `document_chunks` · `embeddings` (vector + `organization_id`)

**Automatización**
`automations` · `automation_triggers` · `automation_conditions` · `automation_actions` · `automation_runs` · `automation_run_steps` · `domain_events` (outbox)

**Ventas y comisiones**
`sales` · `sale_status_history` (nunca se borra: ganada → reabierta → ganada) · `sale_items` · `commission_plans` (tipo: porcentaje / fijo / por producto / por pipeline / por meta / híbrido; parámetros en JSONB versionado) · `commission_plan_assignments` · `commissions` (pendiente/pagada) · `commission_payouts` · `goals`

**Auditoría**
`audit_logs` (`entity_type`, `entity_id`, `field`, `old_value`, `new_value`, `actor_user_id`, `source` ∈ manual/IA/automatización/GHL/Meta/API, `at`) — append-only

**Correcciones a tu lista inicial:** se añaden `memberships`, `custom_field_definitions`, `field_layouts`, `opportunity_field_overrides`, `saved_views`, `sale_status_history`, `commission_plans`, `domain_events`, `webhook_deliveries` y `external_ids`; `embeddings` se fusiona con `document_chunks` si usas pgvector (una columna), y se deja separada solo si cambias de motor.

**Reglas de integridad críticas:**
- `messages (channel_account_id, external_id)` único → idempotencia ante webhooks repetidos.
- La medición de SLA se detiene al crear una `sale`, al marcar la oportunidad como ganada o al aplicar una etiqueta configurada como venta; el estado se conserva en `response_timers` con historial.
- Cambiar una oportunidad de "ganada" a otra etapa **no borra** su `sale` ni su historial.

---

## 10. UX/UI — estructura de navegación (Fase 24)

Menú lateral: **Dashboard · Inbox · Contactos · Oportunidades (Kanban/Lista) · Empresas · Agentes IA (con Knowledge Base) · Automatizaciones · Telefonía (Llamadas, Números) · Analytics · Comisiones/Asesores · Configuración (Campos, Pipelines, Canales, Integraciones, Equipo, SLA)**

Principios: tablas configurables con vistas guardadas, panel lateral de detalle (no pantallas completas), tarjeta de oportunidad con campos heredados + overrides, Inbox de tres columnas (lista · conversación · contexto CRM), indicador de SLA visible en cada conversación. El prototipo navegable (Fase 25) es la siguiente entrega.

---

## 11. User Flows (Fase 26) — resumen

Los 21 flujos quedan definidos en la entrega del prototipo con pantalla y estado de cada paso. Los de mayor riesgo y que validaré primero: **conectar WhatsApp QR** (reconexión de sesión), **conectar GHL** (D5), **IA hace/recibe llamada** (D3/D4), **IA actualiza CRM** (permisos y auditoría) y **venta → comisión** (fórmula configurable).

---

## 12. Testing y Seguridad (preliminar)

**Testing:** pirámide con unitarios de dominio; integración con BD real (testcontainers); **suite de aislamiento A↔B generada por endpoint** como puerta de CI; contract tests por adapter (WhatsApp, GHL, telefonía) con un adapter *fake*; pruebas de webhooks (firma inválida, repetidos, fuera de orden).

**Seguridad:** secretos validados al arranque (sin valores por defecto), cifrado con claves separadas y rotables, RLS, rate limit por IP/tenant/token, verificación de firma en todo webhook, URLs firmadas para archivos y grabaciones, política de retención de grabaciones, redacción de PII en logs, dependencias auditadas en CI, sin SQL interpolado (lint).

---

## 13. Roadmap propuesto

1. **Cierre de decisiones D1–D6** (esta semana).
2. **Prototipo navegable** (Fase 25) y validación contigo.
3. Build Spec + `CLAUDE.md` (Fase 28).
4. Implementación por módulos en repo nuevo: Fundaciones (auth, tenant, RLS, audit) → CRM + campos → Inbox + canales → GHL → Agentes + RAG → Automatizaciones → SLA/ventas/comisiones → Telefonía → Voz IA → Analytics.

---

## Qué NO pude verificar (para no darte falsa seguridad)
- Si `messageId` en B1 se valida antes de llegar al SQL; el resto de los 151 `findByPk`; qué hace `ApiController` con el token (B6); la verificación interna de `webHookRoutes` (B7); cuáles de los 26 modelos sin `companyId` son realmente un hueco.
- No ejecuté la aplicación ni los tests, y no leí a fondo `api_oficial` ni `api_transcricao`.
- Si quieres, la siguiente pasada puede convertir estos puntos en una lista cerrada, con un script que enumere **todas** las consultas sin filtro de empresa.
