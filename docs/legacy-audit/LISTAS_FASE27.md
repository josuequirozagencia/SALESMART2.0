# SALES SMART 2.0 — LISTAS RECUPERAR / REDISEÑAR / DESCARTAR / NUEVO (Fase 27, versión consolidada)

Fecha: 2026-10-03 · Reemplaza la sección 7 de la Entrega 1.

**Fuentes consolidadas:** Entrega 1 (B1–B14), Inventario funcional (34 módulos), Lectura profunda (B15–B24), ADR-01..18, prototipo v9 y los 21 flujos.

**Cómo leer las tablas**
- **Certeza:** *V* = verificado en código o documentos del repo; *I* = inferido por nombre de archivo o modelo; *D* = decisión tuya (no viene del repo).
- **Fase:** **MVP** = sin esto no hay producto; **V1** = primera versión vendible a clientes; **V2** = después de validar.
- Recuperar significa recuperar la **regla o el diseño**, nunca copiar código.

---

## 1. RECUPERAR (reglas, diseños y conocimiento)

| # | Qué | Origen | Cert. | Por qué se recupera | Destino en 2.0 | Fase |
|---|---|---|---|---|---|---|
| R1 | **Meta Conversions API completa**: `event_id` determinista, único por (organización, event_id), ruta CTWA (`ctwa_clid`, ventana 7 días) y ruta estándar con hash SHA-256, 5 reintentos con backoff, estados `pending/sent/skipped/blocked/failed/expired` | Inventario #21, Lectura §4 | V | Es el módulo más sólido del repo y el diferencial para una agencia de tráfico | Módulo de atribución sobre outbox + cola. Se añade: Lead por cada clic nuevo, clave de cifrado por organización, ventana de gracia del Purchase (ADR-18) | MVP |
| R2 | **Reparto ponderado suave** (estilo nginx) con créditos persistidos, filtro en línea + horario, peso 0 = pausa, rotación atómica, máx. 2 rotaciones | Lectura §2 | V | Es la mejor lógica de reparto del repo | `queue_members.weight`, reglas por cola (ADR-07); la cartera se respeta | MVP |
| R3 | **«Nada abre solo; el asesor acepta»** y `routerAssign` como evento propio | Lectura §1 | V | Regla de negocio de Inbox | Pipeline de entrada de conversaciones | MVP |
| R4 | **Definición única de «respuesta humana»** (no bot, no nota, no campaña) | Lectura §6 | V | Reparto, IA y SLA hoy no coinciden | `messages.sender_type` (humano / IA / campaña / automático) | MVP |
| R5 | **Reglas de GoHighLevel**: webhook con secreto en tiempo constante, 200 inmediato y proceso asíncrono, token cifrado que no vuelve a la UI, etiquetas bidireccionales | Entrega 1, Inventario #20 | V | Reglas probadas | `GHL Integration Layer` con Private Token (ADR-05) | MVP |
| R6 | **Agentes IA**: estado de IA separado de la asignación, prioridad humana (el mensaje del asesor pausa la IA), un agente por conexión, seguimientos hasta 5 pasos, chat de prueba, clave nunca devuelta | Inventario #17 | V (docs) | Diseño correcto | `ai_agents` + `ai_conversation_state` | V1 |
| R7 | **Ventas con cierre**: valor, depósito, método de pago, motivo de no venta, motivo de finalización | Inventario #1, #6 | V | Captura que el negocio ya usa | `sales`, `opportunities.lost_reason`, `conversations.close_reason` | MVP |
| R8 | **Recordatorios ligados a la cita**, cancelación en cascada | Lectura §6 | V | Regla correcta | Tope 3, o 5 por fuente QR/Messenger/Instagram (ADR-13) | MVP |
| R9 | **Clonado y snapshots de configuración** con saneado de secretos | Lectura §3 | V | Buen diseño; acelera el alta de clientes de la agencia | `organization_templates` | V1 |
| R10 | **Plantillas de WhatsApp oficial** | Inventario #11 | V | Obligatorias para el canal oficial | Plantillas por `channel_account` | MVP |
| R11 | **Mensajes rápidos** globales y por usuario | Inventario #12 | I | Productividad diaria | + variables de campos tipados | MVP |
| R12 | **Etiquetas** con color, sincronía con GHL, «etiqueta obligatoria» al cerrar | Inventario #4 | V | Regla útil | Etiquetas del sistema fijas + etiquetas de usuario (ADR-08) | MVP |
| R13 | **Créditos de IA**: compra, precio por modelo, consumo | Inventario #19 | V | Modelo de negocio | Medición por organización (`ai_usage`) | V1 |
| R14 | **Planes con límites y funciones activables**; cobro | Inventario #25 | V | Concepto de SaaS | Plataforma de facturación; pasarela por decidir | V1 |
| R15 | **Cumpleaños** | Inventario #29 | I | Valor para el cliente | Automatización con bitácora y sin duplicados | V2 |
| R16 | **Webhooks entrantes y salientes** | Inventario #16 | I | Base de integración | Webhooks con firma + HTTP request con allowlist | V1 |
| R17 | **Consola de plataforma («todas las conexiones»)** | Inventario #10 | I | El Super Admin necesita verla | Consola Super Admin | V1 |
| R18 | **Tests como especificación** (`ResponseTimeReportService`, `KanbanPipelines`, `GhlSalientes`, `EliminarConexion`) | Entrega 1 | V | El comportamiento queda definido | Casos de prueba iniciales | MVP |
| R19 | **Whitelabel** | Inventario #27 | I | Útil para la agencia | Marca por organización | V2 |
| R20 | **Configuración por conexión**: NPS, inactividad, vacaciones colectivas, saludo y despedida | Inventario #9, #28 | V | Ajustes ya usados | `channel_accounts.settings` | V1 |

