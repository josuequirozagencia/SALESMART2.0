# SALES SMART 2.0 — FLUJOS DE USUARIO (Fase 26) — 2026-10-03

Estado: **borrador para validar** contra el prototipo v8. Cada flujo indica actor, disparador, pasos (pantalla → estado), reglas y errores, eventos/datos, y qué está ya en el prototipo. Los flujos incorporan ADR-01 a 17.

**Convenciones.** Todo paso escribe con `organization_id` y RLS. «Evento» = fila en el outbox (procesada por worker). «Auditoría» = `audit_log(valor anterior, valor nuevo, usuario, fecha, origen ∈ manual|IA|automatización|GHL|Meta|API)`. Roles: **SA** Súper Admin, **AG** Agencia, **AD** Admin del cliente, **SU** Supervisor, **AS** Asesor.

---

## Bloque A — Plataforma y acceso

### F01. Alta de organización y primer acceso
- **Actor/disparador:** SA crea una organización (o AG registra un cliente, ver F02); el dueño recibe invitación.
- **Pasos:** Plataforma › Empresas y planes › «Nueva empresa» (nombre, plan, zona horaria, país) → email de invitación (token de un solo uso, caduca) → el dueño define contraseña (Argon2id) y verifica email → asistente: horario laboral y SLA (15 min por defecto), primera cola, primer canal → Dashboard vacío con checklist.
- **Reglas:** el plan lo paga el cliente (ADR-11); organización vencida → solo lectura. Zona horaria obligatoria (el SLA depende de ella).
- **Errores:** invitación caducada → reenvío; email ya existente en otra organización → se añade membresía, no se duplica el usuario.
- **Datos/eventos:** `organizations`, `users`, `organization_members`, `invitations`, `email_verifications`; evento `org.created`.
- **Prototipo:** pantalla Plataforma (parcial); el asistente no está.

### F02. Agencia: registrar clientes y cambiar de contexto
- **Actor:** SA otorga rol de agencia; AG registra clientes.
- **Pasos:** SA › Plataforma › Agencias › «Dar rol de agencia» a una organización → AG ve «Mis clientes» › «Registrar cliente» (opcional: clonar configuración desde una instantánea) → selector de cliente (buscador) → el banner indica «Administrando X» → «Volver a mi agencia».
- **Reglas (ADR-11):** AG solo ve clientes que ella registró; sin cerrar sesión; cada acción queda en la auditoría **del cliente** con `acting_as=agency`; el cliente puede revocar acceso; retirar el rol → los clientes pasan a administración directa (propuesta); agencia suspendida no entra, los clientes siguen funcionando.
- **Errores:** cliente vencido → AG entra en solo lectura (propuesta); intento de entrar a un cliente ajeno → 404 (no 403, para no revelar existencia).
- **Prototipo:** sí (cambia etiqueta/organización, no los datos de ejemplo).

### F03. Usuarios, roles, colas y reparto
- **Actor:** AD.
- **Pasos:** Usuarios y permisos › «Invitar» (rol, colas, horario laboral) → el invitado acepta (F01 sin organización nueva) → Colas y asignación › elegir cola › miembros, modo de reparto (equitativo / con peso / menos conversaciones), lote, tope diario, reasignar si no responde (min) y máximo de rotaciones, «solo no asignados», respetar horario → **simular reparto** → activar.
- **Reglas (ADR-07):** el peso vive en `queue_members`, no en el usuario; peso 0 = pausa; rotación atómica con créditos persistidos; catálogo de productos por cola (ADR-08).
- **Errores:** cola sin miembros activos → los leads quedan «Sin asignar» y se notifica a AD; asesor fuera de horario → se salta.
- **Permisos clave:** `inbox.view_all` (ver todos los chats y filtro por asesor), `sale.create`, `export`.
- **Prototipo:** sí (usuarios con permisos sueltos, colas con reparto y catálogo).

---

## Bloque B — Canales e integraciones

