# SALES SMART 2.0 — DECISIONES DE ARQUITECTURA (ADR) — 2026-10-02

Estado: aprobadas por el propietario. Sustituyen a las "decisiones abiertas" D1–D6 de la Entrega 1.

## ADR-01 Autenticación propia con `AuthProvider`
- **Decisión:** `LocalAuthProvider` ahora; `ClerkAuthProvider` posible después. Contraseñas con Argon2id.
- **Alcance:** registro, login, logout, sesiones, refresh tokens rotativos, recuperación y cambio de contraseña, verificación de email, invitaciones, auditoría de sesiones.
- **Regla de dominio:** todos los módulos usan el `user.id` interno. Ninguna tabla guarda IDs de Clerk como clave de dominio; si hace falta, se guardan en `auth_identities (user_id, provider, external_id)`.
- **Modelo propio:** `users`, `organizations`, `organization_members`, `roles`, `permissions`.
- **Ventaja:** sin dependencia externa estructural. **Costo:** mantener recuperación de contraseña, verificación y MFA. **Mitigación:** la interfaz permite delegar en Clerk sin tocar CRM/Inbox.

## ADR-02 WhatsApp: `WhatsAppProvider`
- **Decisión:** `MetaCloudProvider` (oficial) y `EvolutionProvider` (QR, **no oficial**).
- **Reglas:** el núcleo (Inbox, Conversation Engine, CRM, Automatizaciones) solo habla con `NormalizedMessage`. El canal no oficial se marca explícitamente en datos y UI. Sustituir Evolution = escribir otro adapter.
- **Riesgo asumido:** el canal QR puede desconectarse o bloquear el número. Se mostrará aviso en conexión y el estado de sesión se monitorea.

## ADR-03 Telefonía: `TelephonyProvider`
- **Decisión:** `TwilioProvider` primero. Compra y conexión de números externos, entrantes/salientes, identificación, historial, grabación, transcripción, resumen, perdidas, devolución, transferencia, espera, conferencia y WebRTC en navegador.
- **Preparado para:** Telnyx, SIP/BYOC. El núcleo no importa el SDK de Twilio.

## ADR-04 IA de voz: PoC antes de decidir
- **Decisión:** `VoiceAIProvider` con `RetellProvider` y `VapiProvider`. Proveedor definitivo tras el PoC.
- **Protocolo del PoC:** mismo agente y mismos casos en ambos. Criterios: llamadas entrantes y salientes, latencia, interrupciones, calidad, transferencia a humano, herramientas, acceso al CRM, captura de campos personalizados, actualización de oportunidades, KB/RAG, transcripción, resumen, estabilidad, errores, coste por minuto.
- **Condición:** las herramientas de voz usan el mismo `ToolRegistry` que el agente de chat (permisos y auditoría iguales).

## ADR-05 GoHighLevel: `GHL Integration Layer`
- **Decisión:** `PrivateTokenProvider` ahora (token cifrado, webhook por Workflow con secreto). `OAuthProvider` solo diseñado.
- **Razón de no hacer OAuth ahora:** no hay cuenta de agencia ni clientes externos.
- **Regla:** ningún módulo depende del tipo de credencial; leen `ghl_connections` con un `auth_type`. Conservar y mejorar lo existente: mensajes entrantes/salientes, etiquetas bidireccionales, inscripción a flujos, plantillas.
- **Límite conocido:** con Private Token no se pueden crear suscripciones de webhook; el paso del Workflow sigue siendo manual hasta tener OAuth.

## ADR-06 Migración diferida
- **Decisión:** sin Migration Engine ahora. Repo actual solo como fuente de conocimiento.
- **Preparación mínima:** columnas `legacy_id` y `legacy_source` (nullable) en `contacts`, `companies`, `opportunities`, `conversations`, `messages`, `sales`. Proceso futuro: Extract → Transform → Validate → Import.

## Consecuencias para el modelo de datos
Añadir: `auth_identities`, `organization_members`, `invitations`, `email_verifications`, `password_resets`, `session_events`; `auth_type` en `ghl_connections`; `provider` y `is_official` en `channel_accounts`; `provider` en `telephony_accounts`; `voice_provider` en la configuración del agente de voz.

## Pendientes que siguen abiertos
1. Hosting y región (latencia a Ecuador, residencia de grabaciones).
2. ORM y soporte de `SET LOCAL` para RLS (spike corto).
3. Resultados del PoC Retell vs. Vapi.
4. Política de retención de grabaciones y transcripciones.

## ADR-07 Reparto de leads configurado por cola (2026-10-02)
- **Decisión:** el reparto (round robin / ponderado / por carga) se configura **en la cola/departamento**, no en el usuario. Canales, flujos y automatizaciones envían el lead a una cola; la cola decide el asesor. Las automatizaciones pueden «Asignar a una cola» o «Asignar a asesor fijo».
- **Configuración por cola:** miembros activos, modo (equitativo, desigual con peso por miembro, menos conversaciones abiertas), leads seguidos por asesor (lote), tope diario, reasignar si no responde (min) con máximo de rotaciones, «solo contactos no asignados» (cartera primero), respetar horario laboral.
- **Alternativas:** peso en el usuario (como ChatIA: un asesor con el mismo peso en todas sus colas); reglas de reparto dentro de cada automatización (duplica la lógica).
- **Ventajas:** un asesor puede tener pesos distintos por cola; una sola fuente de verdad; la cartera se respeta; se puede simular el reparto.
- **Desventajas:** hay que mantener la membresía por cola.
- **Impacto en datos:** `queue_members(queue_id, user_id, active, weight)`, `queue_distribution_rules(queue_id, mode, batch, daily_cap, only_unassigned, respect_hours, reassign_minutes, max_rotations)`, `queue_distribution_state` (créditos del round robin), evento `lead_assigned`. `users` no guarda peso.

## ADR-08 Etiquetas fijas, venta con abono y catálogo por cola (2026-10-03)
- **Decisión:**
  1. Tres etiquetas del sistema por organización: **Lead**, **Cita agendada**, **Venta** (`tags.is_system = true`, `system_key`). No se pueden borrar ni renombrar y no se quitan a mano de un chat. Las pone el sistema por evento: Lead al primer mensaje o envío de formulario; Cita agendada al guardar una cita; Venta al guardar una venta. Si el asesor intenta agregar Venta o Cita agendada a mano, se abre el formulario correspondiente, para que la etiqueta nunca exista sin su registro.
  2. Etiquetas personalizadas: se crean desde el chat o desde Etiquetas, con nombre único sin distinguir mayúsculas.
  3. **Registrar venta** parte de la conversación: producto o servicio del **catálogo de la cola**, cantidad, total, abono y saldo calculado, método de pago. El saldo es derivado (`total - sum(pagos)`), no se guarda como dato libre.
  4. El catálogo vive en la cola (`queue_products`), no en la organización: cada departamento vende cosas distintas.
- **Alternativas:** catálogo global de la organización (más simple, pero un asesor de Barbería vería cursos de repostería); etiqueta Venta que el asesor pone a mano (permite etiqueta sin venta y métricas falsas); saldo como campo editable (se desincroniza de los pagos).
- **Ventajas:** el funnel y los eventos a Meta salen de hechos registrados, no de etiquetas manuales; una venta con abono permite cobrar saldos después sin duplicar la venta.
- **Desventajas:** hay que mantener el catálogo en cada cola; una cola sin productos no puede vender (el prototipo lo avisa).
- **Impacto en datos:** `tags(is_system, system_key)`; `queue_products(queue_id, name, kind, price, active)`; `sales(amount, currency, queue_id, product_id, conversation_id, created_by)`; `sale_payments(sale_id, amount, method, paid_at, created_by)`; `appointments` ya existente emite el evento que agrega Cita agendada. Eventos al outbox: `sale.created` (Purchase a Meta con el total), `appointment.created` (Schedule). Todo con `organization_id` y RLS.
- **Decidido (2026-10-03, Josué):** el evento Purchase a Meta se envía con el **valor total** de la venta, aunque quede saldo pendiente. Las **comisiones se calculan sobre el total** de la venta, también con saldo pendiente. Riesgo a vigilar: si el cliente nunca paga el saldo, la comisión ya generada; definir si se revierte (propuesta: regla de reversión configurable en el plan de comisión, desactivada por defecto) y cómo se cuenta una venta cancelada en el reporte de Meta.

## ADR-09 Formularios embebibles para captar leads (2026-10-03)
- **Decisión:** módulo **Formularios** con constructor de campos, destino (cola, etapa, etiqueta extra), seguimiento automático (WhatsApp con plantilla aprobada, agente IA, llamada, tarea, aviso al asesor) y tres formas de publicarlos: enlace directo, script `embed.js` (recomendado) e iframe; más un endpoint público para quien ya tiene su propio HTML.
- **Seguridad (obligatoria):** token público opaco que identifica el formulario y solo permite **enviar**; sin lectura. Dominios autorizados (Origin/Referer), límite por IP, campo trampa y captcha, validación del lado servidor, consentimiento explícito como campo, tamaño máximo. Los envíos entran por el mismo pipeline que un mensaje entrante (`NormalizedMessage` de origen `form`), no por una ruta paralela.
- **Atribución:** captura silenciosa de `utm_*`, `fbclid` y página de origen; evento Lead a Meta con **el mismo `event_id`** en Pixel y Conversions API para deduplicar.
- **Regla de WhatsApp:** el primer mensaje a quien no escribió antes debe ser una plantilla aprobada por Meta. Por canal QR no hay plantillas, pero sí riesgo de bloqueo; el prototipo lo advierte.
- **Alternativas:** integrar un formulario de terceros (Typeform, GHL) con webhook (más rápido, pero depende de otro proveedor y pierde la atribución); solo API sin constructor.
- **Ventajas:** captación propia sin pagar otra herramienta; el lead cae en la cola correcta y se reparte con su regla; el seguimiento arranca en segundos.
- **Desventajas:** superficie pública nueva (abuso, spam, XSS en el embed); hay que alojar `embed.js` y mantenerlo compatible.
- **Impacto en datos:** `forms(id, organization_id, public_token, status, queue_id, stage_id, extra_tag_id, follow_up jsonb, allowed_domains, thanks, redirect)`, `form_fields(form_id, type, label, maps_to, required, options, position)`, `form_submissions(form_id, contact_id, payload jsonb, utm jsonb, ip_hash, event_id, created_at)`. Índice único `(form_id, idempotency_key)` para reintentos.