---

## 2. REDISEÑAR (el problema es real; la solución cambia)

| # | Qué | Problema hoy | Diseño 2.0 | Fase |
|---|---|---|---|---|
| D1 | **Modelo central** | Todo cuelga de `Ticket` | `Contact → Conversation → Message`, con `Opportunity` separada | MVP |
| D2 | **Multi-tenancy** | 26 modelos sin `companyId` (B10), 151 `findByPk` sin filtro (B4) | `organization_id` NOT NULL en toda tabla de negocio + RLS en PostgreSQL + tenant obligatorio por construcción | MVP |
| D3 | **Autenticación y roles** | JWT con valor por defecto, seed público, permisos como banderas sueltas | Auth propia (Argon2id, `AuthProvider`), sesiones revocables, RBAC. Jerarquía Super Admin → Agencia → Cliente → Asesor (ADR-01, 11) | MVP |
| D4 | **Pipeline de entrada de mensajes** | `wbotMessageListener.ts` de 5.013 líneas; la precedencia está en una cadena de `if` | Cadena de handlers con orden declarado y testeable. Cada canal entrega un `NormalizedMessage` | MVP |
| D5 | **Conversación idempotente** | Pueden crearse duplicadas | Restricción única parcial + advisory lock | MVP |
| D6 | **Campos personalizados** | Clave/valor sin tipo | Definiciones tipadas y reutilizables, con overrides por oportunidad | MVP |
| D7 | **Pipelines y etapas** | Kanban = agrupación de etiquetas | Pipelines múltiples, etapas editables, ocultar etapa sin eliminarla, etapa «Cita» opcional que dispara `Schedule` (ADR-12, 18) | MVP |
| D8 | **Colas y equipos** | Peso en el usuario; modo aleatorio sin filtrar | Miembros y pesos por cola, horario por cola, catálogo por cola (ADR-07, 08) | MVP |
| D9 | **Compartir vs. transferir** | No existía separación | Transferir cambia dueño; compartir otorga permiso sin perder propiedad; la comisión es del dueño con split opcional (ADR-14, 18) | MVP |
| D10 | **Flow Builder** | 24 nodos en el lienzo, 15 ejecutan; estado en memoria del proceso; variables globales entre empresas (B21) | Máquina de estados persistida (`flow_runs`), un paso = un job con lock; esperas como jobs diferidos; variables por run / contacto / organización | V1 |
| D11 | **Automatizaciones** | No había motor de reglas | Trigger / condición / acción sobre campos, además de los flujos conversacionales | V1 |
| D12 | **SLA y tiempo de respuesta** | Sin horario laboral ni feriados; un reabierto cuenta varias veces | SLA con calendario laboral y zona por organización, atribuido a quien respondió | MVP |
| D13 | **Horarios** | Tres tipos, zona `America/Sao_Paulo` fija | Un solo servicio con zona por organización | MVP |
| D14 | **Campañas masivas** | Solo Baileys, sin límites, fallos tragados, riesgo de bloqueo | Oficial con plantillas, o QR con límites explícitos (diario, por minuto, calentamiento, ventana real, opt-out, estado por destinatario). Marcadas de **riesgo** (ADR-02) | V2 |
| D15 | **Marcador masivo / call center** | No existía como tal | Cola de llamadas con límites y registro (ADR-10) | V2 |
| D16 | **Archivos y medios** | `/public` sin autenticación (B23); path traversal (B19) | Assets por id, URLs firmadas, validación MIME, aislados por organización | MVP |
| D17 | **API pública** | Token de la conexión en claro, sin caducidad | Tokens hasheados con scope, caducidad y rate limit | V1 |
| D18 | **Dashboard y reportes** | Consultas con SQL inyectable (B15, B16) | Dashboard con widgets configurables, tiempo real con cronómetros, analítica con ver y descargar reporte (ADR-15, 18) | MVP |
| D19 | **Integraciones y secretos** | Claves en claro en el JSON del flujo (B24); HTTP sin allowlist (B20) | Secretos cifrados por organización, referenciados por id; allowlist, bloqueo de IP privadas, límite de tamaño | MVP |
| D20 | **Consentimiento de datos** | «LGPD» como estado del ticket | Consentimiento como atributo del contacto | V1 |
| D21 | **Ventas / comisiones** | Venta simple | Total, abono, saldo, comisión sobre el total, regla de reversión configurable (ADR-08, 18) | V1 |