### F04. Conectar canal oficial (WhatsApp Cloud API, Messenger, Instagram)
- **Actor:** AD.
- **Pasos:** Conexiones › «Nueva conexión» › tipo → autorizar con Meta (OAuth/embedded signup) o pegar credenciales → elegir número/página → webhook verificado (firma) → cola destino, agente IA (opcional), saludo/despedida → prueba de envío → estado «Conectado».
- **Reglas:** múltiples números por organización; fuera de 24 h solo plantillas aprobadas; los tokens se guardan cifrados por organización; todo webhook valida firma y es idempotente por `(channel_account_id, external_id)`.
- **Errores:** token vencido → estado «Requiere reconexión» + aviso a AD; webhook con firma inválida → 401 y registro; plantilla rechazada por Meta → estado visible.
- **Prototipo:** pantalla Conexiones (maqueta).

### F05. Conectar WhatsApp QR (canal no oficial) — *flujo de alto riesgo*
- **Actor:** AD.
- **Pasos:** Conexiones › «WhatsApp QR» › aviso de riesgo (no oficial, puede bloquearse el número; aceptar) → se pide sesión al `EvolutionProvider` → QR en pantalla con cuenta regresiva → escanear → estado «Conectado» → importar historial reciente (opcional).
- **Reglas (ADR-02):** el canal se marca como **no oficial** en datos y en la interfaz (chip ámbar); límites de envío y calentamiento si se usa para campañas; el núcleo solo ve `NormalizedMessage`.
- **Errores/casos:** QR expirado → regenerar; **sesión caída** → estado «Desconectado», aviso push/email, botón «Reconectar» y los mensajes salientes quedan en cola con estado «pendiente» (no se pierden ni se reenvían por otro canal sin avisar); número bloqueado → estado «Bloqueado» con guía.
- **Monitoreo:** latido de sesión cada N segundos; alerta si pasa de X min desconectado.
- **Prototipo:** maqueta; la reconexión no está simulada.

### F06. Conectar GoHighLevel (bidireccional) — *flujo de alto riesgo*
- **Actor:** AD (o AG en nombre del cliente).
- **Pasos:** Integraciones › GoHighLevel › pegar **Private Token** y Location ID → validar (llamada de prueba) → mostrar **URL de webhook + secreto** para pegar en un Workflow de GHL (paso manual) → elegir mapeo de etiquetas y campos → «Probar» (evento de ejemplo) → activar.
- **Reglas (ADR-05):** token cifrado; webhook responde 200 de inmediato y procesa asíncrono; comparación de secreto en tiempo constante; sincronización de etiquetas en ambos sentidos con anti-eco (el cambio que viene de GHL no se reenvía a GHL); inscripción de contactos a flujos; plantillas.
- **Límite conocido:** con Private Token no se crean suscripciones de webhook automáticamente; OAuth (app del Marketplace) queda diseñado, no construido.
- **Errores:** token revocado → «Requiere reconexión»; límite de API de GHL → reintentos con espera creciente.
- **Prototipo:** conexión GHL en maqueta.

### F07. Formulario embebido → lead
- **Actor:** AD crea el formulario; el visitante lo llena en una landing.
- **Pasos (AD):** Formularios › «Nuevo» › campos (con «mapea a») → destino (cola, pipeline, etapa, etiqueta extra) → seguimiento (plantilla de WhatsApp, agente IA, llamada, tarea, aviso al asesor) → publicar: enlace, `embed.js` o iframe.
- **Pasos (visitante):** llena y envía (consentimiento explícito) → mensaje de gracias o redirección.
- **Pasos (sistema):** endpoint público valida token opaco, dominio, límite por IP, captcha → crea/actualiza contacto → entra como `NormalizedMessage` de origen `form` al mismo pipeline que un mensaje (F08) → etiqueta **Lead** → evento Lead a Meta con el mismo `event_id` que el Pixel (deduplicación).
- **Errores:** envío repetido → idempotencia `(form_id, idempotency_key)`; dominio no autorizado → rechazo; WhatsApp sin plantilla aprobada → el seguimiento cae a tarea para el asesor.
- **Prototipo:** constructor, destino y código para incrustar.

