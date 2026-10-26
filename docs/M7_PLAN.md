# M7 — GoHighLevel · Plan de ejecución

> Preparado 2026-10-24 tras cerrar M6. Fuente: Build Spec §14 (M7) y §6 (`ghl_connections`, `ghl_sync_state`, `external_ids`, `webhook_endpoints`, `webhook_deliveries`); ADR-05; flujo F06; auditoría del sistema antiguo (`docs/legacy-audit`: Entrega 1 §117 y §181, Inventario #20, Lista R5). Decisiones nuevas: **ADR-52** (APROBADO el 2026-10-24 con las recomendaciones de §7).
> Regla de siempre: lo que depende de una cuenta externa se construye **detrás de un puerto con fake y contract test**, y lo que no pude verificar contra GoHighLevel real queda **escrito como suposición** (§5) para validarlo con tu cuenta.

## 1. Aceptación de M7 (Build Spec)
`PrivateTokenProvider`, webhook con secreto comparado en tiempo constante, mensajes entrantes y salientes, etiquetas bidireccionales, inscripción a flujos. **Aceptación:** contract tests con un fake de GHL; token cifrado y jamás devuelto.

## 2. Qué NO entra en M7
OAuth / app del Marketplace de GHL (ADR-05 y «Fuera de alcance»: queda diseñado, no construido; por eso **no hay suscripciones automáticas a eventos** y el paso del Workflow en GHL es manual) · importar toda la base de contactos de GHL · sincronizar pipelines u oportunidades de GHL · calendarios de GHL · pagos de GHL · más de una ubicación (Location) de GHL por empresa.

## 3. Qué ya existe y se reutiliza
Bóveda de credenciales con cifrado de sobre (ADR-42; el token usa AAD `ghl/<empresa>`, igual que `meta/<empresa>` y `channel/<id>`) · el patrón de punto de entrada público por identificador opaco con ruta de IDENTIDAD (`attribution_endpoints`, `channel_routes`) · `webhook_events` con tarea de procesamiento asíncrono, reintentos y vaciado · `NormalizedMessage` y el pipeline de entrada del Inbox · colas, reparto y SLA · etiquetas del sistema y personalizadas · `integrations.manage` (administrador) · `audit_logs` con `source = 'ghl'`.

## 4. Rebanadas
| # | Rebanada | Contenido | Se prueba con |
|---|---|---|---|
| **M7.1** ✔ construida 2026-10-24 (precisiones APROBADAS en ADR-52; validación con GHL real pendiente) | **Conexión** | Tabla `ghl_connections` (una por empresa; RLS forzada, sin DELETE: se desconecta): Location ID, token cifrado (últimos 4; jamás devuelto), estado `active`/`needs_reconnect`/`disconnected`, secreto del webhook (solo su huella) y ruta de identidad `ghl_routes` (id opaco → empresa). Puerto `GhlProvider` (`verify`, y luego etiquetas, flujos y mensajes) con **fake**, adaptador HTTP contra servidor simulado y contract test común. `GET\|PUT /v1/ghl/connection`, `POST …/test`, `POST …/rotate-secret` (`integrations.manage`); el servidor comprueba el token contra GHL ANTES de guardarlo. Web: Configuración › GoHighLevel (token, Location ID, URL del webhook y secreto que se muestran **una vez**, estado, «Probar», «Desconectar»). | Aislamiento A↔B, token jamás en respuesta/auditoría/logs, fake y servidor simulado |
| **M7.2** ✔ construida 2026-10-24 (precisiones APROBADAS en ADR-52; validación con un Workflow real pendiente) | **Entrada por webhook de Workflow** | `POST /v1/integrations/ghl/webhook/:id` público: secreto en tiempo constante, **misma respuesta para «no existe» y «secreto malo»**, límite de tamaño y de ritmo, **200 inmediato** y proceso asíncrono por la tarea de eventos (idempotente por identificador del evento). Mapa `external_ids` (contacto GHL ↔ contacto propio por teléfono/correo). Eventos que entiende: contacto creado/actualizado, etiqueta añadida/quitada, mensaje entrante (formato en §5). Un panel de «últimos eventos» con estado y motivo. | Firma inválida, repetidos, fuera de orden, A↔B, 200 aunque falle el proceso |
| **M7.3** ✔ construida 2026-10-24 (precisiones APROBADAS en ADR-52, con el borrado de etiquetas también en GHL; validación con GHL real pendiente) | **Etiquetas bidireccionales** | Mapeo por **nombre** entre las etiquetas de la empresa y las de GHL; al poner o quitar una etiqueta aquí se hace lo mismo en GHL (con cola, reintentos y espera creciente), y al revés desde el webhook. **Anti-eco** con `ghl_sync_state`: el cambio que vino de GHL no se reenvía a GHL, y viceversa. Las etiquetas del sistema (`Lead`, `Cita agendada`, `Venta`) **salen** hacia GHL pero no se aceptan entrantes (solo las pone el sistema). Auditoría con `source = ghl`. | Anti-eco en ambos sentidos, orden de eventos, etiqueta del sistema entrante ignorada |
| **M7.4** ✔ construida 2026-10-25 (precisiones APROBADAS en ADR-52) | **Mensajes entrantes y salientes** | Un canal «GoHighLevel» en el Inbox: el mensaje que el Workflow reenvía entra como `NormalizedMessage` (mismo reparto, SLA y bandeja que WhatsApp) y la respuesta del asesor sale por la API de GHL con el tipo de canal de origen. Estado de entrega, reintentos y «reenviar» como en M5.4. | Contract test del adaptador, idempotencia por id de mensaje, A↔B |
| **M7.5** ✔ construida 2026-10-26 (precisiones APROBADAS en ADR-52) | **Inscripción a flujos** | Lista de Workflows de GHL (con caché) y la acción «Inscribir en un flujo» desde el contacto y desde la conversación, con permiso, auditoría y resultado visible. | Contract test, permisos, auditoría |

Orden: M7.1 → M7.2 → M7.3 → M7.4 → M7.5. Cada rebanada termina con pruebas, documentación y una parada para tu revisión, como en M5 y M6.

## 5. Lo que NO he podido verificar (honestidad primero)
El documento `docs/GOHIGHLEVEL.md` que cita la auditoría pertenece al repo antiguo y **no está aquí**; no copio código de allí. Lo que sí encontré en la documentación pública de GHL (API 2.0): `POST /contacts/:contactId/tags`, `POST /contacts/:contactId/workflow/:workflowId`, `POST /conversations/messages` (tipos `SMS`, `Email`, `WhatsApp`, `IG`, `FB`, `Custom`, …), autenticación con `Authorization: Bearer` y cabecera `Version`. **Pero** las fuentes que consulté se contradicen en el valor de `Version` (`2021-07-28`, `2023-02-21` y `v3` según la página), no listan el alcance (*scope*) necesario de cada llamada para un *Private Integration Token*, y no encontré cómo se reciben mensajes de otros canales ni el formato exacto de lo que envía la acción «Webhook» de un Workflow. Por eso:
1. El adaptador real se escribe **contra un servidor simulado** y lo fijo en una constante de versión **a confirmar con tu cuenta**.
2. Los **formatos de los eventos entrantes** (etiqueta, mensaje) se definen como un contrato propio y claro (lo que hay que poner en el cuerpo del webhook del Workflow) y se **validan con un Workflow de prueba tuyo** antes de dar M7 por cerrada.
3. Límites de uso: la documentación pública da 100 solicitudes por 10 s y 200 000 por día **para apps del Marketplace**; no encontré el dato para Private Token. El adaptador lee las cabeceras `X-RateLimit-*` si vienen y reintenta con espera creciente.

## 6. Dependencias y bloqueos
| Tema | Estado | Tratamiento |
|---|---|---|
| Subcuenta de GHL con un *Private Integration Token* (con los *scopes* de contactos, conversaciones/mensajes y workflows) y su Location ID | **LO TIENES QUE CREAR TÚ** | Todo se construye y prueba con el fake y el servidor simulado; el envío real se valida con tu subcuenta |
| Un Workflow de prueba en GHL que llame al webhook | **LO CREAS TÚ** (paso manual por ADR-05) | La pantalla te da la URL, el secreto y el cuerpo exacto a pegar |
| Qué canal de GHL (SMS, WhatsApp, Custom…) usan tus clientes | **TÚ LO DECIDES** | Ver decisión 5 |
| Clave `PROVIDER_CREDENTIALS_KEY` en staging | Ya cargada | Sin cambios |

## 7. Decisiones (ADR-52, APROBADAS el 2026-10-24 con las recomendaciones)
1. **Alcance partido en 5 rebanadas** como arriba (recomendado) o conexión + etiquetas primero y mensajes después.
2. **Credencial:** Private Integration Token por empresa, cifrado con la bóveda; sin OAuth (ADR-05, ya aprobado).
3. **Secreto del webhook:** se muestra **una sola vez** (al crear o rotar) y el servidor guarda solo su huella SHA-256, comparada en tiempo constante (recomendado: no hay forma de leerlo después, igual que el token) o guardarlo cifrado para poder mostrarlo de nuevo.
4. **Dónde viaja el secreto:** en una cabecera `X-Webhook-Secret` si la acción «Webhook» del Workflow permite cabeceras (recomendado), o en la dirección (`?s=`), con los logs redactando la consulta. **A confirmar con tu Workflow.**
5. **Mensajes (M7.4):** ¿para qué canal de GHL quieres recibir y responder desde Sales Smart? Recomiendo **un canal genérico «GoHighLevel»** que responde por el mismo tipo con que llegó cada conversación, y dejar WhatsApp para el canal oficial de Meta (M5), que ya existe.
6. **Etiquetas:** por **nombre**, bidireccionales para las personalizadas; las del sistema solo salen (recomendado).
7. **Contactos desde GHL:** un evento de un contacto desconocido **crea** el contacto (por teléfono; sin teléfono, por correo) con origen «GoHighLevel» y asesor según la cola, igual que un mensaje nuevo de WhatsApp; no se importa la base entera (recomendado).
8. **Plantillas:** el sistema antiguo listaba «plantillas» de GHL; no sé con certeza a cuáles se refería. Recomiendo **dejarlas fuera** (ya existen plantillas de WhatsApp en M5.6a) salvo que me digas lo contrario.
9. **Una Location de GHL por empresa** (recomendado; varias, después).
10. **Errores:** token rechazado ⇒ conexión `needs_reconnect` (los envíos esperan, no se pierden) y aviso visible; límite de uso ⇒ reintentos con espera creciente.

## 8. Riesgos
Seguridad: webhook público ⇒ secreto, límite de ritmo y de tamaño, respuesta uniforme, cuerpo jamás en logs. Consistencia: eco infinito de etiquetas (anti-eco con estado de sincronización y pruebas en ambos sentidos), eventos fuera de orden y repetidos. Privacidad: teléfonos y mensajes no van a logs. Dependencia: si GHL cambia la versión de la API, el adaptador es el único lugar a tocar.