## ADR-10 Llamadas masivas tipo call center (2026-10-03)
- **Decisión:** campañas de llamadas sobre una lista existente o una base subida (CSV; XLSX queda para después), con modos **progresivo** (una llamada por asesor libre) y **vista previa** (el asesor ve la ficha y decide marcar). **Predictivo no entra en la primera versión**: exige un límite de llamadas abandonadas y es el modo más regulado.
- **Reglas:** intentos máximos y espera entre intentos por contacto, ventana horaria, número saliente elegido, exclusión de contactos «no llamar», resultado obligatorio por llamada (interesado, agendó cita, no interesado, volver a llamar) que dispara etiqueta, etapa y tarea. Grabación y transcripción solo con aviso de grabación. Quién llama: asesores de la cola o, tras el PoC, el agente de voz IA.
- **Alternativas:** marcador predictivo desde el inicio (más llamadas por hora, pero riesgo regulatorio y de llamadas mudas); no ofrecerlo y dejar que usen otra herramienta.
- **Ventajas:** reutiliza telefonía, contactos, colas y el `ToolRegistry`; el resultado de cada llamada alimenta la conversión por asesor.
- **Desventajas:** depende de la capacidad concurrente y de las tarifas del proveedor (Twilio primero); la entregabilidad de números en Ecuador debe validarse; hay obligaciones de consentimiento y horario que dependen de la normativa local, a revisar antes de lanzar campañas reales.
- **Impacto en datos:** `call_campaigns(id, organization_id, name, list_id|upload_id, mode, caller_type, queue_id, max_attempts, retry_minutes, window, from_number_id, script, status)`, `call_campaign_items(campaign_id, contact_id, phone, state, attempts, next_attempt_at, result)`, `call_attempts(item_id, call_id, started_at, duration, outcome)`. Worker BullMQ con límite de concurrencia por organización y por proveedor.

## ADR-11 Rol Agencia: cambio de cliente sin cerrar sesión (2026-10-03)
- **Decisión:** una organización de tipo `agency` administra organizaciones cliente. Un usuario de agencia tiene **una sola identidad** y membresías en varias organizaciones (`organization_members`), con rol y nivel de acceso **por cliente** (sin acceso, solo lectura, asesor, administrador). Cambiar de cliente cambia el **contexto activo** (`org_id` de la sesión), no vuelve a autenticar; el servidor valida la membresía en cada petición y fija `SET LOCAL app.org_id`.
- **Seguridad:** cada acción hecha desde el contexto de agencia queda en la auditoría **del cliente** con `acting_as = agency`; el cliente puede revocar el acceso; los datos de un cliente nunca se mezclan en una misma consulta. La consola «Mis clientes» solo muestra métricas agregadas permitidas, no contenido de conversaciones.
- **Alternativas:** una cuenta de usuario distinta por cliente (obliga a cerrar sesión, lo que se quiere evitar); token de suplantación (impersonation) sin membresía real (más difícil de auditar y revocar).
- **Ventajas:** encaja con ADR-01 (auth propia, `user.id` interno); sirve también para marca blanca en el futuro; crear clientes desde una instantánea de configuración reutiliza el motor de snapshots recuperado de ChatIA.
- **Desventajas:** la lógica de permisos es más compleja (rol por organización); hay que decidir el modelo de facturación (¿paga la agencia o cada cliente?).
- **Impacto en datos:** `organizations(kind, parent_agency_id)`, `organization_members(user_id, organization_id, role, access_level, granted_by, revoked_at)`; `audit_log(acting_as, acting_org_id)`; el selector de contexto de sesión en el token de acceso.
- **Límite del prototipo:** al cambiar de cliente solo cambian el nombre y la etiqueta de organización; los datos de ejemplo no cambian.

## Consecuencias adicionales para el modelo de datos (2026-10-03)
`tags(is_system, system_key)`, `queue_products`, `sale_payments`, `forms`, `form_fields`, `form_submissions`, `call_campaigns`, `call_campaign_items`, `call_attempts`, `organizations(kind, parent_agency_id)`, `audit_log(acting_as)`. Métrica nueva: **conversión lead→venta por cohorte** (ventas de los leads creados en el periodo ÷ leads creados), por asesor, cola y fuente, con muestra mínima de 20 leads para entrar al ranking.

## ADR-11 (enmienda 2026-10-03): jerarquía de roles y facturación
- **Decisión (Josué):** tres niveles de rol. **Súper Admin** (dueño de la plataforma): única persona con la pantalla de Plataforma, donde agrega agencias o da el rol de agencia a una empresa existente, suspende o retira el rol. **Agencia**: obtiene la pantalla «Mis clientes» para registrar clientes; solo puede entrar y pasar de un cliente a otro entre **los clientes que ella registró**, sin cerrar sesión. **Cliente**: ve solo su organización.
- **Facturación:** **el cliente paga su propio plan.** La agencia no paga por sus clientes. Cada cliente tiene su suscripción y sus créditos de IA y voz; la agencia ve el estado (activa, prueba, vencida) pero no el detalle de pagos.
- **Consecuencias para el modelo:** `organizations(kind, parent_agency_id, created_by_agency_id)`; `agency_grants(organization_id, granted_by_super_admin, status, granted_at, revoked_at)`; `organization_members.access_level` por cliente; la agencia solo lista organizaciones donde `parent_agency_id = su organización`. Suscripción y créditos viven en la organización cliente (`subscriptions.organization_id`).
- **Casos a definir:** si se retira el rol a una agencia, sus clientes pasan a administración directa (propuesta) en vez de quedar huérfanos; una agencia suspendida no puede entrar a sus clientes pero los clientes siguen funcionando; qué pasa si un cliente vencido sigue siendo accesible a la agencia (propuesta: solo lectura).
- **Prototipo:** selector «Ver como» (Súper Admin, Agencia, Cliente) para validar qué ve cada rol. Súper Admin ve Empresas y planes › Agencias. Agencia ve Mis clientes y el cambio de cliente. Cliente no ve ninguno de los dos.

## ADR-12 Pipelines múltiples con etapas editables (2026-10-03)
- **Decisión:** una organización puede tener **varios pipelines** (p. ej. Cursos, Barbería, Renovaciones) y cada pipeline sus propias etapas: crear, renombrar, reordenar y eliminar. Cada oportunidad pertenece a un solo pipeline. Un pipeline marca una etapa como **ganada** (`is_won`); es la que se usa al registrar una venta y la que cuenta como cierre en analítica y en Purchase a Meta. Mínimo 2 etapas.
- **Reglas:** eliminar una etapa con oportunidades las mueve a la anterior (o a la siguiente si era la primera); no se puede eliminar la etapa ganada sin marcar otra; un pipeline solo se elimina si no tiene oportunidades; renombrar una etapa no rompe referencias porque en datos se referencia por id, no por nombre. Formularios, importaciones y reglas eligen pipeline y etapa inicial. Agendar una cita mueve la oportunidad al menos a la tercera etapa (propuesta: configurable por pipeline).
- **Alternativas:** pipeline único con etapas fijas (como el prototipo anterior); Kanban armado con etiquetas (como ChatIA, frágil porque mezcla clasificación y proceso).
- **Ventajas:** cada departamento mide su embudo propio; la conversión por asesor y por cola se calcula por pipeline sin mezclar procesos distintos.
- **Desventajas:** analítica entre pipelines necesita normalizar etapas (usar «ganada» y «perdida» como categorías comunes); más configuración.
- **Impacto en datos:** `pipelines(id, organization_id, name, position)`, `pipeline_stages(id, pipeline_id, name, position, kind ∈ open|won|lost)`, `opportunities(pipeline_id, stage_id)`, `queues.default_pipeline_id` (propuesta), `stage_history(opportunity_id, from_stage_id, to_stage_id, user_id, origin)`. Índice único `(pipeline_id, lower(name))` en etapas.

## Nota de diseño visual (2026-10-03)
Referencias de Josué: dashboard oscuro violeta con tarjetas de degradado y esquinas redondeadas, app móvil clara con tarjeta de saldo oscura y acento índigo, y app oscura con degradados cálidos. Aplicado al prototipo: acento violeta/índigo con degradado, tipografía Plus Jakarta Sans, tarjetas de 16 px, primera tarjeta de indicadores como tarjeta destacada oscura, navegación activa con degradado y barra inferior móvil redondeada, en tema claro y oscuro.

## ADR-13 Recordatorios de cita: tope por fuente (2026-10-03)
- **Decisión (Josué):** al agendar se pueden configurar hasta **3 recordatorios**; si la fuente del lead es **WhatsApp QR, Messenger o Instagram**, hasta **5**. Cada recordatorio es «N minutos/horas/días antes» y se envía por el mismo canal de la conversación.
- **Regla de fuente:** aplica si la fuente del contacto **o** el canal de la conversación es uno de esos tres. El tope vive en configuración de la organización (`appointment_reminder_limits`), no en el código, para poder cambiarlo.
- **Suposición a confirmar:** la razón del tope mayor es que en esos canales el recordatorio no consume plantillas aprobadas de pago como en WhatsApp oficial. Si la razón real es otra, la regla puede cambiar. Ojo: Messenger e Instagram tienen su propia ventana de mensajería (24 h, ampliable con etiqueta de agente humano), así que un recordatorio fuera de ventana puede no entregarse; el sistema debe mostrar el estado de entrega, no asumir que llegó.
- **Alternativas:** tope único; sin tope (riesgo de spam y de bloqueo del número QR).
- **Impacto en datos:** `appointment_reminders(appointment_id, offset_minutes, channel, status, scheduled_at, sent_at)`; validación del tope en el servidor (nunca solo en la interfaz); job programado en BullMQ.

## ADR-14 Transferir vs. compartir una conversación (2026-10-03)
- **Decisión:** dos acciones distintas desde el botón «Transferir» del chat. **Transferir** cambia el dueño del lead (con él van SLA y comisión) y puede dejar al anterior como colaborador. **Compartir** da acceso al mismo chat a otro asesor **sin cambiar el dueño**; el dueño conserva SLA y comisión. Permiso del colaborador: puede responder o solo ver y dejar notas internas. Ambas dejan nota interna en el historial y se pueden revocar.
- **Selector:** muestra disponibilidad, carga de chats activos y si el asesor pertenece a la cola; avisa si está fuera de la cola.
- **Alternativas:** una sola acción de transferir (obliga a perder el lead para pedir ayuda); copiar la conversación (duplica datos y rompe el historial único).
- **Impacto en datos:** `conversation_participants(conversation_id, user_id, role ∈ owner|collaborator, permission ∈ reply|view, added_by, revoked_at)`; `contacts.owner_id` sigue siendo el dueño; `lead_transferred` y `conversation_shared` al `audit_log`. La visibilidad de un asesor es `owner_id = yo OR existe participante activo`, aplicada en servidor/RLS, no en la interfaz.
- **Pendiente:** quién cobra comisión si el colaborador cierra la venta (propuesta: el dueño, con porcentaje compartido opcional).

