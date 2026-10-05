# SALES SMART 2.0 — LECTURA PROFUNDA DE ChatIA (2026-10-02)

Fuente: `josuequirozagencia/sales-smart` (solo lectura). Tres lecturas independientes: Inbox, motor de flujos, y Conversions API / Campañas / Reportes. **[V]** = verificado leyendo el código; **[I]** = inferido. No se leyó línea a línea: `wbotMessageListener.ts` tramos 1184-1348 y 2881-3022, `ReceivedWhatsApp` (verifyQueueOficial), `wbotClosedTickets` (parte), `docs/META_CONVERSIONS_API.md`, `RelatorioVendas` ni el detalle del frontend de Campañas.

## 1. Cómo funciona hoy el Inbox (reglas reales)

- **El ticket es por contacto + conexión**, no por contacto. Un entrante en un ticket cerrado lo pasa a `pending`. Con `timeCreateNewTicket` ≠ 0 se reabre el ticket cerrado dentro de N minutos conservando asesor y cola. [V]
- **Nada abre un ticket automáticamente**: solo el asesor al aceptar. El estado inicial es `pending` (o `lgpd`, o `group`). [V]
- **Precedencia real de quién responde primero**: agente IA > fuera de horario > modo IA / flujo detenido > OpenAI legacy > integración (Typebot/Dialogflow) > campañas por frase > flujo de bienvenida > menú de colas. Está implícita en una cadena de `if`; no está declarada en ningún sitio. [V]
- **Cartera** (`DirectTicketsToWallets`): solo se aplica al crear el ticket; lo deja `pending` con el dueño. Un contacto tiene una sola cartera. [V]
- **Horarios**: tres tipos (empresa, conexión, cola), con zona `America/Sao_Paulo` escrita a mano. [V]
- **Cierre**: manual, por inactividad, o por NPS (nota 0–10). Al finalizar con venta se crea una `Sale` una sola vez. [V]
- **Llamadas**: no se rechazan; solo se registra un mensaje «perdida a las HH:mm» con hora del servidor. [V]

## 2. Reparto de leads real (importante para tu decisión de moverlo a la cola)

- Solo en colas con router activo; un cron cada 2 min toma tickets `pending` de esa cola. [V]
- Modo «ORDENADO» = round robin **ponderado suave** (estilo nginx) con créditos persistidos; candidatos: de la cola, perfil usuario, **en línea**, **dentro de horario laboral** y peso > 0. Peso 0 = pausa. [V]
- Cualquier otro modo = aleatorio entre todos los de la cola, **sin filtrar** online ni horario. [V]
- Si el asesor no responde en `tempoRoteador`, rota a otro con UPDATE condicional atómico; **máximo 2 rotaciones**, luego etiqueta «Sin respuesta». [V]
- No considera carga ni capacidad. El peso (`distributionWeight`) vive en el **usuario**, no en la cola. [V]
- Fallo: un ticket asignado por cartera puede ser rotado a otro asesor si la cola tiene router. [V]

**Conclusión:** tu decisión (reparto configurado por cola/departamento) corrige un defecto real de ChatIA. En 2.0: pesos y miembros por cola, y la cartera respetada por el router.

## 3. Motor de flujos

- El backend ejecuta **15 tipos de nodo**; el lienzo registra **19**. Intervalo, imagen, audio y video sueltos son no-ops silenciosos: solo funcionan dentro de «bloque único». Typebot, N8N y Dialogflow **no son nodos**: son integraciones por conexión o cola. [V]
- Estado del flujo en columnas del ticket (`lastFlowId`, `flowStopped`, `dataWebhook`); **variables en `global.flowVariables`**, en memoria del proceso, compartidas entre tickets y empresas. Las esperas son `setTimeout` en línea. [V]
- `motor.ts` / `ConfigPackageService` **no es licencias ni DRM**: es el motor de **clonado y snapshots de configuración** entre empresas (12 módulos, ids nuevos, saneado de secretos al capturar). Es buen diseño. No clona los flujos. [V]
- Otras integraciones: HTTP request sin allowlist; claves de IA en claro dentro del JSON del flujo; Dialogflow loguea el JSON de la cuenta de servicio. [V]

## 4. Conversions API, campañas, reportes

- **Conversions API es el módulo más sólido**: `event_id` determinista, índice único `(empresa, event_id)`, dos rutas (CTWA con ventana de 7 días / estándar con hash SHA-256), 5 reintentos con backoff, estados `pending/sent/skipped/blocked/failed/expired`, token cifrado AES-256-GCM. **Solo hay atribución a anuncio en WhatsApp oficial**: el canal QR nunca tendrá `ctwa_clid`. [V]
- **Campañas**: solo envían por Baileys (no oficial). El horario y los días hábiles se guardan pero **no se aplican**; no hay límite diario, calentamiento, opt-out ni estado por destinatario; un fallo se traga. «Campaña por etiqueta» es un campo muerto. Riesgo alto de bloqueo del número. [V]
- **Tiempo de respuesta**: mediana, promedio y máximo desde el primer mensaje del cliente hasta la primera respuesta; excluye notas y bot (por carácter invisible). Sin SLA, sin horario laboral, sin feriados; un ticket reabierto cuenta varias veces. «Tiempo real» es solo una lista por asesor, sin cronómetros. [V]
- **Cumpleaños**: dos crons que pueden enviar el mensaje duplicado; sin bitácora de envíos. **Recordatorios**: ventana de 30 s; un tick retrasado deja el aviso pendiente para siempre [I]. [V]
- **API de mensajes**: el token es el de la conexión, en texto plano, sin caducidad ni rate limit; los tokens pueden repetirse entre canales. [V]

