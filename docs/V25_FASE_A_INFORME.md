# V25 — Fase A: informe de hallazgos (sin código)

> Fecha: 2026-11-27 · Base revisada: `main` en `10e4f71` (V24 fusionada; migración `0158`). Solo lectura del repositorio; no se consultó staging ni se cambió código.

## 1. Resumen: lo que choca con el prompt

| # | Hallazgo | Propuesta | ¿Necesita tu decisión? |
|---|---|---|---|
| H1 | **Hoy nadie puede cambiar el nombre de una empresa**, tampoco el Súper Admin: no existe ninguna ruta que actualice `organizations.name` (ni zona horaria ni país después del alta). No hay «camino que conservar». | El Súper Admin edita entrando a la empresa («Soporte»), que ya le da los permisos del administrador. Sin ruta nueva en la Consola. | Sí |
| H2 | **La auditoría no puede ir «en la misma transacción»** que el cambio de nombre, zona o país: `organizations` es tabla de identidad (solo `app_identity`) y `audit_logs` solo la escribe `app_rw` (ADR-25). | Dos transacciones, como hace hoy el cambio de moneda: identidad y después auditoría. Documentar la ventana. | Sí |
| H3 | **Prueba vencida no es «solo lectura» para los miembros**: el administrador del cliente queda **en pausa** (el servidor bloquea sus rutas de empresa). «Solo lectura» aplica a agencia y soporte. | Respetar la regla actual (en pausa). | Sí |
| H4 | **`{{empresa}}` no existe en automatizaciones ni en seguimientos.** Solo en respuestas rápidas y en las instrucciones de los agentes. | Probar esos dos casos; **no** añadir la variable. | No |
| H5 | **Se necesitan 3 migraciones, no 2**: «Mi perfil» exige ampliar la restricción de `member_history`. | `0159` empresa · `0160` perfil de usuario · `0161` adjuntos. | Sí |
| H6 | **La `Idempotency-Key` del envío con adjuntos no tiene dónde guardarse**: `messages` no tiene llave de idempotencia. | Tabla `quick_reply_sends` dentro de la `0161`. | No |
| H7 | **«Todo en una transacción» no puede incluir la copia de los archivos** (es almacenamiento externo). | Copiar antes; guardar los mensajes en una sola transacción; borrar las copias si falla. | No |
| H8 | **La foto no está disponible para todos**: `/v1/me/photo` exige `inbox.read` y ser miembro de la empresa; el Súper Admin y el personal de agencia que actúa en un cliente no pueden. | En «Mi perfil», mostrar la foto solo a quien puede usarla. | No |

## 2. Rebanada 25.1 — Perfil de empresa

### 2.1 País: para qué se usa
`organizations.country` se **guarda y se muestra** en las listas de la Consola y de la agencia; **nada más lo lee**. La normalización de teléfonos de la web usa el prefijo que la persona elige en cada formulario, no el país de la empresa; ni plantillas, ni formularios, ni envíos dependen de él.
- Las empresas que se registran solas **no tienen país** (y su zona horaria es la que envió el navegador, o `UTC`).
- Consecuencia: el aviso «solo afecta a lo que se cree desde ahora» sería engañoso. Propongo el texto «Dato informativo de la empresa» y permitir dejarlo vacío mientras no se haya fijado.

### 2.2 Nombre: cachés y propagación
- El nombre **no se guarda en la sesión**: cada petición lo lee de la base, así que `GET /v1/auth/me`, los correos nuevos y `{{empresa}}` lo toman al instante. `OrgDirectoryService.organizationName()` **no** tiene caché.
- **La web sí lo retiene**: la sesión no tiene forma de volver a pedir «quién soy». Hay que añadir `refreshMe()` e invalidar las consultas de respuestas rápidas. Con eso cambian el menú, el banner «Administrando X» y el selector.
- **No se propaga** al calendario propio de Google («Sales Smart · <empresa>», se nombra al conectar) ni a registros históricos (por diseño).
- Eliminar una empresa pide escribir su nombre exacto: usará el nuevo.