## ADR-15 Dashboard con widgets configurables (2026-10-03)
- **Decisión:** el dashboard se compone de widgets con **orden configurable por usuario** (arrastrar o flechas), **filtro de fechas** (hoy, 7 días, 30 días, este mes, mes anterior, personalizado hasta 92 días) y un **ojo por tarjeta** que oculta o muestra su información (difuminada, para uso en pantalla compartida). Widget principal grande: **valor generado en ventas** (total, cobrado, por cobrar, ventas, ticket promedio, comparación con el período anterior y meta).
- **Reglas:** el orden y los widgets ocultos son preferencias del usuario (`user_dashboard_prefs`), no de la organización; los valores salen de consultas agregadas con rango de fechas y siempre con `organization_id`; el asesor ve solo sus cifras y no el widget de conversión por asesor.
- **Alternativas:** dashboard fijo; constructor libre de gráficos (más caro y fuera del alcance de la primera versión).
- **Límite del prototipo:** las cifras son sintéticas y cambian según el rango; el ojo solo oculta en pantalla, no es una medida de seguridad.
- **Impacto en datos:** `user_dashboard_prefs(user_id, organization_id, layout jsonb, hidden jsonb, default_range)`; consultas sobre `sales`, `sale_payments`, `leads` por fecha.

## ADR-16 Filtros de la lista de chats y permisos de visibilidad (2026-10-03)
- **Decisión:** la lista de chats tiene filtros por **asesor, fuente, cola, etiqueta, SLA y no leídos**, con chips de filtros activos. El filtro por asesor **solo existe para administradores y roles superiores**. Un asesor ve únicamente sus chats y los que le compartieron.
- **Regla de seguridad:** la restricción se aplica en la consulta del servidor (y RLS por organización); ocultar el selector en la interfaz no es la medida de seguridad.
- **Alternativas:** que todos los asesores vean todos los chats de su cola (más colaboración, pero expone datos y facilita robo de leads).
- **Impacto:** índices por `(organization_id, owner_id, status)` y `(organization_id, channel)`; permiso `inbox.view_all`.

## ADR-17 Composer completo y navegación móvil (2026-10-03)
- **Composer:** adjuntar imagen, video y documento; emojis; audio (grabación); programar mensajes (día y hora, cancelable, se cancela si el cliente responde antes); modo **Nota interna** claramente separado de «Responder» (una nota nunca sale al cliente). Con WhatsApp oficial, fuera de las 24 h solo plantillas aprobadas.
- **Adjuntos:** subida a almacenamiento por URL firmada, antivirus y límite de tamaño por canal; el mensaje guarda la referencia, no el binario. Los límites de cada canal difieren y deben validarse por proveedor.
- **Móvil (corrección):** la altura de la vista se calcula con `visualViewport` (no solo `100dvh`) y las áreas seguras (`safe-area`) solo se aplican en modo instalado, porque en visores integrados (iframe de aplicaciones) el contenedor ya las descuenta y se duplicaba el margen (banda en blanco arriba, compositor cortado abajo). Se debe verificar en un iPhone real y en el visor de Claude/Safari.
- **Menú móvil (propuesta B):** barra inferior con Inicio, Inbox, **botón central «+»** (acciones rápidas: registrar venta, agendar, nuevo contacto, nueva oportunidad, llamar, importar), Pipeline y **Menú**. El Menú abre una hoja con **buscador**, **favoritos fijables** (estrella) y secciones **plegables** en lista, en lugar de la cuadrícula de iconos.
- **Impacto en datos:** `message_attachments(message_id, storage_key, mime, size, checksum, scan_status)`, `scheduled_messages(conversation_id, body, send_at, status, created_by)`, `user_nav_pins`.

## ADR-18 Decisiones de Josué sobre comisiones, Meta, etapas y agencias (2026-10-03)
- **Comisión con saldo impago:** regla de reversión **configurable** por plan de comisión (desactivada por defecto). Si se revierte, el asesor ve el ajuste con motivo; no se borra el historial.
- **Compras canceladas y Meta (CONFIRMADO por el usuario el 2026-10-03, con verificación en la documentación de Meta):** (1) el Purchase se emite desde el outbox con una **ventana de gracia configurable por organización** (por defecto 30–60 min, máximo 24 h) implementada como job diferido propio; si la venta se anula dentro de la ventana, el job se cancela y Meta nunca lo recibe. Meta lo permite: `event_time` puede tener hasta 7 días de antigüedad (si se excede, rechaza todo el lote) y recomienda enviar «cuando ocurren»; se envía con `event_time` real de la venta y `event_id` estable. (2) Pasada la ventana, el Purchase queda enviado con el valor total. (3) **No existe un evento estándar «SaleCancelled» en Meta**; solo se puede enviar un **evento personalizado** con nombre propio (p. ej. `SaleCanceled`), apagado por defecto, que no optimiza campañas y sirve para reportes, audiencias y exclusiones. (4) La documentación consultada (parámetros de evento y buenas prácticas de Conversions API) **no describe cómo retirar, editar o reembolsar un evento enviado**; se asume definitivo, **por validar con una prueba real en Events Manager** antes de construir. Reportes internos en **ventas netas** (`sale.cancelled`). Riesgo: cancelaciones frecuentes inflan lo que Meta cree que convierte; se mide la tasa de cancelación por campaña.
- **Comisión de chat compartido:** la cobra el **dueño del lead**; porcentaje compartido con el colaborador **opcional** (`commission_splits`).
- **Etapas ocultas, no eliminadas:** cada etapa puede **ocultarse** (tablero y selectores) sin perder oportunidades ni historial (`pipeline_stages.is_hidden`); la etapa ganada no se puede ocultar. Cada pipeline puede marcar una **etapa de cita** (`pipelines.appointment_stage_id`, opcional): al agendar, la oportunidad pasa a ella. El evento **Schedule a Meta se dispara por la cita, no por la etapa**, así que se informa aunque el negocio oculte la etapa o no tenga ninguna. Sustituye la regla «mínimo 3.ª etapa».
- **Agencia retirada:** los clientes pasan a **administración directa del Súper Admin**, con historial de a quién pertenecieron (`organization_ownership_history(organization_id, agency_id, from, to, reason, by)`). Agencia suspendida: no entra a sus clientes; cliente vencido: la agencia lo ve en solo lectura.
- **Recordatorios 5 en QR/Messenger/Instagram:** confirmado como regla de negocio (ADR-13).
- **Analítica:** cada pestaña permite **ver el reporte** (tabla) y **descargar CSV** del período elegido; exportar requiere permiso `export` y queda en auditoría. Formatos XLSX/PDF después.

## ADR-19 Ajustes de la revisión en laptop (v10) y modelo de Créditos IA (2026-10-03)
- **Interfaz (decidido):** (1) columna de datos del contacto con botón abrir/cerrar y apertura al pulsar el nombre; en pantallas ≤1180 px se abre como panel. (2) Agendar, Editar, Finalizar, Venta, Transferir y Exportar salen como **popup centrado**; el panel lateral queda solo para el detalle de oportunidad. (3) Llamar abre un **marcador tipo celular** (teclado, retroceso, Enter, Esc) y, con la llamada en curso, una píldora flotante para volver. (4) Contactos: listas con nombre al crear, renombrar/duplicar-validar/eliminar, selección por casilla y **descarga solo de lo seleccionado**. (5) Pipeline: color por etapa **solo en el encabezado**, editor de etapas en popup, filtro (búsqueda, fuente, etiqueta, valor mínimo). (6) Conexiones: tarjetas con logo; solo 4 tipos (WhatsApp oficial, WhatsApp QR, Messenger/Instagram, GoHighLevel); sin botón «Nueva conexión» por ahora. (7) Barra lateral siempre oscura; pestaña Configuración › Apariencia con tres temas (violeta por defecto, verde neón, rojo neón), todos con degradado, y modo claro/oscuro/automático; tipografía base 12,5 px en escritorio.
- **Créditos IA — decisión:** una sola clave de OpenAI del Súper Admin alimenta a todas las organizaciones. Cada organización tiene un **monedero de créditos** (libro de movimientos: bienvenida, regalo, recarga, uso). El Súper Admin entrega créditos de prueba, define costo por crédito y **margen global y por organización**; el cliente y la agencia solo ven el **precio final** del paquete. Recarga con tarjeta, recarga automática opcional y opción «usar mi propia clave».
- **Reglas de seguridad:** el costo y el margen se calculan y aplican **solo en el servidor**; nunca se envían al navegador del cliente (verificado en el prototipo: la vista de cliente no contiene «margen» ni «OpenAI»). Datos de tarjeta nunca pasan por nuestro servidor: campos tokenizados del procesador (PCI). El saldo es derivado del libro de movimientos (no un campo editable). Cada entrega de créditos queda en auditoría. Descontar saldo debe ser atómico (transacción con bloqueo por organización).
- **Alternativas:** facturar el uso real de OpenAI a posteriori (impredecible para el cliente); clave de OpenAI por cliente (el cliente gestiona su costo, pero no hay margen para la plataforma); margen visible (descartado por el propietario).
- **Ventajas:** ingreso recurrente con margen propio; el cliente no puede quedar con deuda; un solo punto de control de costos. **Desventajas:** la clave compartida es punto único de fallo (si se agota el límite de OpenAI, se detienen todos los agentes) → alerta de consumo y de saldo bajo; hay que mantener la tabla de equivalencias créditos↔tokens/minutos.
- **Impacto en datos:** `ai_wallets(organization_id, balance_cache)`, `ai_ledger(id, organization_id, kind ∈ use|topup|welcome|grant, credits, amount_usd, cost_usd, margin_pct, ref, created_by, created_at)`, `ai_pricing(cost_per_credit, global_margin_pct)`, `ai_org_pricing(organization_id, margin_pct)`, `payment_methods(organization_id, processor_token, brand, last4, exp)`, `ai_packages(credits, discount_pct)`, `ai_auto_topup(organization_id, threshold, package_id)`. Todo con `organization_id` y RLS; márgenes y costos solo legibles por el rol Súper Admin.
- **Suposiciones a confirmar:** los «4 tipos» de conexión son los indicados arriba; la pasarela de pago aún no está elegida (la referencia mostraba AllDigital Pay); las agencias **no** transfieren créditos a sus clientes (revendedor) por defecto; costo $0,01/crédito y margen 100 % son valores de ejemplo. Logos de marca: el prototipo usa glifos genéricos; los oficiales se incorporan al construir.
- **Límite del prototipo:** el tema se guarda en el navegador del visitante; la compra, las tarjetas y los saldos son simulados.

