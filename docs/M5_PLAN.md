# M5 — Inbox y WhatsApp oficial · Plan de ejecución

> Preparado 2026-10-18 tras cerrar M4. Fuente: Build Spec §14 (M5), §6.4/6.5, §7, §8, §9, §10; ADR-02, ADR-07, ADR-13, ADR-14, ADR-16, ADR-17, ADR-33, ADR-42, ADR-45; flujos F08, F09, F10. Decisiones nuevas: **ADR-50** (APROBADO 2026-10-18).
> Regla (igual que M1): lo que depende de cosas que aún no tenemos —credenciales de Meta, almacenamiento de archivos, antivirus— se construye **detrás de un puerto con fake y contract test** y se marca. Cada rebanada termina con pruebas, documentación y una parada para tu revisión.

## 1. Aceptación de M5 (Build Spec)
Webhook repetido no duplica mensajes · el asesor no ve chats ajenos (aplicado en el servidor) · una nota interna jamás sale al cliente · fuera de las 24 h de WhatsApp oficial solo se puede enviar una plantilla. Más: colas con reparto ponderado, transferir y compartir, composer completo, SLA y cronómetros, filtros por rol, tiempo real y móvil.

## 2. Qué NO entra en M5
WhatsApp por QR (`EvolutionProvider`, V1), Messenger e Instagram, GoHighLevel, agentes de IA, automatizaciones, llamadas, ventas y citas (M6; el botón «Agendar/Venta» del chat queda para entonces), campañas masivas y grupos (V1/V2). El Inbox sí deja los **ganchos** (el pipeline de handlers del flujo F08 tiene sitio para la IA y las reglas, vacío hasta M7).

