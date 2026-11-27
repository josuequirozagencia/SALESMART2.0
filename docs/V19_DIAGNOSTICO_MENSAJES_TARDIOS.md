# v19 — Diagnóstico: mensajes que llegan tarde (Jakilu Academy y «todas las empresas»)

> **Documento histórico (foto del 2026-11-17).** Después se construyeron B1, B2, B3 y B4 (ver ADR-50 y ADR-54). Además, la conclusión sobre `@lid` (§1.3 y §3.4) **quedó superada**: ADR-73 encontró que el lector sí descartaba mensajes identificados solo con `@lid` (en una empresa, 30 contactos y unos 241 mensajes), que esta medición no veía. B5 no se construyó.

> Fase A del prompt v19. **Solo lectura**: se consultó staging con cifras agregadas (conteos y tiempos); no se imprimió ningún teléfono, nombre de contacto ni texto de mensaje. Fecha de las mediciones: 2026-11-17, ~13:00 UTC (08:00 hora de Ecuador). El túnel a la base se cerró y se borraron los archivos con credenciales al terminar.

## 1. Resumen

1. **Solo Jakilu tiene un retraso grande, y nace ANTES de llegar a nuestra plataforma.** Sus mensajes entrantes entran a Sales Smart con **21 a 38 horas de retraso** respecto a la hora que el proveedor (WhatsApp/Evolution) les puso, y el retraso **crece de a ~1 hora por hora** desde el 13/11 ~14:15. Una vez que el aviso llega, lo procesamos en segundos. No es una pérdida de mensajes: es una cola que se atrasa aguas arriba (Evolution o la sesión de WhatsApp de ese número).
2. **Las demás empresas están bien en el servidor:** mediana de **0,8 s** y percentil 95 de **≈2 s** entre la hora del mensaje y su guardado (Academia SICP, Pasiel, Growth Consulting por QR). Growth Consulting por Meta oficial: 6 s (la tarea de 5 s).
3. **Las dos hipótesis nuevas del prompt quedan descartadas con datos:** ningún aviso entrante de Evolution llegó con `@lid` sin teléfono (**0 de 2 996 avisos `messages.upsert`**: 1 230 entrantes y 1 766 escritos desde el teléfono) y **los mensajes escritos desde el teléfono sí entran** (v9 está desplegado: 1 766 mensajes de salida «desde el teléfono» guardados en 7 días).
4. **Lo que NO pude medir** y es necesario para cerrar la causa de Jakilu: lo que pasa dentro de Evolution para esa instancia (sus registros y su cola de avisos) y el estado del teléfono. Abajo digo qué comprobar.
5. **Sobre «todas las empresas no ven los mensajes en tiempo real»:** el servidor los tiene en ~1 s, así que si en pantalla tardan hay que mirar el tramo servidor → navegador (tiempo real por Socket.IO). Encontré dos debilidades reales en ese tramo (§5) pero **no tengo evidencia de que sean la causa**; propongo medirlo antes de tocarlo.

## 2. Qué conexión usa Jakilu

WhatsApp por QR (Evolution), una sola conexión activa, sesión `open` y sin caídas (`down_since` vacío; el latido responde cada 60 s; último aviso de Evolution: ahora mismo). Conectada por primera vez el 13/11 11:47 (hora de Ecuador). No usa Meta oficial ni GoHighLevel. Sus conversaciones afectadas empezaron por un mensaje del cliente (dato confirmado por el responsable).

## 3. Evidencia

### 3.1 Retraso de entrada por empresa (mensajes ENTRANTES, últimos 7 días)
Diferencia entre `messages.sent_at` (la hora que informa el proveedor) y `messages.created_at` (cuándo entró a nuestra base).

| Empresa | Canal | Entrantes | Mediana | P95 | Máximo | > 1 min | > 1 h |
|---|---|---|---|---|---|---|---|
| Academia SICP | QR | 460 | 0,8 s | 1,9 s | 0,1 min | 0 | 0 |
| Pasiel | QR | 471 | 0,9 s | 2,0 s | 0,1 min | 0 | 0 |
| Growth Consulting | QR | 28 | 0,9 s | 2,1 s | 0,0 min | 0 | 0 |
| Growth Consulting | Meta oficial | 5 | 6,2 s | 7,2 s | 0,1 min | 0 | 0 |
| **Jakilu Academy** | **QR** | **257** | **30,4 h** | **35,5 h** | **38,4 h** | **242** | **242** |

De las **32 conversaciones** de Jakilu que empezaron con un mensaje del cliente en 7 días, **29 tuvieron su primer mensaje con más de 30 minutos de retraso**; en las otras empresas, 0.