## ADR-20 Agentes IA en galería, con foto y prueba en celular; vocabulario conexiones/integraciones/proveedores (2026-10-03)
- **Decisión (Josué):** la pantalla Agentes IA pasa de lista + detalle a **galería de tarjetas** (foto circular, portada de color, estado, capacidades visibles, canales y documentos). Pulsar una tarjeta abre un **popup grande** con 5 pestañas: General (foto, nombre, descripción, proveedor/modelo, temperatura, límites, activo), Instrucciones (personalidad, objetivo, información adicional, variables y vista previa), Conocimiento (documentos que este agente puede usar, mostrar fuente), Comportamiento (dividir respuestas, voz, audios, imágenes, transferencia a humano y cola, 24/7, seguimiento hasta 5 pasos, disponible en flujos, canales) y **Probar**.
- **Probar:** simulador con marco de celular (chat tipo WhatsApp), «probar como» un contacto de ejemplo para llenar variables, atajos (precio, cupos, asesor, audio, foto), y un registro «qué hizo el agente» (documento consultado, variable usada, transferencia, respuesta dividida, rechazo por capacidad apagada). Un agente sin documentos **no inventa** el dato y ofrece un asesor.
- **Reglas para construir:** la prueba usa el modelo y las instrucciones guardadas del agente, **no envía mensajes a clientes ni crea contactos**, y su consumo se descuenta de Créditos IA marcado como `kind = test` (suposición: así se evita abuso y se ve el costo real; alternativa: prueba gratis con tope diario). La foto se sube a almacenamiento con URL firmada, tamaño máximo y verificación de tipo. Un canal usa como máximo un agente a la vez (restricción única `(channel_id)` en `agent_channels`). Los documentos asignados a un agente deben pertenecer a su misma organización (RLS y comprobación de `organization_id` en `agent_documents`).
- **Alternativas:** mantener la lista a la izquierda (menos visual con varios agentes de varias empresas); prueba como pestaña de pantalla completa (ocupa más, pero el popup mantiene el contexto); prueba solo con conversaciones reales (arriesga clientes).
- **Ventajas:** el agente se valida antes de activarlo; se ve de un vistazo qué hace cada uno. **Desventajas:** la prueba consume créditos; las respuestas del prototipo son simuladas por reglas, no un modelo real.
- **Impacto en datos:** `agents(id, organization_id, name, role, photo_key, cover, active, provider, model, temperature, max_tokens, max_chars, personality, objective, extra_info, show_source, split_enabled, split_blocks, voice_reply, hears_audio, reads_images, transfer_enabled, transfer_queue_id, always_on, followup_enabled, followup_steps, in_flows)`, `agent_documents(agent_id, document_id)`, `agent_channels(agent_id, channel_id UNIQUE)`, `agent_test_runs(agent_id, user_id, transcript jsonb, credits_used)`.

### Vocabulario acordado: conexión, integración, proveedor
- **Proveedor** = la **empresa externa** que presta un servicio (Meta, Twilio, OpenAI, Evolution, Retell/Vapi, GoHighLevel). En el código es un **adaptador** intercambiable (`WhatsAppProvider`, `TelephonyProvider`, `VoiceAIProvider`, `AIProvider`).
- **Conexión** = **un canal concreto ya enlazado** a una organización (ej.: el WhatsApp +593 98… de Cliente A). Tiene estado (conectada/desconectada), credenciales cifradas y por ella entran y salen mensajes. Pantalla **Conexiones** (tarjetas): `channel_accounts`.
- **Integración** = **enlace de datos o acciones con otra plataforma** que no es un canal de chat: GoHighLevel (etiquetas, flujos), Meta Conversions API, calendarios, pagos. Pantalla **Configuración › Integraciones y proveedores**. Una integración puede apoyarse en una conexión (GHL aparece como tarjeta porque también trae mensajes).
- Regla de nombres en la interfaz: «Conexiones» = canales activos de la empresa; «Integraciones» = servicios externos con datos; «Proveedores» = qué empresa hay detrás (lo elige el Súper Admin/administrador, el asesor no lo ve).

## ADR-21 Proveedores solo Súper Admin, colas en tarjetas, pipeline pastel y cambio de cuenta (2026-10-03)
- **Proveedores (decidido, recomendación aceptada):** la pantalla de proveedores (qué empresa presta WhatsApp, telefonía, IA de texto/voz, almacenamiento, vector DB, y sus credenciales) se mueve a **Empresas y planes › Proveedores, visible solo para el Súper Admin**. Agencia y cliente ven **Integraciones** (GoHighLevel con su propio token, Meta Conversions, formularios, calendario) y **Conexiones** (sus números y cuentas). Razones: (1) seguridad: las credenciales de plataforma (Twilio, OpenAI, Evolution) no deben ser visibles ni editables por terceros; (2) negocio: el margen de Créditos IA y el costo del proveedor son del Súper Admin; (3) simplicidad: un cliente no puede ni debe elegir proveedor. Excepción prevista: credenciales **propias** del cliente (su token de GHL, su píxel de Meta, «usar mi propia clave» de IA) sí las gestiona el cliente. Esto **enmienda la ubicación** indicada en el ADR-20 (antes Configuración › Integraciones y proveedores). Permiso de servidor: `platform.providers.manage` solo para `super_admin`; la lectura de `provider_credentials` está bloqueada por RLS/rol para el resto.
- **Colas y asignación en tarjetas:** misma galería que los agentes (color, estado del reparto, asesores, productos, agente, flujo). Pulsar abre un popup grande con identidad (nombre, color) y toda la configuración existente (reparto, mensajes y horario, catálogo de productos, automatización). «Nueva cola» crea una cola real; el nombre solo se edita en colas nuevas porque en el prototipo otras partes la referencian por nombre (en producción se referencia por id y será editable siempre).
- **Temas de color:** verde y rojo neón pierden el brillo/sombra de color detrás de botones, menú y tarjetas (`--glow` transparente) y su degradado se suaviza para quedar planos como el violeta, conservando el tono.
- **Pipeline:** columnas con encabezado **pastel** (paleta de 8 pasteles armonizada con el violeta; en modo oscuro se mezcla con la superficie), conteo y monto bajo el nombre, flecha para plegar la etapa, y tarjetas con insignia del asesor e iconos de acción (llamar, chat, etiquetas con contador, notas, tareas, citas).
- **Cambio de cuenta sin cerrar sesión:** el **Súper Admin** también puede entrar a cualquier organización (agencias y clientes) y volver a la plataforma; la **Agencia** solo a los clientes que registró (ADR-11). Una sola identidad, contexto activo en la sesión (`org_id` activo), validación de membresía en cada petición y `SET LOCAL app.org_id`. Cada entrada y acción queda en la **auditoría del cliente** con `acting_as = super_admin | agency`, y el banner superior lo recuerda. Riesgo a vigilar: el Súper Admin ve datos de clientes; registrar el motivo de acceso y permitir que el cliente vea el historial de accesos. Límite del prototipo: al cambiar de cuenta solo cambian el nombre y la etiqueta, no los datos de ejemplo.

## ADR-22 Carteras de agencias administradas por el Súper Admin e historial de accesos privado (2026-10-03)
- **Decisión (Josué):** (1) El **Súper Admin** puede **agregar o quitar clientes de la cartera de una agencia** y cambiar un cliente de una agencia a otra o a administración directa. Ni la agencia ni el cliente lo hacen solos. (2) El **historial de accesos** (quién entró a qué cuenta de cliente, cuándo y cuánto tiempo; Súper Admin y agencias) **solo lo ve el Súper Admin**. No se pide motivo de acceso por ahora.
- **Reglas:** mover un cliente solo cambia `organizations.parent_agency_id`; sus datos, plan, facturación y créditos no cambian. Al quitarlo, la agencia (y sus miembros) pierde el acceso al instante: se cierran sus sesiones de contexto en ese cliente y se revocan las membresías `organization_members` de agencia. Al agregar, la agencia recibe acceso con el nivel por cliente definido en ADR-11. Opción de **avisar por correo al administrador del cliente** (activada por defecto). Retirar el rol de agencia deja sus clientes en administración directa (ADR-18).
- **Alternativas:** que la agencia pueda «reclamar» un cliente con un código (más autonomía, pero abre disputas por clientes); que el cliente apruebe el cambio (más transparente, más fricción).
- **Ventajas:** control central de quién administra a quién; trazabilidad de la cartera. **Desventajas:** el Súper Admin es cuello de botella y punto de confianza; todo cambio exige su intervención.
- **Impacto en datos:** `organizations.parent_agency_id` (nullable = administración directa); `organization_ownership_history(id, organization_id, from_agency_id, to_agency_id, reason, notify_client, changed_by, changed_at)` (ya prevista en ADR-18); `access_sessions(id, actor_user_id, actor_role, organization_id, started_at, ended_at, ip_hash)` con lectura restringida al rol `super_admin` (RLS por rol y sin exposición en la API de cliente ni de agencia).
- **Decisión pendiente (a confirmar con Josué):** el historial de **accesos** (entradas y salidas) es privado del Súper Admin; pero el registro de **acciones** hechas dentro de la cuenta (qué se cambió) hoy sigue marcándose «actuando como Súper Admin/agencia» en la auditoría del cliente. Mi recomendación es mantener esa marca visible para el cliente: es la prueba de quién tocó sus datos, ayuda a cumplir la normativa de protección de datos personales y evita disputas. Si prefieres ocultarla, queda solo como registro interno del Súper Admin.
- **Prototipo:** Empresas y planes › Agencias › «Cartera» (popup con clientes, quitar, agregar, historial), pestaña «Clientes y carteras» (cambiar la administración de cada cliente) y pestaña «Accesos» (solo Súper Admin). La agencia solo ve en «Mis clientes» y en el selector a los clientes de su cartera.

---

## ADR-23 — Acceso (login/registro), prueba de 7 días y extensión de 3 días

**Decisión**
1. Pantallas de acceso: login, recuperar contraseña (mensaje que no revela si el correo existe), registro, verificación por código de 6 dígitos y pantalla de prueba vencida.
2. Autorregistro = empresa nueva con acceso a todo, 7 días, sin tarjeta. La prueba empieza al verificar el correo.
3. Una sola extensión de 3 días por cuenta, solicitada por el cliente con motivo; requiere aprobación del Súper Admin (notificación: insignia en navegación + pestaña "Pruebas" en Plataforma + correo).
4. Si se aprueba antes de vencer, suma al fin; si ya venció, cuenta desde la aprobación.
5. Al vencer: cuenta en pausa, overlay con "Elegir plan" / "Pedir 3 días más" (si no se usó). Datos retenidos 30 días (propuesta, configurable en `trialCfg`).
6. Anti-abuso: dominios desechables bloqueados, correo duplicado bloqueado, captcha, bloqueo tras 5 intentos, errores genéricos.
7. Créditos IA de bienvenida para la prueba (ej. 1000; cifra de ejemplo).
8. Resuelve el pendiente de ADR-22: la marca "actuando como Súper Admin/Agencia" SÍ es visible para el cliente en su auditoría de acciones; el historial de entradas/salidas sigue siendo exclusivo del Súper Admin.