### 2.3 `{{empresa}}`
| Lugar | ¿Existe? | Cuándo se resuelve |
|---|---|---|
| Respuestas rápidas | Sí | Al **abrir la lista** en la conversación (no al enviar; lo que se envía es el texto del cuadro) |
| Instrucciones de agentes | Sí | En cada turno del agente |
| Automatizaciones | **No** (solo `nombre`, `primer_nombre`) | — |
| Seguimientos | **No** (solo `primer_nombre`, `nombre`, `mi_nombre`) | — |

### 2.4 Zona horaria
- Validación: `isValidTimezone` (ya usada en altas e invitaciones). Sirve tal cual.
- `OrgDirectoryService.current()` guarda la zona **30 s** por empresa; `invalidate()` ya existe. Con una sola instancia (Railway hoy), invalidar basta; con varias habría hasta 30 s de retraso.
- **Efectos reales** (el texto de confirmación debe decir esto):
  - Cambia desde ahora: horario laboral, horarios por persona, feriados, tope diario de reparto, periodos de Analítica, cómo se muestran las fechas y los cronómetros **nuevos**.
  - **No se mueve:** los recordatorios de citas ya calculados (se guardan como instante), los cronómetros abiertos (conservan su vencimiento) y los mensajes o campañas ya programados.
  - El prompt dice que cambia «los recordatorios de citas»: **solo los de las citas que se creen o reprogramen después**.

### 2.5 Moneda
Se cambia hoy con `PUT /v1/sales/settings` (`sales.manage`) mientras no exista **ninguna** venta (tampoco anuladas). `currency_locked` puede reutilizar esa misma regla.

### 2.6 Permisos y auditoría
- La agencia nivel `admin` y el Súper Admin en «Soporte» reciben los permisos del administrador del cliente: `organization.manage` les llega sin código extra. `read` y `advisor` quedan fuera.
- «Cualquier miembro puede ver» no encaja con las reglas actuales: toda ruta de empresa exige un permiso. Propongo **dos**: `organization.read` (administrador y asesor; entra en solo lectura) y `organization.manage` (administrador; no concedible a un asesor). Así la agencia `read`, la empresa en solo lectura y «Ver como» pueden consultar. La pestaña «Empresa» se muestra a quien puede editar y, en solo lectura, a la agencia, el soporte o «Ver como» cuando miran como administrador.
- Un `PATCH` que mezcle campos de identidad (nombre, país, zona) y de la tabla nueva usa dos transacciones: puede quedar a medias si falla la segunda. La pantalla guarda **por bloque**, así que no mezcla; se documenta para la API.
- `organization_profiles` debe pasar la prueba de «Descargar todo» (las tablas se descubren solas del catálogo; hay que verificar que ninguna columna quede excluida por su nombre) y la del borrado definitivo.

## 3. Rebanada 25.2 — «Mi perfil»

### 3.1 Para qué se usa `users.phone`
| Uso | Detalle |
|---|---|
| Registro propio e invitación | Obligatorio («tu WhatsApp») |
| Consola › Pruebas | El Súper Admin lo ve con un enlace `wa.me` para **escribir a mano** |
| Equipo › Usuarios | Lo ven quienes administran usuarios |

**Nada envía mensajes ni avisos automáticos a ese número.** No se cumple la condición para detenerse. Riesgo menor: al ser editable y sin verificar, el número de contacto del dueño puede quedar mal. Propongo permitir cambiarlo pero **no vaciarlo** si ya existe.

### 3.2 Aceptar invitación
- Cuenta **nueva**: ya exige nombre y WhatsApp.
- Cuenta **existente**: solo pide la contraseña, así que quien no tiene nombre sigue sin nombre.
- Propuesta: la consulta pública de la invitación devuelve `needs_name` cuando la cuenta existe y no tiene nombre; la pantalla muestra el campo y el servidor lo exige **después** de validar la contraseña. Las invitaciones ya emitidas siguen sirviendo (se calcula al abrirlas).