---

## 3. DESCARTAR (no entra en 2.0)

| # | Qué | Motivo |
|---|---|---|
| X1 | Chat interno, Anuncios, Ayuda | Heredado de Whaticket; no es del producto |
| X2 | Chatbot por cola y `QueueOption` | Lo cubren Flujos y Agentes IA |
| X3 | Typebot y Dialogflow como integraciones de primera clase | Cobertura con webhook / HTTP request |
| X4 | Prompts IA del sistema anterior y OpenAI legacy | Se fusionan en Agentes IA |
| X5 | Transferencia por «frase mágica» | Frágil; reemplazada por acciones explícitas |
| X6 | `global.flowVariables`, estado del flujo en el ticket, esperas con `setTimeout` | Fugas entre empresas y pérdida al reiniciar |
| X7 | `ORDER BY random()`, cooldown por `getMinutes()`, mutex por llamada | Reemplazados por reparto ponderado y locks |
| X8 | `static /public` | B23 |
| X9 | Zona Sao Paulo fija | D13 |
| X10 | `FlowCampaign` como «campaña», `tagListId`, `ScheduledMessages`, jobs de cumpleaños duplicados | Campos muertos o duplicados |
| X11 | Seed con credenciales (`admin@multi100.com.br`) y secretos JWT por defecto | B2, B3 |
| X12 | Material-UI v4, Sequelize 5, Bull 3 | Fuera de soporte (B12) |
| X13 | `api_transcricao` tal como está | Se reemplaza por proveedor STT tras un adapter |
| X14 | Reparación de contactos LID e importar historial de Baileys | Específicos del QR; viven en `EvolutionProvider` |
| X15 | Fallback del cifrado a `JWT_SECRET` | B9: claves separadas y rotables |