**Alternativas**: prueba con tarjeta; extensión automática; extensión ilimitada; ocultar al cliente la marca "actuando como".

**Ventajas**: baja fricción de entrada; control del Súper Admin sobre abuso; transparencia y cumplimiento de protección de datos.
**Desventajas**: carga operativa de aprobar extensiones; riesgo de cuentas de prueba duplicadas (mitigado con reglas).
**Impacto**: tabla `trials` (org_id, owner, start, days, ext{status, reason, decided_by, at}), `trial_config`, jobs de vencimiento y purga, envío de correos transaccionales, rate limiting en auth. Pendiente: pasarela de pago, login con Google (no incluido).

---

## ADR-24 — ORM y contexto de organización con RLS (resultado del spike de M0)

**Estado: APROBADO por Josué (2026-10-03: Drizzle como ORM oficial; 2026-10-04: enmienda P11).** Evidencia completa en `spikes/orm-rls/RESULTS.md` (código descartable; no pasa al producto).

### Decisión propuesta
**Drizzle ORM (driver `node-postgres`) con PostgreSQL 16 + RLS.** Versiones **fijadas exactamente** (hoy 0.45.3 / drizzle-kit 0.31.11) y toda la base de datos encapsulada en un módulo `db` para poder sustituir el ORM sin tocar el dominio.

### Qué demostró el spike
1. **El aislamiento lo da PostgreSQL, no el ORM.** Con `app_rw` (sin BYPASSRLS, sin ser dueño) + `FORCE ROW LEVEL SECURITY` + política que falla cerrado, **ambos** ORMs pasaron los mismos escenarios: sin contexto no ven ni escriben nada; A no puede leer, actualizar, borrar ni insertar en B (ni por id, ni por JOIN, ni con SQL crudo y `OR 1=1`); 40 transacciones concurrentes intercaladas con pool de 4 → 0 fugas; el contexto no sobrevive al commit.
2. **El anti-patrón es real:** fijar el contexto a nivel de sesión (`set_config(..., false)`) **filtra** datos entre peticiones en una conexión reutilizada (S14, demostrado en ambos).
3. **Advisory locks:** `pg_advisory_xact_lock` serializó un read-modify-write (sin lock 6/20 incrementos; con lock 20/20) y no dejó locks al terminar la transacción.
4. **Obligatoriedad por construcción:** una transacción con marca de tipo (`TenantTx`) hace que un repositorio **no compile** si recibe el cliente crudo o una transacción sin contexto (ambos ORMs). El respaldo final es la BD (falla cerrado).

### Por qué Drizzle y no Prisma (diferencias reales, no de seguridad)
| Criterio | Drizzle | Prisma 7 |
|---|---|---|
| Seguridad de aislamiento | Igual (la da la BD) | Igual |
| RLS en el esquema | Políticas declarativas en TypeScript → se revisan en PR y generan SQL | No expresable: todo SQL manual fuera del esquema |
| Migraciones | **Verificadas**: generar + SQL personalizado (función, FORCE, grants) + migrar + "sin cambios" | **No verificado** aquí: su motor se descarga de `binaries.prisma.sh` (bloqueado). Un CI endurecido o sin Internet tendría el mismo problema |
| Binarios externos | Ninguno (JS puro) | Motor de migraciones descargable |
| Control de transacción y SQL | Total y explícito (`set_config`, locks) | Total vía `$transaction` y SQL crudo; la extensión `$extends` automatiza el contexto pero **una transacción por operación** (no atómica entre operaciones) → tentación peligrosa |
| Latencia de contexto (orientativa) | ≈1,1–1,5 ms | ≈2,0–2,4 ms |
| Ergonomía de CRUD y relaciones | Buena; más SQL a la vista | **Mejor** (relaciones, `Decimal`, generador) |
| Madurez | **Pre-1.0** (cambios posibles) | 7.x estable, pero con cambios grandes entre mayores (resolvió a 8.0 RC en la instalación) |

**Costo asumido:** Drizzle es 0.x. Mitigaciones: versión exacta fijada, actualización solo por PR con la suite de aislamiento en verde, y el ORM detrás del módulo `db`. Como la seguridad vive en PostgreSQL, **cambiar de ORM no debilita el aislamiento**.
**Qué cambiaría mi recomendación:** que verifiques en tu CI que `prisma migrate` funciona sin fricción y prefieras su ergonomía; entonces Prisma es una opción válida con las mismas reglas de este ADR.

### Cómo se implementará el contexto de `organization_id`
- Un `TenantContext` (AsyncLocalStorage) se crea **solo** en el guard de autenticación **después** de validar el token y la membresía (agencia/Súper Admin: ADR-11, 22). El `organization_id` **nunca** viene del cuerpo, la URL ni cabeceras del cliente.
- `DbService.withTenant(fn)` **lee la organización del contexto** (los llamadores no la pasan) y: abre una transacción → `SELECT set_config('app.org_id', $1, true)` con parámetro (equivale a `SET LOCAL`, que no admite parámetros) y valida que sea UUID → opcionalmente `app.user_id`, `app.acting_as` y `app.request_id` para auditoría → ejecuta `fn(tx)` con `tx: TenantTx` (tipo marcado).
- Los repositorios **solo** aceptan `TenantTx`. No existe ninguna exportación del pool o del cliente crudo fuera del módulo `db`.
- **Workers/BullMQ:** cada job lleva `organization_id`; `runAsTenant(orgId, fn)` usa el mismo `withTenant`. Jobs de plataforma (vencimiento de pruebas, purgas) recorren organizaciones una a una.
- **Plataforma:** `withPlatform(fn)` usa un **pool y rol distintos** (`app_platform`), accesible solo con guard `super_admin`, para tablas sin `organization_id` (ADR-19, 21, 22).
- Si algo olvida el contexto: `app_org()` es NULL → **0 filas y escrituras rechazadas** (S1).

### Cómo se garantiza RLS dentro de las transacciones
1. Tres roles: `app_owner` (solo migraciones, nunca usado por la app), `app_rw` (app; `NOSUPERUSER NOBYPASSRLS`, sin ser dueño de tablas), `app_platform`.
2. Toda tabla de negocio: `organization_id NOT NULL`, `ENABLE` **y `FORCE`** RLS, política `USING` y `WITH CHECK` con `organization_id = app_org()` (sin `TO` abierto ni `USING (true)`).
3. Contexto **solo transaccional** (`set_config(..., true)`): se descarta al COMMIT/ROLLBACK, compatible con pgBouncer en modo transacción (**no probado aquí**).
4. Locks: solo `pg_advisory_xact_lock(hashtextextended(org || ':' || recurso, 0))`.
5. Migraciones: la función `app_org()` y los grants/FORCE van en migraciones SQL propias (drizzle-kit solo genera ENABLE + políticas); un test de CI compara el resultado con lo esperado.

### Patrones PROHIBIDOS
1. `SET`/`set_config(..., false)` a nivel de sesión (fuga demostrada, S14).
2. Importar el pool, `drizzle()` o `pg` fuera de `apps/api/src/db/` (regla de lint de importaciones + dependency-cruiser).
3. Conectar la app con `app_owner`, un superusuario o un rol con `BYPASSRLS`.
4. Pasar `organization_id` como argumento a repositorios como mecanismo de seguridad (se permite en `WHERE` solo como optimización de índice; el guardián es la RLS).
5. Tomar la organización de la petición (body/query/headers) en vez del contexto autenticado.
6. SQL con interpolación (`sql.raw`, `$queryRawUnsafe` o equivalentes con datos externos).
7. `pg_advisory_lock` de sesión; transacciones que cruzan peticiones; conexiones "pegadas" a un tenant.
8. Tablas de negocio sin política RLS, sin `FORCE` o con `USING (true)`; funciones `SECURITY DEFINER` sin revisión explícita (ADR propio).
9. Casts `as any` / `as TenantTx` fuera de `db/` para saltar el tipo marcado.
10. Usar `withPlatform` desde código que no sea del módulo `platform`.
11. *(Enmienda aprobada 2026-10-04, hallazgo del Bloque 2 de M0.)* **Claves foráneas simples entre tablas de negocio.** Las FK eluden RLS (las comprobaciones de integridad referencial no aplican políticas), así que una FK `x.contact_id → contacts.id` permite referenciar —y sondear la existencia de— filas de otra organización. Toda FK entre tablas `tenant` debe ser **compuesta** `(organization_id, x_id) → (organization_id, id)`; `tenantTable()` crea el `UNIQUE (organization_id, id)` necesario. Verificación: auditor `FK_CROSS_TENANT` (`pnpm db:audit` y test de cobertura) + test S14 del contrato RLS.

12. *(Enmienda aprobada 2026-10-04 con ADR-25.)* **`withIdentity` fuera de los módulos `auth` y `organizations`.** Las tablas de identidad están fuera de RLS por organización; su acceso se limita por rol (`app_identity`) y por lint (P12). Verificación: regla ESLint `ADR24-P12` con casos que deben fallar (crm, http, platform) y controles que deben pasar (auth, organizations); auditor de privilegios.

### Pruebas OBLIGATORIAS (puerta de CI)
1. **Suite de contrato RLS** (reescritura limpia de S1–S15 contra la BD **creada solo con migraciones**): sin contexto, A↔B por lectura/UPDATE/DELETE/INSERT/JOIN/SQL crudo, contexto no sobrevive al commit, concurrencia sin fugas, advisory xact, tablas de plataforma, `SET ROLE`/`DISABLE RLS` imposibles.
2. **Cobertura de políticas**: toda tabla con columna `organization_id` tiene `relrowsecurity` y `relforcerowsecurity` y una política con `USING` y `WITH CHECK`; falla si se añade una tabla sin ellas.
3. **Privilegios de roles**: `app_rw` no es superusuario, no tiene BYPASSRLS y no es dueño; no puede leer tablas de plataforma.
4. **Aislamiento A↔B por endpoint** (generado desde el OpenAPI) — ya previsto en el Build Spec §4.3.
5. **Prueba de tipo**: un archivo con `@ts-expect-error` que confirma que un repositorio rechaza el cliente crudo y una transacción sin contexto.
6. **Lint/arquitectura**: las reglas de los patrones 2, 6 y 9 con casos que deben fallar.
7. **Canario de conexión**: tras cada petición de prueba, `current_setting('app.org_id', true)` está vacío en la conexión devuelta al pool.
8. **Migración desde cero**: BD vacía + migraciones = esquema, políticas, FORCE y grants esperados; `drizzle-kit generate` posterior no produce cambios.
9. **Carga de concurrencia**: ≥ 200 transacciones intercaladas de ≥ 3 organizaciones con pool pequeño, 0 fugas.

### Alternativas consideradas
Prisma 7 (válido; ver tabla); Kysely/SQL a mano (más control, menos ergonomía y sin generador de migraciones); un esquema por tenant (descartado en Entrega 1 §5).