---

## Bloque C — Conversación y CRM

### F08. Mensaje entrante → cola → reparto → el asesor acepta
- **Actor/disparador:** el cliente escribe por cualquier canal (o llega un formulario).
- **Pasos:** webhook → `NormalizedMessage` → pipeline de handlers en orden declarado (deduplicar → identificar/crear contacto → cola del canal → reglas de automatización → agente IA si aplica → reparto) → conversación **Pendiente** asignada al asesor según la regla de la cola → notificación → el asesor pulsa **Aceptar** (nada se abre solo) → pasa a «Trabajando» → **inicia el cronómetro de SLA** al asignar.
- **Reglas:** SLA 15 min (configurable) con horario laboral, días laborales, feriados y zona horaria; si no acepta/responde en N min → reasignación (con máximo de rotaciones); «respuesta humana» = mensaje de un humano, no automático, no nota.
- **Errores:** contacto bloqueado → no entra al reparto; sin asesor disponible → «Sin asignar» + alerta; mensaje duplicado → ignorado.
- **Prototipo:** pestañas Trabajando/Esperando/Finalizadas, chip de SLA, aceptar.

### F09. Atender una conversación
- **Actor:** AS.
- **Pasos:** abre el chat (lista con etiquetas, fuente, dueño, SLA) → lee contexto CRM a la derecha (etapa, etiquetas, datos capturados por IA) → responde: texto, `/` respuestas rápidas con variables, **emojis, imágenes, video, documentos, audio (grabación), plantilla** → **programar mensaje** (día/hora; se cancela si el cliente responde antes) → **nota interna** (modo separado; nunca sale al cliente) → pausa/activa IA → finalizar.
- **Reglas:** el primer mensaje humano detiene el SLA y registra el tiempo de primera respuesta; un mensaje humano pausa la IA en esa conversación; adjuntos por URL firmada, tipo MIME validado, antivirus y límite por canal; un audio entrante puede transcribirse (consume créditos de IA).
- **Filtros de la lista:** asesor (solo roles altos), fuente, cola, etiqueta, SLA, no leídos. Un AS solo ve sus chats y los compartidos con él (aplicado en servidor).
- **Errores:** fuera de 24 h en WhatsApp oficial → solo plantillas; archivo demasiado grande → mensaje claro; envío fallido → estado «no enviado» con reintentar.
- **Prototipo:** sí (envío de archivos real en el navegador, grabación y envío simulados).

### F10. Transferir o compartir una conversación
- **Actor:** AS o supervisor.
- **Pasos:** botón **Transferir** › pestaña Transferir *o* Compartir → elegir asesor (disponibilidad, carga, ¿está en la cola?) → opciones: transferir «y seguir como colaborador» / compartir «puede responder» o «solo ver y notas» → nota opcional → confirmar → nota interna automática en el historial.
- **Reglas (ADR-14):** transferir cambia el dueño (SLA y comisión pasan al nuevo); compartir **no** cambia el dueño; la visibilidad es `dueño o participante activo`; se puede revocar el acceso.
- **Errores:** destino fuera de horario o ausente → advertencia (no bloqueo); asesor sin acceso a la cola → advertencia.
- **Pendiente:** comisión si el colaborador cierra la venta (propuesta: el dueño, con % compartido opcional).
- **Prototipo:** sí.

### F11. Importar y exportar contactos
- **Pasos (importar):** Contactos › Importar › subir CSV (XLSX después) → mapear columnas (incluye campos personalizados) → destino: pipeline/etapa, cola o asesor fijo, etiqueta → **vista previa con validación** (duplicados por teléfono/email normalizado, teléfonos inválidos) → consentimiento marcado → importar en segundo plano → reporte descargable de rechazados.
- **Pasos (exportar):** filtros/vista guardada → columnas → CSV; requiere permiso `export` y queda en auditoría.
- **Reglas:** idempotencia por archivo (hash); límite de filas por importación; los contactos importados **no** reciben mensajes automáticos sin consentimiento; los números van normalizados a E.164.
- **Prototipo:** asistente de importación/exportación.

