# M6 — Citas, ventas y Meta · Plan de ejecución

> Preparado 2026-10-23 tras cerrar M5 (salvo la validación real de R2, ClamAV, ffmpeg y medios de Meta). Fuente: Build Spec §14 (M6), §6.4–6.6, §7; ADR-08, ADR-13, ADR-18, ADR-32 (+enmienda 1), ADR-45, ADR-49, ADR-50; flujos F13, F14 (y la parte Meta de F15). Decisiones nuevas: **ADR-51** (decisiones del plan APROBADAS el 2026-10-23 con las recomendaciones de §7).
> Regla de siempre: lo que depende de cosas que aún no tenemos (credenciales del pixel de Meta, Google Calendar) se construye **detrás de un puerto con fake y contract test**. Cada rebanada termina con pruebas, documentación y una parada para tu revisión.

## 1. Aceptación de M6 (Build Spec)
Un Purchase anulado dentro de la ventana de gracia **nunca** se envía · el mismo `event_id` en los reintentos · saldo = total − pagos (derivado). Además: citas con recordatorios (topes por fuente), ventas con abono y catálogo por cola, dashboard, atribución Meta (Lead / Schedule / Purchase) y analítica con CSV.

## 2. Qué NO entra en M6
Comisiones (planes, aprobación, pago: M10; M6 solo deja la venta lista para ellas), Google Calendar (integración opcional posterior), recordatorios por Messenger / Instagram / WhatsApp QR (esos canales no existen todavía; el tope de 5 queda configurado pero solo se usa con ellos), GoHighLevel (M7), reportes en XLSX/PDF (solo CSV), metas y `goals` (M10).

## 3. Qué ya existe y se reutiliza
Etiquetas del sistema `Cita agendada` y `Venta` (`SystemTagsService`), tubería `meta_events` + puerto `CapiProvider` con fake y ventana de gracia cancelable (`AttributionService.onSaleTagSet` y `cancelPurchase`, probadas pero sin quien las llame), etapa de cita y etapa ganada en los pipelines, SLA que se detiene al ganar, mensajes programados y plantillas de WhatsApp (los recordatorios reutilizan el envío), permisos `sales.create`, `sales.cancel`, `appointments.manage`, `analytics.view` en el catálogo, cola con `queues` (falta el catálogo de productos).

## 4. Rebanadas
| # | Rebanada | Contenido | Se prueba con |
|---|---|---|---|
| **M6.1** | **Catálogo de productos por cola** | `queue_products` (nombre, tipo producto/servicio, precio, activo; RLS forzada, sin DELETE: se desactiva), pantalla en Configuración › Colas, permiso `queues.manage` existente. Una cola sin productos no puede vender (F14). | Aislamiento A↔B, web |
| **M6.2** | **Ventas, abonos y saldo** | `sales`, `sale_payments` (solo inserción), `sale_status_history` (solo inserción), `sale_change_requests`; botón «Registrar venta» del chat (producto de la cola, cantidad, total, abono, método) con `Idempotency-Key`; «Registrar pago del saldo» desde la venta; anular con permiso y motivo; etiqueta Venta, oportunidad a la etapa ganada, SLA se detiene, `sale.created` al outbox. Saldo y «cobrada» derivados en el servidor; abono > saldo rechazado. Pestaña «Ventas» en el contacto y pantalla «Ventas». | Dinero (concurrencia de abonos, doble clic), A↔B, web |
| **M6.3** | **Citas y recordatorios** | `appointments`, `appointment_reminders`, `appointment_reminder_limits`; botón «Agendar» del chat (día, hora, tipo, notas, recordatorios con tope 3 / 5 validado en el servidor); etiqueta Cita agendada, oportunidad a la etapa de cita, `appointment.created` al outbox; recordatorios como tarea periódica sobre PostgreSQL que los manda por el canal de la conversación (texto dentro de las 24 h; plantilla fuera) con estado de entrega visible; cancelar o reprogramar cancela los recordatorios; pantalla «Agenda» (día/semana). | Reloj simulado, ventana de 24 h, A↔B, web |
| **M6.4** | **Salida real a Meta (CAPI)** | Credenciales del dataset/pixel **por empresa** cifradas con la bóveda (tabla de negocio propia), adaptador real de Graph API (`CapiProvider`) con contract test contra servidor simulado, eventos `Lead`, `Schedule` (por la cita) y `Purchase` (por el total, con ventana de gracia configurable por empresa, máx. 24 h, `event_id` estable), pantalla Configuración › Meta (credenciales, ventana, prueba de conexión) y panel de eventos fallidos con reintento. | Purchase anulado nunca sale; mismo `event_id`; fake y servidor simulado |
| **M6.5** | **Dashboard y analítica con CSV** | Dashboard de inicio (leads, citas, ventas, ingresos, saldo por cobrar, embudo por etapa, tiempos de respuesta) por rango de fechas, con alcance propio para el asesor; pestañas de analítica (Ventas, Citas, Embudo, Asesores) con tabla y `POST …/export` en CSV con BOM y anti-fórmulas (permiso `analytics.export`, auditado). | Alcance por rol, A↔B, CSV |