---

## 4. NUEVO (no existe hoy)

| # | Qué | Origen | Fase |
|---|---|---|---|
| N1 | **Organizaciones (cuentas B2B) y jerarquía de agencias**, con historial de propietarios y traspaso al Super Admin si la agencia se retira (`organization_ownership_history`) | ADR-11, 18 | MVP |
| N2 | **Oportunidades** separadas del contacto, con overrides de campos | Entrega 1 | MVP |
| N3 | **Contactos configurables**: columnas, vistas guardadas, importar/exportar CSV | Mensaje #2 | MVP |
| N4 | **Inbox estilo WhatsApp**: filtros por asesor (solo administradores y roles mayores) y por fuente, composer con archivos, emojis, audio, mensajes programados y notas internas | ADR-16, 17 | MVP |
| N5 | **Compartir conversación** con otro asesor sin perder propiedad | ADR-14 | MVP |
| N6 | **Ventana de gracia del Purchase** (30–60 min configurable, máx. 24 h) y evento personalizado `SaleCanceled` opcional | ADR-18 | MVP |
| N7 | **Etapa «Cita» opcional** que informa `Schedule` a Meta | ADR-18 | MVP |
| N8 | **Formularios embebibles** para captar leads | ADR-09 | V1 |
| N9 | **Knowledge Base con RAG real** (pgvector) | Entrega 1 | V1 |
| N10 | **Captura de datos por IA hacia campos** | Entrega 1 | V1 |
| N11 | **Telefonía + WebRTC** con `TelephonyProvider` (Twilio primero) | ADR-03 | V1 |
| N12 | **IA de voz** tras `VoiceProvider`; PoC Retell vs. Vapi antes de decidir | ADR-04 | V2 |
| N13 | **Comisiones configurables** y reportes en ventas netas | ADR-08, 18 | V1 |
| N14 | **Auditoría antes/después con origen** | Entrega 1 | MVP |
| N15 | **Observabilidad**: logger estructurado con redacción de PII, métricas, trazas | Instrucciones | MVP |
| N16 | **Dashboard de ventas** con widget grande de valor generado, orden configurable y ojito por widget | ADR-15 | MVP |
| N17 | **Navegación móvil** (barra inferior, botón +, menú con favoritos) | ADR-17 | MVP |
| N18 | **Migración desde ChatIA** (diferida, con mapeo de ids) | ADR-06 | V2 |

---

## 5. Lo que esta clasificación NO resuelve

1. **Certeza «I»**: los ítems R11, R15, R16, R17, R19, X1 y parte del Inventario se deducen de nombres y modelos. Hay que confirmarlos al leer cada pantalla antes de construir.
2. **Archivos del repo sin leer**: `wbotMessageListener.ts` (tramos 1184-1348 y 2881-3022), `verifyQueueOficial`, `wbotClosedTickets` (resto), `docs/META_CONVERSIONS_API.md`, `RelatorioVendas` y el frontend de Campañas. Pueden aportar reglas finas; ninguno cambia la arquitectura.
3. **Decisiones abiertas**: hosting y región (latencia a Ecuador), ORM con soporte de `SET LOCAL` para RLS (spike), resultado del PoC de voz, retención de grabaciones, y la prueba real en Events Manager del evento personalizado.
4. **Campañas masivas por QR** siguen siendo un riesgo de bloqueo del número aunque se pongan límites; no se pueden garantizar.

## 6. Resumen

| Lista | Ítems | MVP | V1 | V2 |
|---|---|---|---|---|
| Recuperar | 20 | 11 | 7 | 2 |
| Rediseñar | 21 | 14 | 5 | 2 |
| Descartar | 15 | — | — | — |
| Nuevo | 18 | 11 | 5 | 2 |