### F12. Oportunidades y pipelines
- **Actor:** AD configura; AS opera.
- **Pasos (configurar):** Oportunidades › «Nuevo pipeline» › etapas (crear, renombrar, reordenar, eliminar; marcar la **ganada**; mínimo 2).
- **Pasos (operar):** crear oportunidad (desde contacto, chat o formulario) → arrastrar en el Kanban o cambiar la etapa en el chat → tarjeta con campos heredados + **overrides por oportunidad** → vistas guardadas de la tabla.
- **Reglas (ADR-12):** eliminar etapa con oportunidades las mueve a la anterior; no se elimina la etapa ganada sin marcar otra; no se elimina un pipeline con oportunidades; cada cambio de etapa va a `stage_history` con origen; mover a «ganada» detiene el SLA pero **no** crea la venta por sí solo (la venta es F14).
- **Prototipo:** sí.

### F13. Agendar cita con recordatorios
- **Pasos:** en el chat › **Agendar** › día, hora, tipo, notas → recordatorios (hasta **3**; hasta **5** si la fuente es WhatsApp QR, Messenger o Instagram) → crear evento en Google Calendar (opcional) → guardar.
- **Efectos:** etiqueta fija **Cita agendada**; la oportunidad avanza al menos a la 3.ª etapa (propuesta configurable); evento `Schedule` a Meta; recordatorios como jobs programados por el mismo canal.
- **Reglas (ADR-13):** el tope se valida en el servidor; la cita cancelada/reprogramada cancela sus recordatorios en cascada; el estado de entrega se muestra (un recordatorio fuera de ventana de mensajería puede no entregarse).
- **Prototipo:** sí.

---

## Bloque D — Ventas y dinero

### F14. Registrar una venta con abono y saldo
- **Pasos:** chat › **Registrar venta** › producto/servicio del **catálogo de la cola**, cantidad, total, abono, método de pago → el saldo se calcula → guardar → (después) **registrar pago del saldo** desde la venta.
- **Efectos:** etiqueta fija **Venta**; oportunidad a la etapa ganada; SLA se detiene (con historial); evento `sale.created`.
- **Reglas (ADR-08):** saldo = total − Σ pagos (derivado); una cola sin productos no puede vender; deshacer la etapa ganada **no borra** la venta; anular una venta requiere permiso y motivo.
- **Errores:** abono mayor al total → bloqueado; doble clic → idempotencia.
- **Prototipo:** sí (formulario completo; pago posterior del saldo no está).

### F15. Venta → comisión y Purchase a Meta
- **Pasos:** `sale.created` → (a) outbox → **Purchase a Meta (CAPI) con el valor total** y el `event_id` de deduplicación, con la atribución del clic (`ctwa_clid`/`fbclid` capturados) → (b) cálculo de comisión según el plan del asesor: % , monto fijo, por producto, por pipeline, por meta o híbrido → comisión **pendiente** → AD aprueba → **pagada** (con fecha y comprobante).
- **Reglas (decididas):** Purchase con total aunque haya saldo; comisión sobre el total. **Riesgo abierto:** saldo nunca pagado → regla de reversión configurable (propuesta, desactivada por defecto) y qué se informa a Meta si se cancela.
- **Errores:** CAPI falla → reintentos con espera creciente y panel de eventos fallidos; venta sin atribución → se envía sin ella y se marca.
- **Prototipo:** pantalla de comisiones y asesores (cálculo de ejemplo).

---

## Bloque E — IA y automatización

