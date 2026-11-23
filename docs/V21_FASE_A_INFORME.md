# V21 · Fase A — Verificación previa (biblioteca de archivos y adjuntos en automatizaciones)

> Fecha: 2026-11-23. Solo lectura del código de `main` (`57dbf65`, con las migraciones hasta `0153`). Prompt: `SALES_SMART_2.0_PROMPT_CODE_V21_BIBLIOTECA_Y_ADJUNTOS_AUTOMATIZACIONES.md`.

## 1. El estado coincide con la tabla del prompt (una corrección)

| Pieza | Verificado |
|---|---|
| `message_attachments` (un mensaje, un adjunto; clave `org/<org>/attachments/<uuid>`; URL firmada de 5 min; sin DELETE) | Coincide. Ligado a una conversación; los no enviados vencen a las 24 h. |
| `StorageGateway`/`StorageAdapter` S3-compatible (R2 recomendado) | Coincide. `scanAndStore(org, id, file, folder?)` ya acepta una **carpeta propia** (`org/<empresa>/<carpeta>/<id>`): los seguimientos del agente (v15) la usan. La biblioteca usará `library`. |
| `attachment-rules.ts` (tipos por contenido, tamaños 5/16/16/25 MB, `safeFilename`, `storageKey`) | Coincide; reutilizable tal cual. |
| `VirusScanner` / `AudioTranscoder` con proveedor `none` en el piloto | Coincide (`skipped` con aviso). |
| Envío desde el chat (`POST /v1/conversations/:id/attachments` + `POST …/media`) | Coincide; oficial y QR. |
| Acción `send_text` (`automation-model.ts`: solo `text`, 1–1000) | Coincide; **sin adjunto**. |
| `OutreachService.textTarget/sendText` | Coincide; elige la conversación abierta, ventana de 24 h (sin ventana en GHL y QR), consentimiento revocado; **solo texto**. |
| Prueba en seco (`automation-dry-run.service.ts`) | Coincide; llama a `textTarget(…, false)`. |
| Biblioteca (tablas, API, pantalla) | No existe. |
| **Corrección:** la última migración en `main` es la **`0153`** (el prompt decía `0151`; `0152` y `0153` ya se fusionaron el 2026-11-23). La biblioteca usará la **`0154`**. | |

## 2. Respuestas a las preguntas de la Fase A

1. **Borrado de adjuntos vencidos.** `InboundMediaService.expireOrphans` solo marca `expired` y borra del almacenamiento las filas de `message_attachments` con `direction = 'out' AND message_id IS NULL AND state = 'ready'` de más de 24 h, **por su `storage_key`**. Nada recorre prefijos del almacenamiento ni toca otras tablas. La biblioteca vivirá en otra tabla (`media_assets`) y otra clave (`org/<empresa>/library/<uuid>`): **no puede ser borrada por ese ciclo**. Con la regla «copiar al enviar» el adjunto del mensaje es un objeto propio y borrarlo (o que venza) no afecta al archivo de la biblioteca. Único borrado masivo por prefijo: `company-purge` (eliminación definitiva de una empresa), que ya borra `org/<id>/…` entero y **cubre sola** la carpeta `library/`; la exportación «Descargar todo» (F3b) recorre las tablas del catálogo y exige un manifiesto: **`media_assets` y `media_folders` hay que agregarlos al manifiesto y sus archivos a la carpeta `archivos/`**.
2. **Camino de envío de un adjunto.** `OutboundService.sendMedia(access, conversationId, { attachment_id, caption })` valida dueño, ventana y canal, y deja el mensaje `queued`; la tarea de salida lo envía (oficial: `WhatsAppProvider.sendMedia` con los bytes; QR: `QrOutboundService`). La idempotencia hoy es «un adjunto = un mensaje» (`message_attachments.message_id`). **Las automatizaciones no pasan por ahí:** corren dentro de la transacción de la ejecución (SAVEPOINT por acción, 3 intentos con la transacción entera revertida) y escriben el mensaje con `OutreachService.queue`. Como el mensaje y su adjunto se escriben en la misma transacción, un reintento no los duplica; **lo que no se revierte es el objeto copiado en el almacenamiento** (se hace fuera de la base). Solución propuesta: la copia usa una **clave determinista por ejecución y paso** (UUID derivado de `runId:paso`), así un reintento sobrescribe el mismo objeto y no deja huérfanos.
3. **Permisos y menú.** No existe ningún permiso `library.*` ni sección «Biblioteca»/«Contenido». El menú sale de `features/app/navGroups.ts`: el grupo **«Comunicación»** (hoy «Campañas masivas») es el lugar natural; la sección es visible para quien tenga `library.read`. Los permisos nuevos siguen el patrón de las campañas (`rbac/catalog.ts` + `permission-groups.ts` + migración con `permissions`/`role_permissions`).
4. **Cuota.** No existe; la plataforma ya guarda por empresa valores que solo el Súper Admin cambia (`ai_org_pricing`, límites). El uso se deriva de `media_assets` (suma de `ready`), nunca es un campo.
5. **Reutilización.** El patrón de V15 (`agent_follow_up_files`: subida por cuerpo crudo, tipo por contenido, antivirus, copia al enviar a un adjunto propio y vuelta a revisar) es el modelo a seguir; la biblioteca lo generaliza con carpetas, cuota y usos.

## 3. Decisiones de diseño ya cerradas por el responsable (2026-11-23)
Cuota **1 GB** por empresa (un tope, no un espacio reservado; editable por el Súper Admin) · solo el **administrador** sube · **un nivel** de carpetas · antivirus obligatorio antes de usarla con varios clientes (`REQUIRE_VIRUS_SCAN=1`) · **copiar** al enviar · entra después de cerrar V20 (cerrado el 2026-11-23). Pesos por archivo: imagen 5 MB, audio 16 MB, video 16 MB, documento 25 MB.

## 4. Lo que NO se pudo verificar
Cloudflare R2 real con la biblioteca · ClamAV real · envío por Evolution real de documentos, audios y videos (el spike solo envió una imagen por URL) · notas de voz `webm`/`ogg` contra Meta · rendimiento con muchos archivos.

## 5. Plan de entrega (un hito a la vez)
1. **V21.1** — ADR-75, migración `0154` y API de la biblioteca (con pruebas A↔B).
2. **V21.2** — pantalla «Biblioteca», botón «Biblioteca» del chat y la cuota en la Consola.
3. **V21.3** — adjuntos en la acción «Escribir mensaje» de las automatizaciones (editor, validación, prueba en seco, envío).
4. **V21b** — planes de espacio extra (después de fusionar V21).