Orden: M6.1 → M6.2 → M6.3 → M6.4 → M6.5. M6.4 antes que M6.5 no es obligatorio, pero M6.2 y M6.3 ya dejan encolados los eventos para que M6.4 solo tenga que enviarlos.

## 5. Dependencias y bloqueos
| Tema | Estado | Tratamiento |
|---|---|---|
| Pixel / dataset de Meta y token de la API de Conversiones | **LO TIENES QUE CREAR TÚ** (Events Manager) | M6.4 se prueba con el fake y un servidor simulado; el envío real se valida con tu dataset de prueba (`test_event_code`) |
| Prueba en Events Manager de «retirar un evento» (decisión abierta #7) | ABIERTO | No bloquea: la ventana de gracia evita enviar lo que se anula a tiempo; qué hacer con una venta anulada **después** de la ventana se decide con esa prueba |
| Plantillas de WhatsApp para recordatorios fuera de las 24 h | Dependen de tu cuenta de Meta | El recordatorio fuera de ventana exige elegir una plantilla aprobada al agendar; si no hay, solo se permiten recordatorios que caigan dentro de la ventana y se avisa |

## 6. Riesgos
Dinero: abonos simultáneos sobre la misma venta (bloqueo por fila y verificación del saldo dentro de la transacción). Recordatorios: huso horario de la empresa y cambio de hora (se guardan instantes UTC y la hora local del cliente se muestra con la zona de la empresa). Meta: `event_time` con más de 7 días rechaza el lote (se vence el evento, estado `expired`); un Purchase sin atribución sale sin ella y se marca. Privacidad: el teléfono y los datos de la venta no van a logs.

## 7. Decisiones (ADR-51, APROBADAS el 2026-10-23 con las recomendaciones)
1. **Alcance partido en 5 rebanadas** como arriba (recomendado) o ventas+Meta antes que citas.
2. **Moneda:** una por empresa, USD por omisión (Ecuador) y editable en Configuración (recomendado) o varias por venta.
3. **Producto en la venta:** una línea por venta (un producto, cantidad y total editable) (recomendado: es lo que muestra el prototipo) o varias líneas.
4. **Quién anula una venta:** `sales.cancel` solo del administrador, con motivo; el asesor pide corrección con `sale_change_requests` (ADR-32). Anular después de la ventana de gracia deja el Purchase enviado y se anota en la venta (recomendado hasta la prueba de Events Manager).
5. **Abonos:** el asesor registra abonos de sus ventas; el administrador de todas; ninguno se edita ni se borra (corrección = abono negativo con permiso de administrador y motivo) (recomendado) o sin correcciones.
6. **Recordatorios fuera de las 24 h:** exigir plantilla elegida al agendar (recomendado) o bloquearlos.
7. **Ventana de gracia de Purchase:** 30 min por omisión, configurable por empresa de 0 a 24 h (recomendado).
8. **Agenda:** una agenda por empresa filtrable por asesor; la cita pertenece al asesor dueño de la conversación; sin choques de horario por ahora (recomendado) o con detección de choques.
9. **Dashboard:** rango por omisión últimos 30 días y zona horaria de la empresa; el asesor solo ve lo suyo (recomendado).