### F16. Configurar un agente IA y su Knowledge Base
- **Pasos:** Agentes IA › «Nuevo» › tres bloques (Personalidad, Objetivo, Información adicional) con variables `{{contact.ciudad}}` → asociar a una conexión → horario y seguimientos (hasta 5 pasos) → Knowledge Base: subir documentos (PDF, Word, TXT, CSV, Excel, imágenes) → estado Procesando → Listo (almacenamiento → parser → fragmentos → embeddings → base vectorial) → activar/desactivar/eliminar/reprocesar documentos → «Mostrar fuente» ON/OFF → **chat de prueba**.
- **Reglas:** cada agente tiene su propia KB (nunca compartida entre organizaciones); consumo de créditos por organización; si el parseo falla, error visible por documento.
- **Prototipo:** sí.

### F17. La IA captura datos y actualiza el CRM — *flujo de alto riesgo*
- **Disparador:** cliente escribe «Estoy en Guayaquil y quiero información del curso de uñas».
- **Pasos:** el agente responde con apoyo de la KB → extrae `ciudad=Guayaquil`, `interés=Curso de Uñas` → **valida contra los campos permitidos** → escribe en el contacto (chip «IA» en la ficha) → puede mover etapa o crear tarea **solo** con las herramientas que su configuración permite → si el cliente pide hablar con una persona o la confianza es baja → transfiere a un asesor (reparto de la cola).
- **Reglas:** toda escritura de la IA pasa por el `ToolRegistry` con permisos por agente y deja auditoría `origen=IA` (valor anterior/nuevo); la IA no pisa un campo editado por un humano sin regla explícita; un mensaje humano pausa la IA; no actúa en contactos bloqueados.
- **Errores:** alucinación de un dato → el campo queda como «sugerido» si está configurado para exigir confirmación; límite de créditos agotado → la IA se pausa y se avisa.
- **Prototipo:** datos capturados visibles; la lógica de permisos no.

### F18. Llamadas con la plataforma (individual y masivas)
- **Individual:** teléfono en el navegador (WebRTC) › marcar o devolver llamada perdida › en llamada: espera, transferir, conferencia, nota › fin: resultado → grabación (con aviso), transcripción y resumen automático en el historial del contacto. Entrante: identificación del contacto, pop-up, contestar o perdida (queda como tarea de devolución).
- **Masivas (ADR-10):** Telefonía › Campañas › lista existente o CSV subido → modo **progresivo** o **vista previa** → intentos máximos, espera entre intentos, ventana horaria, número saliente → iniciar/pausar → el asesor ve la ficha y el guion → **resultado obligatorio** (interesado, agendó cita, no interesado, volver a llamar) que dispara etiqueta, etapa o tarea.
- **Reglas:** excluir «no llamar»; predictivo no entra en v1; permisos de micrófono y revisión de consentimiento/horario según la normativa local antes de campañas reales.
- **Errores:** sin micrófono → guía; número inválido → fallido sin reintento; proveedor saturado → cola con límite de concurrencia por organización.
- **Prototipo:** teléfono, historial y campañas simulados.

### F19. IA de voz (entrante y saliente) — *flujo de alto riesgo*
- **Saliente:** disparador (lead nuevo, formulario, regla) → la IA llama → conversación → captura datos → actualiza CRM (F17) → termina: agenda cita / transfiere a humano / deja tarea.
- **Entrante:** el cliente llama → la IA contesta → identifica al contacto → consulta CRM y KB → responde → captura → **transfiere a un asesor disponible** o resuelve.
- **Reglas (ADR-04):** proveedor definido tras el PoC Retell vs. Vapi con los mismos casos; las herramientas son las mismas del agente de chat; grabación y aviso obligatorios; tope de minutos y presupuesto por organización.
- **Errores:** sin asesor disponible para la transferencia → toma mensaje y crea tarea; latencia alta o corte → plan de recuperación definido en el PoC.
- **Prototipo:** no incluido (pendiente del PoC).