### Ventajas / desventajas
**Ventajas:** políticas visibles en el código, migraciones verificadas, sin binarios externos, SQL transparente, menor latencia, cambio de ORM de bajo riesgo. **Desventajas:** pre-1.0; menos ergonomía que Prisma; FORCE/grants/funciones/roles van en SQL manual (igual que en Prisma).

### Límites de la evidencia
Un solo equipo, PostgreSQL 16 local sin pgvector, sin PgBouncer ni NestJS; migraciones de Prisma **no verificadas**; latencias orientativas. Estos puntos se cubren en el hito M0 con la suite obligatoria, en el entorno real.

### No decide
Hosting/región, proveedor de correo, pasarela de pago, PoC de voz, retención de grabaciones, ni los valores provisionales (créditos, precios, retención de prueba, billing): siguen **abiertos** según el Build Spec §15.

---

## ADR-25 — Acceso a las tablas de identidad

**Estado: APROBADO por Josué (2026-10-04, opción A) e IMPLEMENTADO en el Bloque 3b de M0.** Surgió del Bloque 3.

### Problema
`users`, `auth_identities`, `sessions`, `refresh_tokens`, `organization_members`, `organizations`, `agency_grants`… se leen **antes** de que exista un `TenantContext` (login por correo, resolver las membresías del usuario, cambiar de contexto, listar «Mis clientes» de una agencia) y/o cruzan organizaciones por naturaleza. Por tanto:
- No pueden ir bajo la política `organization_id = app_org()` de ADR-24 (no hay organización activa cuando se consultan).
- No son «tablas de plataforma» según Build Spec §4.2, y ADR-24 P10 prohíbe `withPlatform` fuera del módulo `platform`.
- El Build Spec §4.1.5 exige validar `organization_members` en **cada** petición, es decir, leer identidad antes de fijar contexto.
Hoy el Build Spec/ADR-24 no dicen cómo se accede a ellas. No es una contradicción que invalide ADR-24, pero sí un vacío que afecta la seguridad.

### Opciones
| | Descripción | Ventajas | Desventajas |
|---|---|---|---|
| **A (recomendada)** | Cuarto rol `app_identity` + pool propio + `withIdentity(fn)`; GRANT **solo** sobre tablas de identidad (nunca de negocio ni de plataforma). Lint P12: `withIdentity` solo desde los módulos `auth` y `organizations`. El auditor añade la categoría `identity` al catálogo. | Mínimo privilegio; mismo patrón ya probado (rol + pool + tipo `IdentityTx` + contexto); un fallo en login no expone datos de negocio ni de plataforma | Un rol/pool más; enmienda de ADR-24 (P12) y del Build Spec §4.1/§4.2; el aislamiento entre organizaciones dentro de identidad descansa en lógica de aplicación + tests A↔B (no en RLS) |
| B | Reutilizar `app_platform` y permitir `withPlatform` al módulo `auth` | Cero infraestructura nueva | Amplía el rol de plataforma (credenciales de proveedores, precios) a código expuesto a internet; viola mínimo privilegio. **No recomendada** |
| C | Funciones `SECURITY DEFINER` estrechas (p. ej. `login_lookup(email)`) | Privilegio mínimo por consulta | Prohibidas sin ADR (P8); difíciles de revisar y probar; no cubren listados de agencia |
| D | RLS por usuario (`app.user_id`) para identidad | RLS también en identidad | No resuelve la búsqueda por correo antes del login ni las vistas de agencia; complejidad alta |

### Recomendación
**A.** Motivo: conserva el principio de ADR-24 (el rol limita el daño de un bug) sin ensanchar `app_platform`. Impacto: ADR-24 gana P12; `organizations` deja de ser «tenant root» con RLS y pasa a la categoría `identity` (la lectura de una organización por sus miembros y la cartera de agencias se hace con reglas de aplicación + tests); el Build Spec §4.1/§4.2 se actualiza para listar las tablas de identidad.

### Implementación (Bloque 3b)
- Rol `app_identity` (NOSUPERUSER, NOBYPASSRLS, sin membresías, timeouts provisionales) + pool propio (`DATABASE_URL_IDENTITY`, `DB_POOL_MAX_IDENTITY`); la configuración exige tres usuarios distintos y prohíbe `postgres`/`app_owner`.
- `Database.withIdentity(fn)` → `IdentityTx` (sin contexto; anidamiento con otro tipo de transacción lanza error).
- GRANT (migración `0002`): `SELECT, INSERT, UPDATE` sobre `users`, `organizations`, `organization_members` **solo** a `app_identity` (sin DELETE ni TRUNCATE: la identidad se desactiva, no se borra). `app_rw` y `app_platform` sin ningún privilegio sobre ellas; `app_identity` sin acceso a ninguna otra tabla.
- Auditor: categoría `identity` con códigos `GRANT_ON_IDENTITY`, `GRANT_IDENTITY_ON_NON_IDENTITY`, `GRANT_EXCESS`, `GRANT_MISSING`.
- Lint P12 (ver ADR-24): `withIdentity` solo desde `src/modules/auth/**` y `src/modules/organizations/**` (+ `db/`).
- Integridad en BD (CHECK/UNIQUE): email normalizado y único; `password_hash LIKE '$argon2id$%'`; `organizations.kind` ∈ {platform, agency, client}; una sola organización `platform`; `parent_agency_id` solo en `client`; `organization_members.role` válido; una membresía **activa** por (usuario, organización).
- Bootstrap del primer super_admin (`pnpm bootstrap:super-admin`, `BOOTSTRAP_SUPER_ADMIN_EMAIL`): contraseña aleatoria única (24 bytes) mostrada **una vez** por stdout, nunca por el logger; Argon2id (`@node-rs/argon2` 2.0.2, binarios precompilados, verificado en este entorno; m=19456, t=2, p=1 **provisionales**); lock transaccional; idempotente; concurrencia → exactamente una creación; no adopta cuentas existentes.
- **Riesgos aceptados:** (1) el aislamiento entre organizaciones dentro de identidad depende de lógica de aplicación + tests A↔B, no de RLS; (2) `parent_agency_id` debe apuntar a una agencia, pero la BD no lo impide (validación de aplicación en M2); (3) las tablas de negocio con FK a `users(id)` pueden actuar como oráculo de existencia (se mapea a 409 genérico); (4) los valores de `status`/`plan_id` esperan ADR-23 (M1).

### Qué NO decide
Algoritmo/parámetros de hash más allá de Argon2id (ya decidido en ADR-01), proveedor de correo, hosting, ni valores provisionales de pruebas/créditos.


---

## ADR-26 — Sesiones y tokens de acceso

**Estado: APROBADO por Josué (2026-10-04) con ajustes; implementado en M1.1 y corregido según esos ajustes.**

### Decisión
1. **Tokens opacos** `<sessionId>.<secreto de 32 bytes>`; en BD solo el SHA-256 (`access_hash`, `refresh_hash`). Sesiones persistidas en BD.
2. **Una tabla `sessions`** (un inicio de sesión = una fila) en lugar de `sessions` + `refresh_tokens` (Build Spec §6.1).
3. **Revalidación en cada petición** contra BD (rol `app_identity`): sesión vigente y no revocada, usuario `active` y no eliminado, `users.session_version` igual al de la sesión, organización activa y **membresía vigente** (INNER JOIN a `organization_members` sin `revoked_at`).
4. **Refresh de UN SOLO USO, sin ventana de gracia** (ajuste de Josué). Un refresh ya usado, o que no coincide con el vigente, **revoca la sesión entera** (`revoke_reason = refresh_reuse`). No se relaja la seguridad del backend para tolerar clientes concurrentes.
5. **Bloqueo de intentos en PostgreSQL** (`auth_throttle`, claves HMAC con `AUTH_THROTTLE_KEY`): al llegar al umbral de la cuenta, espera que se duplica por fallo extra hasta un tope; umbral propio por IP. Aplica igual a correos inexistentes. Errores uniformes.
6. **Transporte**: access en `Authorization: Bearer`; refresh en cookie `HttpOnly; SameSite=Strict; Path=/v1/auth` (`Secure` en producción) + cabecera obligatoria `X-Requested-By` (CSRF), o en el cuerpo para clientes nativos (`token_transport: "body"`).
7. **Principal**: organización y rol salen de la sesión/membresía; Súper Admin en la organización de plataforma → `platform`; el resto → `tenant`.
8. **Versionado**: todas las rutas bajo **`/v1`** (prefijo global en `configureApp`), salvo los sondeos `/health` y `/health/ready`. Los endpoints de acceso son `/v1/auth/login|refresh|logout`; sin prefijo no existen. Las rutas inexistentes (con o sin prefijo) responden el 404 JSON estándar con `request_id`, y `x-request-id` se asigna a toda respuesta.
9. **Parámetros PROVISIONALES y configurables** (validados al arrancar, con rangos; valores por defecto en `config/env.schema.ts`, marcados `PROVISIONAL`): `AUTH_ACCESS_TTL_SECONDS` (900), `AUTH_REFRESH_TTL_DAYS` (30), `AUTH_SESSION_ABSOLUTE_TTL_DAYS` (90), `AUTH_ACCOUNT_LOCK_THRESHOLD` (5), `AUTH_IP_LOCK_THRESHOLD` (25), `AUTH_LOCK_BASE_SECONDS` (60), `AUTH_LOCK_MAX_SECONDS` (3600), `AUTH_FAILURE_WINDOW_HOURS` (24). Se calibran antes de producción. Cada uno rechaza valores fuera de rango y combinaciones incoherentes (máximo de bloqueo < base; sesión absoluta < refresh).

### Concurrencia del refresh (cómo se resuelve)
- La rotación ocurre en **una sola transacción** con `SELECT … FOR UPDATE` sobre la fila de la sesión. Dos refrescos simultáneos con el mismo token se **serializan** en PostgreSQL: el primero valida, rota `access_hash` y `refresh_hash` y confirma; el segundo, al obtener la fila, ve que su hash ya no es el vigente y se trata como **reutilización**: responde 401 y revoca la sesión, **incluidos los tokens recién emitidos al primero**.
- Si algo falla durante la rotación, la transacción hace rollback: ni el access ni el refresh cambian, la sesión no se revoca y el cliente puede reintentar con el mismo refresh (probado con un fallo simulado).
- Consecuencia asumida: un cliente que dispare dos refrescos en paralelo pierde su sesión (debe volver a iniciar sesión). **La corrección es del cliente, no del backend**: el frontend (M1.6) debe serializar el refresh (un único «vuelo» compartido entre pestañas/solicitudes, p. ej. con un bloqueo entre pestañas) y reintentar una petición 401 una sola vez con el token ya renovado.
- Verificación: tests de 2 y 12 refrescos concurrentes (exactamente una rotación), reutilización inmediata, revocación, bloqueo de fila bajo otra transacción y rollback. Mutación: quitar `FOR UPDATE` hace fallar los de concurrencia.