## 3. Dependencias y bloqueos
| Tema | Estado | Tratamiento en M5 |
|---|---|---|
| Aplicación de Meta, WABA y número de prueba | **LA TIENES QUE CREAR TÚ** (ver §6) | M5.1 y M5.2 se prueban con el fake y con peticiones simuladas; el contacto real con Graph API se valida cuando haya credenciales |
| Dominio público https para el webhook | La URL pública de Railway sirve para la prueba | Sin cambios de infraestructura |
| Cola de trabajos | Sin Redis (ADR-33) | Procesamiento asíncrono en PostgreSQL con `SKIP LOCKED` (ADR-50 #4) |
| Tiempo real | No existe WebSocket | Socket.IO en el mismo proceso en M5.7; antes, el Inbox consulta con refresco periódico |
| Almacenamiento de archivos y antivirus | Proveedor ABIERTO (S3-compatible) | Solo en M5.6, detrás de `StorageAdapter` con fake; hasta entonces el Inbox maneja texto |
| Clave maestra de credenciales (`PROVIDER_CREDENTIALS_KEY`) | Opcional hoy | **Obligatoria** para guardar el token de un número (ya lo exige la bóveda) |
| Plantillas aprobadas por Meta | Las aprueba Meta (horas/días) | M5.6 las sincroniza y las lista; el envío usa la que la persona elija |

## 4. Rebanadas
| # | Contenido | Se puede probar sin Meta |
|---|---|---|
| **M5.1** | **Conexiones**: tablas `channel_accounts`, `whatsapp_accounts` y la ruta de identidad `channel_routes` (número → empresa); puerto `WhatsAppProvider` + `NormalizedMessage` + fake + contract test; credenciales del número cifradas con la bóveda (nunca se devuelven); API y pantalla «Conexiones» (WhatsApp oficial: nombre, WABA, `phone_number_id`, token; estado; comprobar, desactivar, desconectar). *La URL del webhook se muestra desde M5.2, cuando el endpoint existe.* **Construida 2026-10-18** | Sí |
| **M5.2** | **Entrada de mensajes**: `GET/POST /v1/channels/meta/webhook` (verificación, firma `X-Hub-Signature-256`, 200 inmediato), `webhook_events` + tarea de proceso, `MetaCloudProvider` (lectura de eventos), contacto por teléfono (existente o nuevo), **una conversación abierta por contacto y canal**, mensajes idempotentes `(canal, external_id)`, estados entregado/leído | Sí (cargas simuladas con firma real) |
| **M5.3** | **Colas y reparto**: `queues`, `queue_members`, reglas y estado del reparto (equitativo, ponderado, por carga, lote, tope, horario, reasignación), asignación al llegar, «Sin asignar»; pantalla «Colas y asignación» | Sí |
| **M5.4** | **Bandeja y respuesta de texto**: lista (Trabajando / Esperando / Finalizadas, filtros, no leídos), chat, Aceptar, responder, nota interna, ventana de 24 h, estados de envío con reintento, finalizar, visibilidad por rol | Sí con el fake; el envío real, con Meta |
| **M5.5** | **Transferir y compartir + SLA**: participantes, nota automática, revocar; `sla_policies`, horario laboral y feriados, cronómetros, primera respuesta, reasignación por no responder | Sí |
| **M5.6** | **Composer completo**: adjuntos (almacenamiento + antivirus), audio, plantillas, respuestas rápidas con variables, mensajes programados | Con fakes; plantillas y medios reales, con Meta |
| **M5.7** | **Tiempo real y móvil**: Socket.IO (salas `org:{id}` y `user:{id}`), contadores y avisos, diseño móvil del Inbox | Sí |

Orden: cada rebanada necesita la anterior. M5.1–M5.3 son «cañerías» (sin pantalla de chat todavía); el Inbox visible llega en M5.4. Si prefieres ver un chat antes, M5.4 puede adelantarse con un contacto de prueba y el fake; lo recomiendo en este orden porque así el reparto y la idempotencia se prueban antes de que haya clientes reales.

## 5. Riesgos
- **R1 — Meta.** La API tiene reglas propias (ventana de 24 h, plantillas, calidad del número, límites por nivel). Mitigación: el estado de cada mensaje se muestra y nunca se asume entregado (ADR-13), la ventana se valida en el servidor y la verificación real se hace con un número de prueba antes de abrir a clientes.
- **R2 — Cuerpo crudo del webhook.** La firma se calcula sobre el cuerpo exacto; hay que conservarlo sin reinterpretarlo. Mitigación: ruta con lector de cuerpo crudo propio y prueba de firma inválida/alterada.
- **R3 — Datos personales en los eventos.** Los webhooks traen teléfonos y texto. Mitigación: redacción en logs, eventos crudos con retención corta (30 días, provisional) y minimización una vez procesados.
- **R4 — Volumen.** `messages` crece rápido. Mitigación: índices por conversación y fecha desde el inicio; partición por fecha se evalúa cuando haya cifras reales.
- **R5 — Un solo proceso para tiempo real.** Con varias instancias hace falta un adaptador Redis; se decide con la primera señal de necesidad (ADR-50 #6).
- **R6 — Normalización de teléfonos.** WhatsApp entrega `wa_id` sin «+» y a veces sin el 9 o el prefijo local; un contacto puede duplicarse. Mitigación: se normaliza a E.164 con la misma regla de M3 y se registra el original en el mensaje.

## 6. Lo que necesito de ti (insumos externos)
1. **Una aplicación de Meta** de tipo «Business» con el producto *WhatsApp* añadido, y una **cuenta de WhatsApp Business (WABA)**. Meta ofrece un **número de prueba** gratuito que sirve para M5.1–M5.4 (no hace falta un número real todavía).
2. De la aplicación: **ID de la app**, **secreto de la app** y un **token de verificación** del webhook (cualquier cadena larga que elijas): se cargan en *Plataforma › Proveedores › WhatsApp oficial* (ya existe la pantalla; solo el Súper Admin la ve).
3. De cada número: **WABA ID**, **Phone number ID** y un **token de acceso permanente** (usuario del sistema) con permisos `whatsapp_business_messaging` y `whatsapp_business_management`: lo pega el administrador de la empresa en «Conexiones».
4. Cuando lleguemos a M5.6: elegir **dónde guardar los archivos** (S3 compatible: Cloudflare R2, Backblaze B2, un bucket de Railway…) y cómo escanearlos (ClamAV propio o un servicio).
Nada de esto bloquea M5.1; sí hace falta (1) y (2) antes de probar M5.2 contra Meta de verdad.

## 7. Pruebas obligatorias por rebanada
Unitarias de dominio · integración con PostgreSQL real incluyendo RLS · **aislamiento A↔B por endpoint** · contract tests del `WhatsAppProvider` (fake y Meta contra servidor simulado) · webhooks: firma inválida, repetido, fuera de orden, número desconocido · E2E con Playwright.
