# SALES SMART 2.0 — INVENTARIO FUNCIONAL DE ChatIA (Fase 2, rehecha)

Fecha: 2026-10-02 · Fuente: `josuequirozagencia/sales-smart` (HEAD `4c5d040`, solo lectura)

> **Corrección a la Entrega 1.** La tabla funcional de la Entrega 1 era incompleta y el primer prototipo se construyó desde tus requisitos y no desde este inventario. Este documento lista **lo que ChatIA hace hoy** y qué pasa con cada cosa en 2.0.
>
> **Cómo se levantó y su límite.** Salió de: las 48 rutas del frontend, el menú lateral con sus permisos, los 56 controladores, los modelos (campos de `Ticket`, `Contact`, `User`, `Queue`, `Whatsapp`, `Sale`, `CompaniesSettings`), los componentes y los documentos de `docs/`. **No leí el código de cada pantalla.** Cuando una función se deduce solo del nombre de un archivo o de campos del modelo, la certeza figura como *Media*. *Alta* = confirmada en documentación o en campos del modelo.

## 1. Mapa de módulos (menú real de ChatIA)

| # | Módulo ChatIA | Qué hace hoy (evidencia) | Certeza | Veredicto | Dónde vive en 2.0 |
|---|---|---|---|---|---|
| 1 | **Atención / Tickets** `/tickets` | Estados pendiente/abierto/cerrado/grupo, aceptar, transferir, cola, etiquetas, notas, temporizador de espera, logs, mensajes programados. Al cerrar: **valor de venta, motivo de no venta, motivo de finalización, "finalizado con venta"** (campos en `Ticket`) | Alta | REDISEÑAR | Inbox + `conversations` + cierre con venta |
| 2 | **Contactos** `/contacts` | Importar CSV, importar desde teléfono, listas, notas, cumpleaños, `extraInfo` clave/valor, desactivar bot, aceptar audios, `ghlContactId`, consentimiento | Alta | REDISEÑAR | Contactos con campos tipados |
| 3 | **Carteras** `/wallets` | Contacto ↔ asesor/cola; ajuste `DirectTicketsToWallets` envía tickets al dueño | Alta | REDISEÑAR | `assignments` + regla "dueño del contacto" |
| 4 | **Etiquetas** `/tags`, `/TagsKanban` | Etiquetas con color, sincronía con GHL, "etiqueta obligatoria" al cerrar (`requiredTag`), kanban por etiquetas | Alta | REDISEÑAR | Etiquetas (con marca "es venta") + pipelines reales |
| 5 | **Kanban** `/Kanban` | `KanbanPipeline` (nombre, orden, por defecto) agrupa etiquetas como columnas | Alta | REDISEÑAR | Pipelines y etapas propias |
| 6 | **Ventas** `/sales`, `/relatorio-vendas` | `Sale`: contacto, ticket, cola, asesor, **producto, total, depósito, método de pago, notas** | Alta | RECUPERAR concepto | `sales` (+ depósito y método de pago) |
| 7 | **Colas** `/queues` | Saludo, mensaje fuera de horario, horarios, **enrutador** (activar, tiempo, modo aleatorio), opciones de chatbot, integración, archivos, prompt, productos, cerrar ticket | Alta | REDISEÑAR | Colas/equipos + reglas de asignación |
| 8 | **Chatbot por cola** | `Chatbot` y `QueueOption`: menús por opciones | Alta | DESCARTAR | Lo cubren Flujos + Agentes IA |
| 9 | **Conexiones** `/connections` | WhatsApp QR (Baileys), WhatsApp oficial, Facebook/Instagram (tokens Meta). Por conexión: saludo, despedida, mensaje de cierre, **encuesta NPS**, expiración de ticket, mensaje por inactividad, grupos como ticket, **importar mensajes antiguos**, **vacaciones colectivas**, cola por defecto, flujo de bienvenida, agente/prompt, token de API | Alta | REDISEÑAR | `channel_accounts` + adapters |
| 10 | **Todas las conexiones** `/allConnections` | Vista del superadmin sobre todas las empresas | Media | RECUPERAR | Consola de plataforma |
| 11 | **Plantillas WhatsApp** `/whatsapp-templates` | Lista y crea plantillas de Meta | Alta | RECUPERAR | Plantillas por cuenta oficial |
| 12 | **Mensajes rápidos** `/quick-messages` | Atajos con texto y medios, globales o por usuario | Media | RECUPERAR | + variables de campos |
| 13 | **Agendamientos** `/schedules` | Citas y mensajes programados, panel de Google Calendar, recordatorios (`AppointmentReminder`); la cita genera evento `Schedule` a Meta | Alta | REDISEÑAR | Tareas, citas y mensajes programados |
| 14 | **Campañas** `/campaigns`, `/contact-lists`, `/phrase-lists`, `/campaigns-config`, `/campaign/:id/report` | Envíos masivos a listas, frases/variantes, configuración de intervalos, informe por envío | Media | REDISEÑAR (fase posterior) | Campañas con límites y plantillas oficiales |
| 15 | **Flow Builder** `/flowbuilders`, `/flowbuilder/:id` | Lienzo con **24 tipos de nodo**: inicio, mensaje, menú, pregunta, condición, comparar, switch de flujo, intervalo, aleatorizador, etiqueta, quitar etiqueta, ticket, atendente, HTTP request, OpenAI, Gemini, Typebot, variable, imagen, audio, video, bloque único, input | Alta | REDISEÑAR | Flujos conversacionales + Automatizaciones |
| 16 | **Integraciones** `/queue-integration` | Typebot, N8N, Dialogflow, webhooks preestablecidos y entrantes (`ActionsWebhookService`, 2.156 líneas) | Media | Webhooks: RECUPERAR · Typebot/Dialogflow: DESCARTAR | Webhooks + HTTP request |
| 17 | **Agentes IA** `/ai-agents` | Proveedor/modelo/clave por agente, un agente por conexión, conocimiento (texto/PDF/Word), horario, **seguimientos hasta 5 pasos**, chat de prueba, estado de IA por ticket, transferencia | Alta (docs) | RECUPERAR diseño | Agentes IA + KB con RAG real |
| 18 | **Prompts IA** `/prompts` | Prompts del sistema anterior | Media | DESCARTAR | Se fusiona en Agentes |
| 19 | **Créditos IA** `/ai-credits/*` | Compra y administración de créditos, precio por modelo | Alta | RECUPERAR concepto | Medición de consumo por organización |
| 20 | **GoHighLevel** `/gohighlevel` | Token cifrado, Location ID, webhook por Workflow, plantillas, etiquetas en ambos sentidos, inscribir a flujos | Alta (docs) | RECUPERAR reglas | Integración GHL |
| 21 | **Meta Conversions API** (en Configuración) | Envía Lead, Schedule y Purchase a Meta con atribución Click-to-WhatsApp (`ctwa_clid`) | Alta (docs) | RECUPERAR | Módulo de atribución (clave para tu agencia) |
| 22 | **Dashboard** `/` | Gráficos por usuario, por fecha, donut, filtros | Media | REDISEÑAR | Dashboard + Analytics |
| 23 | **Reportes / Tiempo de respuesta / Tiempo real** `/reports`, `/response-time`, `/moments` | Informes de atención, tiempos, vista en vivo por asesor | Media | REDISEÑAR | Analytics unificado |
| 24 | **Usuarios** `/users` | Perfil admin/usuario, **permisos sueltos**: ver todos los tickets, grupos, dashboard, tiempo real, conexiones, contactos, campañas, flujos, ver mensajes en pendientes, cerrar pendientes; **peso de distribución**, horario laboral, color, tema, colas | Alta | REDISEÑAR | RBAC con roles y permisos |
| 25 | **Empresas / Planes / Suscripción / Facturación** `/companies`, `/financeiro`, `Subscription` | Multiempresa, planes con límites y funciones activables, cobro con Stripe, MercadoPago, Asaas, Efí (Pix), facturas | Alta | RECUPERAR concepto | Plataforma (billing) |
| 26 | **Instantáneas y clonar empresa** | Guardar la configuración de una empresa (etiquetas, colas, chatbot, mensajes, prompts, ajustes) y cargarla en otra | Alta (docs) | RECUPERAR | Plantillas de organización |
| 27 | **Whitelabel** | Marca propia | Media | RECUPERAR (opcional) | Plataforma |
| 28 | **Ajustes de atención** | Cierre automático por horas, firma del asesor, despedida, encuesta (`userRating`), posición en cola, ignorar grupos, aceptar audios y llamadas, consentimiento de datos, ocultar número, etiqueta obligatoria, **motivos de finalización**, informar valor de venta, inactividad de sesión | Alta | RECUPERAR como requisitos | Configuración de atención |
| 29 | **Cumpleaños** `/birthday-settings` | Mensaje automático de cumpleaños | Media | RECUPERAR | Automatización |
| 30 | **API de mensajes** `/messages-api` | Envío y verificación de número por token de conexión | Media | REDISEÑAR | API pública con scopes |
| 31 | **Archivos** `/files` | Listas de archivos para colas/campañas | Media | REDISEÑAR | Biblioteca de medios + KB |
| 32 | Chat interno, Anuncios, Ayuda, ToDoList | Heredado de Whaticket | Media | DESCARTAR (ToDo → Tareas) | Tareas del CRM |
| 33 | Rotación de tickets | `TicketRotationService` + `distributionWeight` | Media | RECUPERAR | Reglas de asignación ponderada |
| 34 | Reparación de contactos LID / importar historial | Específicos de Baileys | Media | Mover al adapter QR | `EvolutionProvider` |