### 3.2 El retraso de Jakilu crece con el tiempo
Retraso medio de lo que entró en cada hora (hora de Ecuador), y el mensaje más viejo que entró en esa hora:

| Entró (hora) | Mensajes | Retraso medio | Mensaje más viejo enviado a las |
|---|---|---|---|
| 13/11 12h | 14 | 0,0 h | 13/11 12:12 |
| 14/11 12h | 3 | 22,3 h | 13/11 14:16 |
| 14/11 19h | 7 | 26,5 h | 13/11 16:39 |
| 15/11 16h | 4 | 27,9 h | 14/11 12:49 |
| 16/11 12h | 6 | 27,2 h | 15/11 09:08 |
| 16/11 23h | 44 | 33,7 h | 15/11 13:34 |
| 17/11 07h | 4 | 38,4 h | 15/11 16:59 |

El día de la conexión (13/11) el retraso era cero. A partir de ahí hay un hueco (nada entró entre el 13/11 ~13:00 y el 14/11 ~11:00) y desde entonces los avisos llegan **en orden y a ritmo casi de tiempo real, pero 21 h atrasados y cada hora un poco más**. Eso es lo que hace una cola que se procesa un poco más lento de lo que se llena.

### 3.3 Nuestro procesamiento es rápido
- **Avisos de Jakilu:** 639 en 7 días; **todos `done`, ninguno `pending` ni `failed`, intentos máximos 1**. No hay avisos atrasados ni fallidos en ninguna empresa.
- El retraso entre recibir el aviso y procesarlo (`received_at` → `processed_at`) tiene mediana 0 s en todas las empresas. El percentil 95 de Jakilu (121 s) y los máximos de ~130 s en todas son **la espera de diseño de hasta 2 minutos** de los avisos de estado que llegan antes que su mensaje (`STATUS_WAIT_MS`), no mensajes de clientes.
- La entrada del webhook de QR admite 1 200 avisos por minuto por IP y ruta: no es un límite que Jakilu pueda alcanzar.

### 3.4 Hipótesis del prompt

| Hipótesis | Resultado | Evidencia |
|---|---|---|
| 0. Entrante con `@lid` sin teléfono, descartado | **Descartada** | 2 996 avisos `messages.upsert` en 7 días: **todos** con `remoteJid` de teléfono (`@s.whatsapp.net`) y con teléfono alternativo; ninguno `@lid`, grupo ni estado. 99 % de los entrantes terminó en un mensaje guardado (1 216 de 1 230; Jakilu 257 de 262; SICP 460 de 467; Pasiel 471 de 473; Growth 28 de 28). |
| a. Mensajes desde el teléfono ignorados (`fromMe`) | **Descartada** | v9 desplegado: Jakilu tiene 151 mensajes «desde el teléfono» guardados (1 766 entre todas). Todos los `fromMe` terminaron en mensaje (100 %). |
| b. Aviso perdido por sesión caída | **Sin evidencia** | La sesión de Jakilu estuvo `open` sin caída registrada; el latido responde cada 60 s. (La de «Pasiel» y «EMAUS STORE» con sesiones `closed` desde hace ~7 días son otras conexiones sin tráfico.) |
| c. Tarea `webhook-events` atrasada | **Descartada** | 0 avisos pendientes o fallidos; procesamiento con mediana 0 s. |
| d. Meta oficial | No aplica a Jakilu | Growth Consulting por Meta: 6 s de mediana (la tarea de 5 s). |
| e. Visibilidad (sin asignar/otro dueño) | **No verificada** | Requiere preguntar a una persona de Jakilu; los datos muestran que los mensajes sí están en la base. |
| f. GoHighLevel | No aplica a Jakilu | |

Hay entre 0 y 7 avisos entrantes por empresa (≤ 2 %; 14 de 1 230 en total) que **no terminaron en mensaje** y no sé por qué (probable: duplicados, tipos no soportados o respuestas a un mensaje que no tenemos); lo registro como pendiente de explicar, no como causa.

## 4. Qué falta para cerrar la causa en Jakilu (necesita acceso fuera de la base)

El retraso ocurre entre «el mensaje existe en WhatsApp» y «Evolution nos manda el aviso». Hay que mirar, en este orden:
1. **Registros de la instancia de Jakilu en el servidor de Evolution** (¿cola de webhooks acumulada, errores al llamar nuestra dirección, reinicios, el 13/11 entre las 13:00 y las 14:00?).
2. **El teléfono de la cuenta** (¿sin internet o con ahorro de batería, WhatsApp Business en otro aparato, dispositivos vinculados al límite?). Un teléfono que no sincroniza deja los mensajes «dormidos» y los entrega después.
3. **Comparar con la fuente:** pedir a Evolution (`/chat/findMessages`) los últimos mensajes de la instancia y ver si la hora del más reciente que **Evolution ya tiene** es de hoy (la cola está en el envío del aviso) o de hace 30 h (la cola está en WhatsApp/Baileys).
4. Si el responsable lo autoriza, **reiniciar la instancia** de Jakilu (o desvincular y volver a escanear el QR) y medir si el retraso vuelve a cero, como el día 13/11.