### 3.3 Identidad, auditoría y límites
- `member_history.kind` tiene una lista cerrada: hace falta la migración `0160` para el tipo `profile_updated` (H5).
- Hoy **no hay una pantalla que muestre el historial** de un miembro (la web solo usa el de restablecimientos de acceso). La fila quedaría guardada pero invisible; propongo no construir esa pantalla en V25.
- **Dónde se registra:** en las empresas donde la persona **es miembro** y está trabajando. Si quien cambia su nombre es el Súper Admin en la Consola, va a la auditoría de plataforma; si es personal de agencia o soporte dentro de un cliente, a su empresa de origen y no a la del cliente.
- Límite de intentos: el limitador por ventana en memoria (`WindowLimiter`) basta para esta ruta autenticada y evita ampliar la restricción de `signup_attempts`. Limitación: se reinicia con cada despliegue.
- Foto (H8): se reutiliza el componente de Apariencia; se oculta a quien no es miembro o no tiene `inbox.read`.
- «Horario»: no hay ruta para ver el horario **propio** (la de Equipo exige `users.manage`). Propongo incluirlo en `GET /v1/me/profile` (solo lectura).

## 4. Rebanada 25.3 — Adjuntos en respuestas rápidas

### 4.1 Cómo se envía hoy
- **Texto:** `POST /v1/conversations/:id/messages` → `OutboundService.reply`: guarda el mensaje `queued` en una transacción (permisos, ventana, conversación, SLA) y lo intenta al instante.
- **Archivo de la biblioteca:** `POST …/library/:assetId/send`: comprueba que se puede escribir, lee el archivo (con las reglas de visibilidad), lo **copia** a un adjunto propio (antivirus incluido) y llama a `sendMedia` en **otra** transacción. Un audio no lleva pie.
- **Orden:** los dos despachadores (oficial y QR) no sacan un mensaje mientras quede otro anterior `queued` en la conversación, comparando `(sent_at, id)`. Para varios mensajes hay que darles `sent_at` crecientes (+1 ms), como ya hacen los envíos automáticos.
- **QR:** sin ventana; el calentamiento y la pausa de 4 s viven en su despachador. **GoHighLevel:** los archivos se rechazan hoy con `GHL_TEXT_ONLY`.
- **Reutilizable:** `planParts` (seguimientos v15) ya resuelve «pie en el primero; si es audio, primero el audio y el texto aparte».

### 4.2 Propuesta del endpoint (confirma la tuya, con ajustes)
`POST /v1/conversations/:id/quick-replies/:replyId/send` (`inbox.reply` + `library.read`), `Idempotency-Key` obligatoria, cuerpo `{ text?: string, asset_ids?: uuid[] }`.

1. Si la llave ya se usó con la misma petición y persona, devuelve los mismos mensajes (200); con otros datos, 409.
2. Valida sin escribir: conversación (puede responder, ventana, canal; GHL con archivos ⇒ 409 `CHANNEL_NO_MEDIA`), respuesta visible para la persona, `asset_ids` subconjunto de los suyos, archivos vigentes, `usable_by_advisors` y antivirus, texto sin `{{…}}`.
3. Copia cada archivo a su adjunto propio, **fuera** de la transacción.
4. **Una** transacción: bloquea la conversación, **revalida**, guarda la llave y los mensajes en orden, mueve la conversación y detiene el SLA. Si falla, se borran las copias.
5. Intenta el envío del primero; los demás salen con la tarea de salida o encadenados.