### F20. Automatizaciones
- **Pasos:** Automatizaciones › «Nueva regla» › **disparador** (nuevo contacto, mensaje recibido, oportunidad creada, cambio de etapa, cambio de campo, venta, llamada, evento externo) → **condiciones** sobre cualquier campo autorizado (ciudad, interés, presupuesto, etiquetas, etapa) → **acciones** (asignar a cola o asesor, mover etapa, modificar campo, enviar mensaje, iniciar IA, llamar, tarea, etiqueta, ejecutar otra regla) → guardar → activar → ver ejecuciones.
- **Reglas:** ejecución como máquina de estados persistida (`flow_runs`), un paso = un job con bloqueo por conversación; detección de ciclos (límite de profundidad); toda acción deja auditoría `origen=automatización`; variables con ámbito.
- **Errores:** acción fallida → reintento y registro; regla que se dispara a sí misma → se corta.
- **Prototipo:** lista de reglas y editor básico.

### F21. Dashboard, analítica y SLA
- **Dashboard (por usuario):** rango de fechas (hoy … personalizado hasta 92 días), widget grande de **valor generado en ventas** (cobrado, por cobrar, ventas, ticket, comparación con el período anterior, meta), leads, oportunidades, tiempo de primera respuesta, atención requerida, embudo, conversión por asesor, actividad; orden configurable; ojo por tarjeta; el asesor ve solo sus cifras.
- **Analítica:** conversión **lead→venta por cohorte** (por asesor, cola y fuente; mínimo 20 leads para el ranking), tiempos de respuesta (primera y posteriores) con horario laboral, llamadas (perdidas, duración), IA, canales, comisiones.
- **SLA en vivo:** chip por conversación (en regla / en riesgo / vencido); «Atención requerida» lleva al chat; reportes por asesor excluyen fuera de horario y feriados.
- **Reglas:** consultas agregadas siempre filtradas por organización; exportar requiere permiso y queda en auditoría; las preferencias del dashboard son del usuario, no de la organización.
- **Prototipo:** sí (cifras sintéticas).

---

## Matriz de riesgo

| Flujo | Riesgo principal | Cómo se valida primero |
|---|---|---|
| F05 WhatsApp QR | Desconexión o bloqueo del número | Prueba de reconexión con un número de laboratorio |
| F06 GHL | Paso manual del Workflow; anti-eco de etiquetas | Contrato con adapter falso + cuenta de prueba |
| F17 IA→CRM | Escrituras erróneas o sin permiso | Lista blanca de campos/herramientas + auditoría |
| F19 Voz IA | Costo y latencia por llamada | PoC de 2 días con 2 proveedores |
| F15 Comisión | Saldo impago ya comisionado | Decisión sobre reversión (abierta) |
| F09/F10 | Fuga de chats entre asesores | Prueba de visibilidad en servidor/RLS, no en la interfaz |
| Todos | Fuga entre empresas | Suite de aislamiento A↔B por endpoint como puerta de CI |

## Decisiones tomadas (2026-10-03, ver ADR-18)
1. Reversión de comisión por saldo impago: regla configurable, desactivada por defecto (F15). Meta: Purchase con ventana de gracia antes de enviarse; luego no se retira; reportes en neto; evento personalizado `SaleCanceled` opcional y apagado por defecto (**confirmado**; «SaleCancelled» no existe como evento estándar de Meta; ventana configurable 30–60 min, máx. 24 h).
2. Comisión de chat compartido: la cobra el dueño; porcentaje compartido opcional (F10).
3. Cita: etapas ocultables (no eliminables) y «etapa de cita» opcional por pipeline; Schedule a Meta se envía por la cita, no por la etapa (F12, F13).
4. Agencia retirada: clientes pasan al Súper Admin con historial de pertenencia; cliente vencido en solo lectura para la agencia (F02).
5. Tope de 5 recordatorios en QR/Messenger/Instagram: confirmado (F13).
6. Analítica: ver reporte y descargar CSV por pestaña y período (F21).

## Decisiones abiertas
1. Validar con una prueba real en Events Manager que (a) el evento personalizado se registra y (b) no hay forma de revertir un Purchase enviado.
2. Hosting/región, retención de grabaciones y proveedor de voz (F18, F19).