### Limpieza de datos (REQUISITO antes de producción)
`sessions` y `auth_throttle` solo crecen: las sesiones revocadas/vencidas y los contadores antiguos se acumulan. **Antes de producción debe existir una estrategia de limpieza** (por ejemplo, un job de plataforma o una función con propietario y alcance acotados que purgue filas vencidas con retención definida, o particionado por fecha con descarte de particiones). **No se concede DELETE/TRUNCATE a `app_identity` solo para resolver esto** (ADR-25 se mantiene); la estrategia se diseña y aprueba aparte, probablemente junto con el job de vencimiento de pruebas (M1.5). Hasta entonces el crecimiento es aceptable en desarrollo y staging, no en producción.

### Alternativas
| | Ventajas | Desventajas |
|---|---|---|
| **A. Opacos + sesión en BD (aprobada)** | Revocación inmediata; el guard ya debe consultar usuario/versión (§11.6); sin gestión de claves de firma | Una consulta por petición |
| B. JWT de 15 min + refresh en BD | Sin consulta en cada petición | Revocación tardía o consulta igual; gestión de claves |
| C. Cookie de sesión clásica | Simple | No sirve para clientes nativos/API; CSRF en todas las rutas |
| D. Ventana de gracia para refresh concurrente | Tolera dobles envíos | **Rechazada por Josué**: acepta reutilización de un token ya usado |

### Impacto y riesgos
- Desviación menor del §6.1: no existe `refresh_tokens`.
- **R1** coste de la consulta por petición (mitigable con caché corta + invalidación por `session_version`).
- IP: `req.ip` sin `trust proxy` (hosting sin decidir); detrás de un proxy habrá que configurarlo o el bloqueo por IP agruparía a todos.
- Los valores provisionales se calibran antes de producción.

---

## ADR-27 — Registro y verificación de correo (M1.2)
**Estado: APROBADO (2026-10-04). Ajustes de Josué: contraseña mínima 8 (`8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128`; ninguna configuración válida admite menos de 8) y lista pública de dominios desechables cargada con `pnpm db:load-disposable-domains` desde `data/disposable_email_blocklist.conf` (9 203 dominios, CC0; revisión periódica, la lista no es exhaustiva).**

### Decisión
1. `POST /v1/auth/signup|verify|resend`, públicos. El registro crea un usuario `pending`; **la organización `client` y la membresía `client_admin` se crean únicamente al verificar**, en la misma transacción que activa al usuario. Los datos pendientes (nombre de organización, zona horaria) viven en `email_verifications`.
2. Código de **6 dígitos** (`crypto.randomInt`), guardado solo como HMAC-SHA256 ligado al usuario (clave `AUTH_THROTTLE_KEY` con separación de dominio `email-verification|…`). **PROVISIONAL**: caduca a los 15 min, máximo 5 intentos por código (al agotarlos se invalida y hay que reenviar), reenvío con espera de 60 s, 5 solicitudes por correo/hora, 10 registros-reenvíos por IP/hora, 30 intentos de verificación por IP/hora, contraseña ≥ 8 caracteres (requisito aprobado: `8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128`, por defecto 8; el suelo de 8 está en el código de validación de configuración y no se puede bajar por entorno). Todo configurable (`SIGNUP_*`).
3. **Anti-enumeración**: `signup` y `resend` responden 202 con el mismo cuerpo exista o no la cuenta; si ya hay una cuenta activa no se envía correo ni se modifica nada; los límites por correo se aplican en silencio. `verify` devuelve un único 400 `INVALID_CODE` para correo inexistente, código erróneo, vencido, agotado o ya usado. Se calcula un hash Argon2id en cada `signup` (tiempos parecidos).
4. **Puertos** `MailProvider` y `CaptchaVerifier` con `available`. Sin proveedor (`MAIL_PROVIDER=none` / `CAPTCHA_PROVIDER=none`, valor por defecto) el registro responde **503 `SIGNUP_UNAVAILABLE`**, nunca simula éxito; el CAPTCHA falla cerrado. Fakes: `memory` (pruebas), `console` (desarrollo, imprime el código), `fake` (acepta `fake-pass`). **La configuración rechaza console/memory/fake con `NODE_ENV=production`.** No se eligió proveedor.
5. Tablas de identidad nuevas (ADR-25), sin DELETE para `app_identity`: `email_verifications` (una fila por usuario, se reutiliza al reenviar → no crece con los reenvíos), `signup_attempts` (contadores de ventana fija con clave HMAC), `disposable_domains` (**solo SELECT** para la app; la gestiona operación con el rol propietario).
6. `verify` no abre sesión: el usuario inicia sesión después (más simple y sin emitir tokens desde un endpoint de código de 6 dígitos). Revisable en M1.6.
7. Consumo del código con `FOR UPDATE` **y** `UPDATE … WHERE consumed_at IS NULL RETURNING` (defensa en profundidad: solo una transacción puede consumirlo).

### Alternativas
Crear la organización al registrarse (descartada: organizaciones huérfanas sin verificar y limpieza sin DELETE); enlace mágico en lugar de código (pendiente de decisión de producto; el esquema lo admite); devolver 409 si el correo existe (descartada: enumeración de cuentas); sesión automática tras verificar (diferida).

### Ventajas / desventajas
+ Sin organizaciones ni datos de negocio hasta verificar; respuestas indistinguibles; fallo cerrado sin proveedores; cero DELETE.
− Un registro posterior sobre un correo **pendiente** reemplaza la contraseña y el código (quien aún no verificó pierde su registro): riesgo aceptado, acotado por el límite por correo/IP y el correo explícito de «si no fuiste tú, ignóralo» (texto a definir con el proveedor). − Con 6 dígitos y 5 intentos la probabilidad de adivinar un código es 5×10⁻⁶ por emisión; el límite por IP y por correo la mantiene baja. − Un usuario pendiente y su fila `email_verifications` nunca se borran sin DELETE: limpieza con el job de M1.5 (misma estrategia pendiente que `sessions`/`auth_throttle`).

### Impacto
Endpoints nuevos en el registro (`public`); migraciones 0005–0006; el catálogo de identidad y las pruebas de superficie se actualizaron. Abierto (no decidido): proveedor de correo, de CAPTCHA, origen de la lista de dominios desechables (la tabla está vacía), formato definitivo del código (6 dígitos vs enlace), idioma y plantilla del correo.


---

## ADR-28 — Olvido, restablecimiento y cambio de contraseña (M1.3)
**Estado: APROBADO (corrección de longitud mínima aplicada; se avanzó a M1.4 por indicación del propietario).**

### Decisión
1. `POST /v1/auth/forgot` (202 uniforme), `POST /v1/auth/reset` (200) y `POST /v1/auth/password` (204, autenticado).
2. **Token** opaco `<id>.<secreto 32 B>`, enviado por correo dentro de un enlace **construido en el servidor** como `FRONTEND_BASE_URL + RESET_LINK_PATH + '#token=<token>'`. `FRONTEND_BASE_URL` es configuración **explícita y obligatoria** si hay proveedor de correo (https en producción; sin credenciales, query ni fragmento) y **nunca se deriva del Host/Origin/X-Forwarded-* de la petición** (test con cabeceras hostiles). El token va en el fragmento (no llega a servidores, logs ni Referer). `MailProvider.sendPasswordReset` recibe el `resetUrl` ya armado; la plantilla del correo sigue sin definir. En BD solo su SHA-256 (`password_resets`, una fila por usuario; un nuevo forgot reemplaza la fila y por tanto invalida el token anterior). **PROVISIONAL**: caduca a los 30 min, cooldown 60 s, 3 solicitudes/hora por correo, 10/hora por IP, 30 intentos de `/reset`/hora por IP (`RESET_*`).
3. **Anti-enumeración**: `forgot` responde igual exista o no la cuenta (pendiente/desactivada/inexistente → sin correo); los límites por correo se aplican en silencio. `reset` devuelve un único 400 `INVALID_TOKEN` (inexistente, secreto erróneo, vencido, usado, usuario no apto).
4. **Efecto de restablecer**: cambia el hash, sube `users.session_version`, revoca TODAS las sesiones del usuario (`password_reset`) y levanta el bloqueo por intentos de acceso de esa cuenta (quien restablece demuestra control del correo; evita que alguien bloquee a la víctima de forma indefinida). No abre sesión.
5. **Cambio voluntario**: exige contraseña actual (errores cuentan para el mismo bloqueo por intentos que el login, 429 con Retry-After), nueva ≠ actual; sube `session_version`, **revoca las demás sesiones y conserva la actual** (se le actualiza `user_session_version`).
6. **Nuevo tipo de acceso `@SelfService()`** («self»): cualquier principal autenticado (tenant o plataforma) operando solo sobre su propio usuario. El servicio usa únicamente `principal.userId/sessionId`; el DTO es `strict` y rechaza ids ajenos. Se registra en el registro de endpoints con su suite (`password.test.ts`) y el test del registro verifica que la suite mencione la ruta. Necesario porque un Súper Admin es principal de plataforma y los endpoints «tenant» lo rechazan.
7. Tabla `password_resets` de identidad (ADR-25), SELECT/INSERT/UPDATE para `app_identity`, sin DELETE. `signup_attempts` ampliada con las claves `f`, `r`, `x` (migración 0007).

### Alternativas
Token de 6 dígitos como en el registro (descartada: el token viaja en un enlace y 32 bytes son inadivinables sin necesidad de límite de intentos por token); revocar solo por `session_version` (se hace además la revocación explícita, para tener `revoke_reason` y auditoría); cerrar también la sesión actual al cambiar la contraseña (más seguro pero peor UX; las demás sí se cierran); permitir que el endpoint de cambio sea «tenant» y aparte uno de plataforma (duplicación).

### Ventajas / desventajas
+ Un token por usuario (sin crecimiento por reenvíos), un solo uso con consumo condicional + bloqueo de fila, errores uniformes. − Un atacante que conozca el correo puede hacer que la víctima reciba hasta 3 correos/hora (límite por correo y CAPTCHA lo acotan). − No hay aviso por correo «tu contraseña cambió» (requiere plantilla/proveedor: pendiente). − La URL concreta del frontend (valor de `FRONTEND_BASE_URL`) aún no existe: depende del hosting.

### Impacto
Migraciones 0007–0008; nuevo `AccessKind` 'self' (guard, decorador, registro de endpoints); `MailProvider` gana `sendPasswordReset` (fakes actualizados). Abierto (no decidido): proveedor de correo, plantilla, valor real de la URL del frontend, aviso de cambio de contraseña, política de contraseñas más allá de la longitud.


