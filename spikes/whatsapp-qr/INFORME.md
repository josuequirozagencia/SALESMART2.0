# Informe del spike de WhatsApp QR (Evolution API) — ADR-31

Fecha: 2026-10-27 · Entorno: Railway (proyecto de pruebas), Evolution **v2.3.7** (`evoapicloud/evolution-api`), Postgres + Redis, receptor de webhooks propio · Chip: un número desechable con WhatsApp Business.
**Estado: parcial.** Faltan B3 (reiniciar Redis/Postgres), B4 (teléfono apagado 24 h), A9 (grupos) y A8 (duplicados). Lo demás está probado con eventos reales.

## Hallazgos que cambian el diseño
1. **La imagen que citaba el kit ya no existe.** `atendai/evolution-api:v2.1.1` desapareció de Docker Hub (el proyecto pasó a `evoapicloud/evolution-api`); el despliegue falla **sin ningún log**. Fijar una versión nueva y verificar que la imagen exista antes de depender de ella.
2. **Las claves viajan en cada evento.** Evolution incluye `apikey` (de la instancia) y `destination` (la dirección del webhook **con su token**) en el cuerpo de **todos** los eventos. Nuestro receptor debe ignorarlos y **jamás** registrarlos. (Se mostraron una vez en una salida del spike; hay que rotarlas.)
3. **Los archivos llegan dentro del webhook** (`message.base64`): imagen, audio, documento y sticker (un sticker animado ≈ 390 KB → ≈ 520 KB en base64). El endpoint necesita un límite de cuerpo generoso (≥ 25 MB) y guardar el archivo en nuestro almacenamiento al recibirlo, sin pedir nada más a Evolution.
4. **Identificadores `@lid`.** Los mensajes entrantes 1:1 traen `key.remoteJid` (teléfono) y `remoteJidAlt`; pero los eventos de estado (`messages.update`) y las reacciones traen un `@lid` (a veces con sufijo de dispositivo, `…:50@lid`). **Correlacionar siempre por el id del mensaje**, nunca por el número.
5. **Estados fuera de orden.** Se observó `DELIVERY_ACK` y 12 s después `SERVER_ACK`. Un estado nunca debe retroceder (igual que con Meta). Los mensajes entrantes reciben `READ` en bloque cuando el chip abre el chat.
6. **Sin reintentos del webhook.** Los eventos que llegan mientras el receptor está caído (se redesplegó) **se pierden** (B5: confirmado). El receptor debe responder 200 al instante y encolar; y hace falta una conciliación para los huecos (p. ej. consultar los mensajes recientes de la instancia tras una caída).
7. **Los grupos llegan por el mismo webhook** (`@g.us`). Hasta construir grupos (ADR-32) hay que **descartarlos** (o activar `groupsIgnore`).
8. **Reconexiones espontáneas.** Se vio `connecting` → `open` sin intervención. Un `connecting` no es una caída.
9. **Un QR sin escanear se agota** (≈ 6 renovaciones): evento `qrcode.updated` con «QR code limit reached» y estado `refused` (428). Hay que pedir uno nuevo; el QR dura ≈ 30 s.
10. **Cerrar sesión desde el teléfono** produce `connection.update` con `state: close` y **`statusReason: 401`**: es la señal de «sesión caída, escanear de nuevo». Con la instancia desvinculada, `restart` responde error genérico.

## Resultados del checklist
| # | Resultado |
|---|---|
| A1 | OK. `connecting` → `open`; evento `connection.update` con el número (`wuid`) y el nombre de perfil. |
| A2 | OK. `send.message` (`PENDING`) y luego `messages.update` (`SERVER_ACK`). |
| A3 | OK. `messages.upsert` con id, remitente, `pushName` y `message.conversation`. |
| A4 | OK (imagen por URL con leyenda): `send.message` con `imageMessage`. |
| A5 | OK. Imagen, audio (`ptt`, opus, segundos), documento (nombre, mimetype, páginas) y sticker llegan **con el archivo en base64**. |
| A6 | Reacción OK (mensaje `reactionMessage` aparte, con el id del mensaje y el emoji). **Cita no verificada** (se respondió sin citar). |
| A7 | OK: `SERVER_ACK`, `DELIVERY_ACK`, `READ`, fuera de orden. |
| A8, A9 | No probados. |
| B1 | **OK.** Tras redesplegar Evolution volvió a `open` en ≈ 40 s **sin QR nuevo** (volumen persistente en `/evolution/instances`). |
| B2 | **OK.** `restart` → `connecting` → `open` en ≈ 10 s, solo. |
| B3, B4 | **Pendientes** (reiniciar Redis/Postgres no se ejecutó; teléfono apagado 24 h tampoco). |
| B5 | **Se pierden eventos** mientras el receptor está caído; no hay reintento. |
| B6 | ≈ **5–6 s** de punta a punta (envío por la API + evento en el receptor), 10 muestras entre 5,4 y 6,3 s (medida gruesa: incluye el arranque del cliente y un desfase de reloj de 3 h entre Evolution y el receptor, ya corregido). |
| C1 | OK (ver hallazgo 10). |
| C2 | OK. Sin `apikey`: 401. (La raíz pública responde con la versión y el enlace al gestor.) |

## Recomendación para `EvolutionProvider` (M9.6)
- **Eventos a escuchar:** `connection.update`, `qrcode.updated`, `messages.upsert`, `messages.update`, `send.message`. Ignorar grupos (`@g.us`) y las reacciones se tratan como en Meta (no son mensajes nuevos).
- **Mapeo a `NormalizedMessage`:** id = `key.id`; remitente = `remoteJid`/`remoteJidAlt` solo si termina en `@s.whatsapp.net`; texto = `conversation` o `extendedTextMessage.text`; medios = `message.base64` + mimetype (+ nombre, segundos, páginas); ignorar los mensajes con `fromMe: true` que no sean del propio sistema.
- **Webhook propio:** identificador opaco por conexión (como Meta/GHL), token en tiempo constante, cuerpo crudo de hasta 25 MB, 200 inmediato, descarte de `apikey`/`destination` antes de guardar, idempotencia por `(canal, key.id)`, y **estados que no retroceden**.
- **Salud de sesión:** `close` con 401 ⇒ conexión «Desconectada», alerta y salientes **en cola** (no se reenvían por otra vía); `connecting` no alerta; latido que consulte `connectionState` periódicamente (por los eventos perdidos).
- **Despliegue:** volumen persistente obligatorio; versión fijada con la imagen verificada; `apikey` global solo del servidor; el gestor público (`/manager`) debe quedar cerrado (o detrás de la red privada).
- **Riesgo de producto:** sigue siendo no oficial; el aviso de riesgo, el calentamiento y los límites de envío del plan M9.6 se mantienen.

## Para terminar el spike
B3 (reiniciar Redis y Postgres y verificar sesión y mensajes), B4 (teléfono apagado), A8 y A9. Después, **borrar el proyecto de pruebas o rotar** la `apikey` global y el token del webhook.