## 5. «En todas las empresas no se ven en tiempo real»: lo que encontré en el tramo servidor → pantalla

Los datos del servidor no confirman un retraso general (§3.1), así que lo que la persona ve tarde en otras empresas, si ocurre, pasa **después** de guardarse. Dos debilidades reales, ninguna medida todavía:
1. **El aviso en vivo sale 250 ms después de empezar a guardar, no después de confirmar.** `RealtimeService.touch` se llama dentro de la transacción del mensaje (`ingestInbound`) y avisa a los 250 ms. Los avisos del webhook se procesan en lotes de hasta 20 dentro de UNA transacción (cada aviso en su `SAVEPOINT`): en una ráfaga (Pasiel recibió 3 752 avisos en 7 días) el primer aviso sale antes de que el lote se confirme, la pantalla vuelve a pedir el mensaje, no lo encuentra y **no vuelve a mirar hasta 30–60 s después** porque, con el tiempo real «en vivo», las consultas de respaldo son lentas (30 s el hilo, 60 s la lista). En mensajes sueltos la transacción es corta (≈8 ms hasta guardar la conversación, en una muestra pequeña de 22 mensajes), así que el problema aparece sobre todo en ráfagas.
2. **Con Meta oficial** el aviso se procesa en la tarea de 5 s (no al instante, como el QR): +0–5 s.

No pude medir el lado del navegador (si el socket está «en vivo», si llegan los avisos). Propongo medirlo (B2 abajo).

## 6. Propuesta de la Fase B (a aprobar; una rebanada por PR)

Reordenada según lo que mostraron los datos. Lo del `@lid` (prioridad 1 del prompt) **no hace falta ahora**: no hay mensajes perdidos por esa causa; sí dejo el conteo de ignorados por motivo como parte de B1.

| | Rebanada | Para qué | Tamaño |
|---|---|---|---|
| **B1** | **Salud de la conexión** (Configuración › Conexiones): retraso medio y máximo de las últimas 24 h (`sent_at` → entrada), último aviso recibido, avisos pendientes/fallidos con «Reintentar» y su motivo, ignorados por motivo, y **alerta al administrador** cuando una conexión abierta pasa de 5 minutos de retraso mediano o N horas sin avisos. | Es **exactamente** la medida que habría mostrado lo de Jakilu hace 4 días. Se calcula con lo que ya se guarda; sin migración o con una mínima. | Mediana |
| **B2** | **Tiempo real después de confirmar** la transacción (el aviso sale al confirmar, no a los 250 ms) y consultas de respaldo más cortas (15 s) mientras haya mensajes recientes; más una **medición** en el navegador del tiempo entre el aviso y que el mensaje aparece. | Quita la carrera de §5.1 y deja datos del lado de la pantalla. | Pequeña |
| **B3** | **Recuperación en QR (`catch-up`)** con `findMessages` de Evolution al volver la sesión a `open` y cada 10 min, por el mismo camino idempotente. ADR nuevo. **Solo si el punto 3 de §4 muestra que Evolution ya tiene los mensajes** mientras el aviso va atrasado; si la cola está en WhatsApp, no ayuda. | Recuperar sin esperar el aviso. | Mediana |
| **B4** | **Observabilidad**: registro con el retraso de cada mensaje (sin teléfonos ni textos), y alerta cuando la tarea `webhook-events` pase de 60 s o haya fallidos. | Que la próxima vez no lo descubra un cliente. | Pequeña |
| B5 | Meta oficial: comprobación de la suscripción en «Probar conexión» y procesamiento inmediato como en QR. | Quita los 0–5 s. | Pequeña |

**Recomendación:** B1 y B2 ya (juntos o en ese orden), B4 con B1, B3 solo tras la comprobación de §4, B5 cuando se quiera.

## 7. Lo que necesito del responsable
1. ¿Apruebas B1 + B2 (+ B4) con las recomendaciones?
2. ¿Autorizas reiniciar o volver a vincular la instancia de Jakilu para probar si el retraso vuelve a cero (afecta a ese cliente unos minutos), y quién revisa los registros de Evolution (§4.1–4.3)?
3. ¿Dónde está alojado el servidor de Evolution y puedo leer sus registros, o los revisa otra persona?