---

## ADR-29 — RBAC y auditoría (M1.4)
**Estado: APROBADO (2026-10-05, M1.4 aprobado por el responsable de producto). La matriz rol→permiso sigue siendo PROVISIONAL y se confirmará/ajustará con el producto (cambiarla es una migración).**

### Decisión
1. **Catálogo de permisos en código** (`src/rbac/catalog.ts`, 33 claves, cada una con ámbito `tenant` o `platform`) y **sembrado por migración** en `roles`, `permissions`, `role_permissions` (0010, generado desde el catálogo). Son datos de referencia globales: tablas de **identidad** (ADR-25), `app_identity` solo SELECT; se cambian únicamente por migración (nadie las edita en runtime).
2. **Guard central**: `@RequirePermission(...claves)` exige TODAS; el resolvedor carga los permisos del rol (`PermissionService`, caché 60 s) en `Principal.permissions`. Un permiso solo se concede si el ámbito del rol coincide con el del permiso (defensa en profundidad ante un siembra errónea). Denegación = 403 genérico. El registro de endpoints falla si una ruta tenant/platform no declara permisos válidos del catálogo o si una pública los declara.
3. **Auditoría de cliente** `audit_logs`: tabla tenant (RLS + FORCE), **append-only** (`app_rw` solo SELECT/INSERT). Se escribe con `writeAudit(tx, …)` **dentro de la misma transacción** del cambio (si revierte, la auditoría también); actor, `acting_as`, organización y `request_id` salen del contexto, nunca del llamador. Campos sensibles (contraseña, token, secreto…) guardan `{redacted:true}` en lugar del valor.
4. **Auditoría de plataforma** `platform_audit`: solo `app_platform`, append-only, requiere `PlatformContext`; descarta detalles con clave secreta.
5. Primer uso: el cambio de contraseña audita (tenant → `audit_logs`; Súper Admin → `platform_audit`), sin valores.

### Matriz inicial (PROVISIONAL)
`super_admin`: todos los `platform.*`. `client_admin`: todos los permisos de organización. `advisor`: `inbox.reply`, `contacts.read`, `opportunities.read` (mínimo privilegio). `agency`: ninguno hasta M2. El Build Spec §5 no trae la matriz completa: **requiere tu confirmación**; cambiarla es una migración, no un cambio de código.

### Alternativas
Roles con permisos solo en código (sin tablas: más simple, pero no auditable en BD y difícil de listar/consultar); permisos editables por el cliente (roles personalizados — fuera de alcance, ampliable después); tabla de auditoría única con `organization_id` nulo para plataforma (mezcla ámbitos y rompe RLS); trigger de auditoría en BD (no conoce actor ni motivo).

### Ventajas / desventajas
+ Un solo punto de decisión, probado por mutación; auditoría atómica e inmutable para la app. − Caché de 60 s: un cambio de matriz tarda hasta 1 min (se cambia por migración y reinicio); la auditoría añade una escritura por operación auditada; `app_rw` también escribe auditoría, así que un bug de la app podría insertar entradas falsas (no alterarlas ni borrarlas).

### Impacto
Migraciones 0009–0010; módulos `rbac`, `audit`, `platform` (P10 mantiene `withPlatform` solo ahí); `Principal.permissions`. Abierto: matriz definitiva, permisos de `agency` (M2), roles personalizados, retención y particionado de `audit_logs`, vista/consulta de auditoría en la UI.

---

## ADR-30 — Hosting inicial: Railway (desarrollo y staging)
**Estado: APROBADO el 2026-10-05 (visto bueno del responsable de producto). Alcance: entorno de staging y piloto. La región y la configuración de PRODUCCIÓN se revalidan en la puerta de la Etapa 3 (endurecimiento) antes del piloto con clientes.**

### Decisión
Usar **Railway** como plataforma de despliegue inicial, con el repositorio `josuequirozagencia/SALESMART2.0` en GitHub como origen. Servicios: `api` y `worker` (mismo código, dos contenedores), PostgreSQL con pgvector, Redis, almacenamiento S3-compatible (R2 o bucket de Railway: a elegir) y, para el spike de WhatsApp QR, Evolution API con volumen persistente. Entornos separados `staging` y `production` (secretos y roles de BD distintos). Región provisional: la más cercana a Ecuador disponible (EE. UU. Este). Todo se empaqueta en Docker para mantener la salida abierta.

### Alternativas
VPS propio con Docker Compose (más barato y control total, pero operación, parches y backups a cargo del equipo); AWS/GCP (máxima flexibilidad y regiones en Sudamérica, mayor complejidad y coste operativo); Render/Fly.io (similares, sin ventaja clara hoy).

### Ventajas / desventajas
+ Despliegue desde GitHub en minutos, servicios gestionados, bajo lock-in (Docker), buen ritmo para MVP. − Sin región en Sudamérica (latencia ~100–150 ms desde Ecuador); backups/PITR y retención dependen del plan; menos control de red que un VPS/nube propia; hay que verificar que el Postgres admita nuestros 4 roles con RLS y pgvector.

### Motivo
Velocidad de entrega y bajo costo operativo en la fase MVP/piloto, manteniendo portabilidad.

### Impacto
Cierra el punto abierto "Hosting" del Build Spec §15 solo para staging/piloto. Pendiente antes de producción: verificación de roles/RLS/pgvector en Railway (prueba de una hora), política de backups con restauración probada, residencia de grabaciones (telefonía), proveedor de correo, CAPTCHA y pasarela de pago (siguen ABIERTOS).

---

## ADR-31 — Spike de WhatsApp QR (Evolution API) sobre Railway
**Estado: APROBADO el 2026-10-05 (alcance: spike desechable; NO reordena los hitos).**

### Decisión
Ejecutar un spike técnico aislado en `spikes/whatsapp-qr/` (fuera de `apps/`, sin tocar el núcleo) para validar Evolution API con un **chip de prueba dedicado**: vincular por QR, enviar/recibir texto y medios, webhooks, reconexión tras reinicio/redeploy (volumen persistente) y comportamiento ante caídas. Resultado: informe con hallazgos y recomendación para `EvolutionProvider`. El código del spike es descartable; lo aprendido alimenta el adaptador real.

### Alternativas
Esperar a M9 (descubre riesgos tarde); implementar `EvolutionProvider` directamente (acopla antes de conocer el comportamiento); usar otra librería no oficial (Baileys directo: más control, más mantenimiento).

### Ventajas / desventajas
+ Reduce el mayor riesgo técnico del canal QR pronto, sin comprometer arquitectura. − Los números QR pueden bloquearse (solo chip desechable); Evolution y WhatsApp Web cambian sin aviso; el spike no prueba escala.

### Motivo
Priorizar el aprendizaje del riesgo más incierto con costo mínimo.

### Impacto
Nueva carpeta `spikes/whatsapp-qr/`. El orden de hitos M5/M9 **no cambia** hasta que el responsable de producto lo apruebe tras ver el informe.

---

## ADR-32 — Grupos, campañas y ventas del asesor (derivado del prototipo v9)
**Estado: APROBADO el 2026-10-09 por el responsable de producto, con la ENMIENDA 1 (abajo).** Recoge lo que el prototipo v9 exige y que el Build Spec no cubría; aplicado en el Build Spec como **[PROPUESTA v9]**.

### Decisión propuesta
1. **Ventas:** el asesor crea pero no modifica; correcciones por `sale_change_requests`. (MVP)
2. **Contactos del asesor:** acceso a propios + compartidos (extiende ADR-14 a contactos). (MVP/M3)
3. **Grupos de WhatsApp:** módulo `wa-groups` solo con canal QR, capacidad opcional `groups` en `WhatsAppProvider`; permisos `groups.view|send|manage`. (V1)
4. **Campañas masivas:** permanecen en V2; modo por tipo de conexión (oficial ⇒ plantilla; QR ⇒ texto libre); permiso `campaigns.send` con alcance propio y tope diario. (V2)
5. **Comisión propia** del asesor en solo lectura (`commissions.view` con alcance propio). (V1)

### Alternativas
Adelantar campañas a V1 (mayor valor comercial, mayor riesgo legal/bloqueo); grupos asignados por asesor en vez de por organización; permitir al asesor editar ventas con auditoría (menos fricción, menos control).

### Ventajas / desventajas
+ Coherente con el prototipo y con el principio de mínimo privilegio; separa lo oficial de lo no oficial. − Más tablas y permisos; los grupos quedan atados a un proveedor no oficial; asignación de grupos y límites de campañas aún abiertos (§15 #15–#18).

### Motivo
Reflejar en el Build Spec lo validado en el prototipo sin adelantar fases ni asumir decisiones comerciales.

### Impacto
Build Spec §1, §5, §6, §9, §10.1, §15, §16. Ninguna migración ni código hasta aprobar este ADR. Cambia la matriz de permisos provisional de ADR-29 (por migración, cuando se apruebe).

### Enmienda 1 al ADR-32 (2026-10-09, instrucción explícita del responsable de producto; prototipo v10)
1. **Abonos del asesor:** el asesor **sí puede registrar abonos** sobre sus propias ventas (permiso propuesto `sales.register_payment`, alcance propio). Cada abono es una fila `sale_payments` **append-only** (monto, método, nota, fecha, `created_by`); el asesor no edita ni borra abonos. El valor, el producto, la comisión y el plan siguen siendo solo lectura; las correcciones van por `sale_change_requests`. El saldo (`valor − Σ abonos`) y el estado «cobrada» se calculan en el servidor; un abono mayor al saldo se rechaza. Cada abono queda en `audit_logs`. Esto matiza el punto 1 original («crea pero no modifica»).
2. **Pago de comisión: diferido.** Las empresas pagan comisiones con frecuencias distintas (diaria, mensual…), así que **no se muestra ni se registra** «pago de comisión» (ni columna, ni estado Pendiente/Pagada, ni «comisión por cobrar»). `commission_payouts` queda fuera del alcance visible hasta que se pida. El asesor ve Valor, Abono, Saldo y Comisión generada.
3. **Alta manual de contactos:** el botón «+ Contacto» crea un contacto con todos los campos estándar y los personalizados; el teléfono es único por empresa (E.164); el origen queda «manual» en la auditoría. El asesor crea contactos solo asignados a sí mismo.
4. **Campos personalizados del formulario de contacto:** el administrador del cliente define campos extra (tipo, opciones, obligatorio, mostrar en el formulario) en Configuración › Campos personalizados (`custom_field_definitions`, ya previstos en §6.3: se añaden `show_in_form`, `required`, `position`). El asesor los ve y los llena, no los administra (permiso propuesto `custom_fields.manage` para el administrador).

**Impacto:** Build Spec §5.2, §6.3, §6.5, §10.1; prototipo v10. Sin migraciones ni código hasta M3/ventas.