Reglas que el prompt no define y propongo:
- **Texto de más de 1 024 caracteres con archivos** (el pie no lo admite): los archivos salen sin pie y el texto como mensaje aparte, **antes**.
- **Un archivo ya no disponible:** se rechaza **todo el envío** nombrándolo (409 `QUICK_REPLY_ASSET_UNAVAILABLE`), y la persona lo quita del chip y reenvía. Así «nunca se envía a medias sin avisar» se cumple de forma simple. El texto siempre se puede enviar quitando los archivos.
- **Sin archivos:** la web usa la ruta de texto de siempre (sin cambios de comportamiento).
- El código nuevo para GHL es `CHANNEL_NO_MEDIA`; las rutas actuales conservan `GHL_TEXT_ONLY`.

### 4.3 Datos y biblioteca
- `media_assets` y `quick_replies` ya tienen `UNIQUE (organization_id, id)`: las claves foráneas compuestas funcionan tal cual.
- **Máximo 3 sin trigger:** `CHECK (position BETWEEN 0 AND 2)` más único `(organization_id, quick_reply_id, position)` ya impiden un cuarto en la base.
- La tabla necesita `DELETE` para `app_rw`: hay que declararla como tabla de enlace en el catálogo de `db:audit`.
- Las respuestas rápidas se borran de forma **lógica**: los enlaces quedan; las consultas deben filtrar las borradas.
- **«Antivirus pendiente» no existe en la biblioteca**: un archivo está `clean` o `skipped` (sin revisar); los infectados no se guardan. La regla real es: con `REQUIRE_VIRUS_SCAN`, un `skipped` no se puede adjuntar ni enviar.
- `GET /v1/library/assets/:id/usage` devuelve hoy `{ automations }`: se **añaden** `quick_replies` (compartidas, por atajo) y `personal_quick_replies` (solo conteo). El contrato no se rompe.
- Una respuesta compartida cuyo archivo **deja de ser «para asesores»** después: el asesor la verá con ese archivo no disponible. Propongo mostrarlo en el chip y en la tabla.
- El nombre del archivo no se muestra en el chat (regla v6), pero el error de envío del prompt lo nombra («El archivo «x» ya no está disponible»). Propongo nombrarlo solo en Configuración y en el chat decir «Un archivo (imagen, 240 KB) ya no está disponible».

## 5. Migraciones propuestas

| Migración | `when` | Contenido |
|---|---|---|
| `0159` | `1797500000000` | `organization_profiles` (RLS forzada, sin DELETE), permisos `organization.read` y `organization.manage` |
| `0160` | `1797600000000` | Tipo `profile_updated` en `member_history` |
| `0161` | `1797700000000` | `quick_reply_assets` y `quick_reply_sends` (RLS forzada) |

Ninguna se aplica en staging sin tu OK. ADR-76 está libre.

## 6. Decisiones que necesito

| # | Pregunta | Recomendación |
|---|---|---|
| 1 | ¿El Súper Admin edita el perfil de una empresa entrando en «Soporte», sin ruta nueva en la Consola? (H1) | Sí |
| 2 | ¿Aceptas auditoría en una segunda transacción para nombre, país y zona horaria? (H2) | Sí |
| 3 | ¿La prueba vencida sigue dejando la cuenta del cliente en pausa? (H3) | Sí, no cambiarlo |
| 4 | ¿Dos permisos (`organization.read` y `organization.manage`)? (§2.6) | Sí |
| 5 | ¿Tres migraciones en lugar de dos? (H5) | Sí |
| 6 | ¿Si un archivo no está disponible se rechaza todo el envío y la persona lo quita? (§4.2) | Sí |
| 7 | ¿Texto largo con archivos: mensaje aparte antes de los archivos? (§4.2) | Sí |
| 8 | ¿Nombrar el archivo solo en Configuración, no en el chat? (§4.3) | Sí |
| 9 | ¿El teléfono se puede cambiar pero no vaciar? (§3.1) | Sí |

Las doce decisiones de la sección 4 del prompt se mantienen como están.

## 7. Sin verificar en esta fase
- Nada se probó en ejecución: son conclusiones de leer el código.
- No se consultaron datos de staging (por ejemplo, cuántas personas no tienen nombre o cuántas empresas no tienen país).