## 5. Hallazgos de seguridad añadidos (se suman a B1–B14 de la Entrega 1)

| # | Hallazgo | Gravedad |
|---|---|---|
| B15 | `GET /dashboard/ticketsUsers` y `/ticketsDay` **sin autenticación** y con SQL inyectable (`companyId`, fechas en la consulta) | Crítico |
| B16 | SQL inyectable autenticado en `ListTicketsServiceReport` y `GetMessageRangeService` | Crítico |
| B17 | IDOR de campañas y listas de contactos (`findByPk(id)` sin empresa); `whatsappId` del cuerpo permite enviar por la conexión de otra empresa | Crítico |
| B18 | IDOR al borrar y duplicar flujos | Alto |
| B19 | Path traversal en medios de «bloque único» (lee archivos del servidor y los envía por WhatsApp) y en nombres de documento entrantes | Alto |
| B20 | SSRF en nodo HTTP request y posible SSRF en el parámetro `url` de la API de mensajes | Alto |
| B21 | Variables de flujo globales compartidas entre empresas | Alto |
| B22 | Conteo de «leads» del dashboard cuenta todas las empresas; ajustes de cumpleaños aceptan `companyId` del cuerpo | Medio |
| B23 | `/public` sirve los archivos de todas las empresas sin autenticación | Alto |
| B24 | Claves de IA y cabeceras con tokens en claro dentro del JSON del flujo | Alto |

## 6. Decisiones de diseño para Sales Smart 2.0

**RECUPERAR (reglas, no código)**
1. Conversions API completa (módulo de atribución), añadiendo Lead por cada nuevo clic y claves de cifrado por organización.
2. Round robin ponderado suave con créditos persistidos, filtro online + horario, peso 0 = pausa, rotación atómica y límite de rotaciones, ahora **por cola**.
3. «Nada abre solo; el asesor acepta», `routerAssign` como evento propio.
4. Definición única de «respuesta humana» (no automática, no nota) compartida por reparto, IA y reportes.
5. Clonado/snapshots de configuración con saneado de secretos.
6. Webhook GHL con secreto en tiempo constante, 200 inmediato y proceso asíncrono.
7. Recordatorios ligados a la cita (máx. 3, cancelación en cascada).

**REDISEÑAR**
1. Pipeline de entrada como **cadena de handlers con orden declarado y testeable**; los canales entregan un `NormalizedMessage` al mismo pipeline (hoy cada canal se salta reglas).
2. Ejecución de flujos como **máquina de estados persistida** (`flow_runs`), un paso = un job con lock por conversación; esperas como jobs diferidos; variables con ámbito (run/contacto/org).
3. Conexiones y secretos por organización cifrados y referenciados por id; HTTP con allowlist, bloqueo de IP privadas y límite de tamaño.
4. Un solo servicio de horarios con zona por organización.
5. Creación de conversación idempotente (restricción única parcial + advisory lock).
6. Campañas: oficial con plantillas, o QR con límites explícitos (diario, por minuto, calentamiento, ventana horaria real, opt-out, validación previa, estado por destinatario, reintentos).
7. SLA con horario laboral y feriados, atribuido a quien respondió, con `sender_type` (humano/IA/campaña/automático) en vez de caracteres invisibles.
8. Archivos por id de asset, URLs firmadas y validación MIME; nunca por nombre de ruta.
9. Tiempo real con cronómetros de espera por conversación.

**DESCARTAR**
`global.flowVariables`, estado del flujo en el ticket, `intervalWhats` en línea, mutex por llamada, `ORDER BY random()`, cooldown por `getMinutes()`, OpenAI legacy y transferencia por frase mágica, `static /public`, zona Sao Paulo fija, LGPD como estado de ticket (será consentimiento en el contacto), `FlowCampaign` como «campaña», `tagListId`, `ScheduledMessages`, jobs de cumpleaños duplicados, Typebot/Dialogflow como integraciones de primera clase.

## 7. Cambios al inventario funcional

Pasan a certeza **Alta**: #13 Agendamientos, #14 Campañas, #23 Reportes/Tiempo real, #29 Cumpleaños, #30 API de mensajes. Campañas sigue diferido, pero con requisitos reales definidos (sección 6). El Flow Builder queda con 15 nodos reales, no 24.

## 8. Lo que sigue sin leerse
`wbotMessageListener.ts` 1184-1348 y 2881-3022, `verifyQueueOficial`, `wbotClosedTickets` (resto), `docs/META_CONVERSIONS_API.md`, `RelatorioVendas` y el frontend de Campañas. Ninguno cambia la arquitectura; sí pueden aportar reglas finas.