## 2. Qué cambia en el diseño 2.0 por este inventario

1. **El cierre de la atención con venta es central.** Hoy se captura valor, depósito, método de pago, motivo de no venta y motivo de finalización. Faltaba en el primer prototipo y debe entrar en el modelo (`sales.deposit`, `sales.payment_method`, `conversations.close_reason`, `opportunities.lost_reason`).
2. **Flujos conversacionales visuales** no son lo mismo que reglas "si/entonces". 2.0 necesita las dos cosas: el Flow Builder (24 nodos, con IA y HTTP) y el motor de automatizaciones.
3. **Colas con enrutador y horarios** son parte del núcleo de asignación; en 2.0 pasan a equipos con reglas ponderadas y horario laboral.
4. **Configuración por conexión** (NPS, inactividad, vacaciones colectivas, importar historial) debe vivir en `channel_accounts.settings`.
5. **La atribución a Meta Ads (Click-to-WhatsApp + Conversions API) es diferencial** para una agencia de tráfico: se conserva como módulo propio.
6. **Plataforma SaaS** (planes, límites por plan, instantáneas) ya existe como idea y debe seguir: planes con funciones activables.
7. **Permisos** hoy son banderas sueltas por usuario; en 2.0 se convierten en roles y permisos con la misma granularidad.

## 3. Pendiente de leer a fondo (siguiente pasada, si lo apruebas)
`wbotMessageListener.ts` (5.013 líneas, regla de negocio del Inbox), `ActionsWebhookService.ts`, `ChatBotListener.ts`, `motor.ts` (`ConfigPackageService`), `ProcessConversionJob.ts` y las pantallas de Campañas, Reportes y Tiempo real.
