# v9 · Fase A — Auditoría: mensajes escritos desde el teléfono (WhatsApp QR) y sombra de las burbujas

> Fecha: 2026-11-10. Solo lectura del código; no hay cambios de producto. Los números de línea son los de `main` en `f4d7d67`+`CLAUDE.md` (#62).

## Resumen

La causa del prompt está **confirmada**: el lector descarta todo mensaje con `fromMe: true`. Pero la auditoría encontró **tres cosas que cambian el diseño** y una pregunta que decide si se puede seguir:

1. **Carrera con el eco de la plataforma (riesgo de duplicados).** El `external_id` de un mensaje que enviamos se guarda *después* de que Evolution responde, en una transacción aparte. Si el aviso `messages.upsert` con `fromMe: true` llega antes, el lector no encuentra el mensaje y lo trataría como «escrito desde el teléfono»: **quedaría duplicado**. Hay una salida sin migración (ver §1).
2. **El SLA no se detiene solo.** `stopOnReply` solo se llama desde el envío de la plataforma. Un mensaje desde el teléfono hay que conectarlo a mano (Fase C).
3. **Un mensaje de salida NO puede pasar por `ingestInbound`**: esa ruta suma no leídos, mueve `last_inbound_at`, reparte la conversación, arranca el cronómetro de seguimiento y dispara el saludo. Hace falta una ruta propia.
4. **Premisa no evidenciada:** el spike nunca capturó un `messages.upsert` con `fromMe: true` (ni de un mensaje enviado por la API ni de uno escrito en el teléfono). Solo vio `send.message` y `messages.update`. La coincidencia de ids está respaldada solo de forma indirecta (§1).

## 1. ¿Coincide el `key.id` del aviso `fromMe` con el que devuelve Evolution al enviar?

- Al enviar, `EvolutionProvider.idOf` toma `response.key.id` (`apps/api/src/modules/qr/evolution.provider.ts:92-97`) y `QrOutboundService.attempt` lo guarda como `messages.external_id` (`qr/qr-outbound.service.ts:84`).
- Los estados de entrega ya llegan por `messages.update` con `keyId` y se cruzan contra ese mismo `external_id` (`channels/evolution-webhook.ts:182-192`, `conversations/conversations.service.ts:154-180`; prueba `test/qr/qr.test.ts:346`). Que los estados funcionen es **evidencia indirecta** de que el id de Baileys es el mismo en la respuesta y en los avisos.
- **No hay captura directa** de un `messages.upsert` `fromMe` para un mensaje de la plataforma (`spikes/whatsapp-qr/INFORME.md`, A2: solo `send.message` y `messages.update`). Se desconoce si Evolution lo emite para los envíos por API.
- **Carrera:** `attempt` guarda el `external_id` *después* de `await provider.sendText(...)`, en otra transacción (`qr-outbound.service.ts:83-84`). El aviso `fromMe` puede llegar antes; en ese instante el mensaje está `queued` con `external_id` nulo y la deduplicación (`ingestInbound`, `conversations.service.ts:73`, y el índice único `(org, canal, external_id)`) no lo ve.
- **Salida propuesta sin migración:** reutilizar el patrón que ya existe para estados y reacciones que llegan antes que su mensaje (`channels/webhook-events.service.ts:98-119`, `STATUS_WAIT_MS` = 2 min, reintento cada 10 s sin gastar intentos). Un aviso `fromMe` cuyo id no se encuentra espera esa ventana; si pasada la ventana sigue sin existir, se registra como «desde el teléfono». Costo: un mensaje real del teléfono aparece unos 2 minutos tarde. Alternativa más rápida (decisión abierta, §6): esperar solo si hay un envío nuestro en vuelo en esa conversación (`status = 'queued'`, `attempts > 0`, `external_id` nulo); si no, entra al instante.

## 2. Cómo se procesan hoy los avisos entrantes y dónde se decide la dirección

- `POST /v1/integrations/qr/webhook/:routeId` → `QrWebhookService.ingest` (`qr/qr-webhook.service.ts:35-71`) guarda el aviso en `webhook_events` (sin `apikey`) y lo procesa enseguida con `WebhookEventsJob.drain`.
- `WebhookEventsService` recorre los eventos normalizados: **todo mensaje se pasa a `ingestInbound`** (`channels/webhook-events.service.ts:103`); no existe el concepto de dirección en `NormalizedMessage`.
- La dirección hoy se decide en el lector: `upsert` descarta `fromMe` (`channels/evolution-webhook.ts:153`); lo único `fromMe` que pasa son los estados de `messages.update` (`:187`). `ingestInbound` fija siempre `direction: 'in'`, `sender_type: 'contact'` (`conversations/conversations.service.ts:93-94`).
- Para el v9 hace falta: un campo `direction`/`origin` en el mensaje normalizado (`conversations/normalized.ts`) y una función propia (p. ej. `ingestDeviceMessage`) que **no** haga lo de entrada.

## 3. ¿`humanWroteSince` cuenta un mensaje con `created_by` nulo?

**Sí.** `humanWroteSince` (`ai/runtime/agent-runtime.service.ts:416-419`), `humanBlocks` (`:411-414`) y `pauseForHumans` (`:109-125`) filtran por `direction = 'out' AND sender_type = 'human' AND status <> 'internal' AND sent_at > GREATEST(resumed_at, assigned_at, ac.created_at)`. **Ninguna mira `created_by`.** Un mensaje `out`/`human`/`sent` sin autor pausa al agente. No hace falta corregir esa condición.

Matices:
- La pausa es **perezosa**: la hace la tarea `agent-replies` (cada 5 s) con motivo `human_message`, nota interna del sistema y auditoría `ai_agent` con **origen `automation`** (`:123`), no `manual` como dice el prompt. La nota dice «Una persona intervino…» (texto de `handoffNote`). Si se quiere el origen `manual`, hay que decidirlo (§6).
- Se compara `sent_at`: el mensaje del teléfono debe guardar la hora de WhatsApp (`messageTimestamp`), como los entrantes.

## 4. Cronómetro de SLA

- `SlaService.stopOnReply` (`sla/sla.service.ts:133-140`) detiene el cronómetro abierto con `stop_reason = 'human_reply'` y mide el tiempo hábil. **No distingue el origen.**
- Solo lo llaman los envíos de la plataforma: `inbox/outbound.service.ts:98` (adjuntos) y `:174` (texto/plantilla). Un mensaje desde el teléfono **no** lo detendría: hay que llamarlo desde la ruta nueva (Fase C), con la zona horaria de la empresa (`OrgDirectoryService`, leída antes de la transacción, como hacen las tareas).

## 5. Qué muestra la bandeja con un mensaje de salida sin autor

- `messageView(m, author=null)` (`inbox/inbox.views.ts:185`); la burbuja (`apps/web/src/features/inbox/MessageBubble.tsx`) solo escribe una línea de autor si `out && m.author` (`:128`), y rótulos propios para `ai` y `automation` (`:129-130`). Sin autor: burbuja de salida sin nombre y **sin avatar** (los avatares son por grupo de mensajes).
- La sombra a cambiar está en **`MessageBubble.tsx:127`** (`shadow-sm` en la burbuja), no en la línea 90 que cita el prompt (el archivo cambió). Otros `shadow-sm` del archivo (`:142-143`) son los de la reacción: el prompt no los menciona; se dejan igual salvo que se pida lo contrario.
- La etiqueta «Desde el teléfono» necesita un dato en el mensaje: `meta.origin = 'device'` ya viaja en `meta`; `messageView` devuelve el resto de `meta` en `extra` (`inbox.views.ts:187`), así que la web puede leerlo sin cambiar el contrato (si se prefiere un campo propio, es un cambio pequeño).

## 6. Decisiones abiertas (antes de la Fase B)

1. **Carrera del eco** (§1): ¿esperar siempre 2 min (simple, sin migración) o solo cuando hay un envío nuestro en vuelo (más rápido, algo más de código)? Recomendación: **solo cuando hay un envío en vuelo**.
2. **Conversación nueva por un mensaje del teléfono** (el contacto o la conversación no existen): ¿se crea sin repartir (queda «sin asignar», sin etiqueta Lead, sin saludo) o se ignora? Recomendación: **crearla sin repartir**; la etiqueta Lead es para quien *escribe* por primera vez.
3. **Origen de la auditoría de la pausa**: dejar `automation` (lo que hace hoy cualquier pausa por mensaje humano) o pasar a `manual` solo para esta causa. Recomendación: **dejar `automation`** y que la nota diga «Se escribió desde el teléfono».
4. **Qué pasa con el teléfono apagado / reconexión** (B3/B4/A8/A9 del spike siguen sin probar): el v9 no cubre mensajes que Evolution entregue al reconectar; se declara como no validado.
5. **Premisa del eco**: como no hay captura real de un `fromMe` upsert, la primera prueba con tu teléfono (enviar desde el teléfono y desde la plataforma, y mirar `webhook_events` en staging) debería hacerse antes de dar por bueno el diseño.

## 7. No cambia / fuera de alcance

Grupos, estados de WhatsApp, reacciones y notas escritas desde el teléfono siguen ignorados (§0 del prompt). No se toca la restricción de `sender_type` ni se crea ninguna migración (`sender_type = 'human'`, `created_by` nulo, `meta.origin = 'device'`, `status = 'sent'`).

## 8. Plan de los siguientes PR (sin cambios respecto al prompt)

- **PR 2 (B + C):** `direction`/`origin` en el mensaje normalizado; lector sin descartar `fromMe`; `ingestDeviceMessage` (idempotente, sin efectos de entrada); espera del eco; detener el SLA; pruebas unitarias, con PostgreSQL real y A↔B.
- **PR 3 (D):** etiqueta «Desde el teléfono» y sombra mínima (claro/oscuro/WhatsApp), con E2E.
