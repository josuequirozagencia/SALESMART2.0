# Sales Smart 2.0 — Reporte de actualización del prototipo (v9)
Fecha: 2026-10-05 · Solo prototipo/UX. No se tocó el backend, el Build Spec ni los ADR.
Archivo: `prototype/sales-smart-2-prototipo.html` (respaldo previo: `proto-v8-backup-20261005.html`).

## Decisiones confirmadas por Josué (05/10)
1. **Grupos de WhatsApp: solo con WhatsApp QR (no oficial)**, con chip ámbar y aviso de riesgo de bloqueo.
2. **Campañas masivas según la conexión:** WhatsApp API oficial → selector de **plantillas aprobadas**; WhatsApp QR → **texto libre** (con límites bajos). El sistema identifica el tipo de conexión y cambia el campo.
3. **Ventas:** el asesor **crea** ventas pero **no puede modificarlas** (ni valor, ni método de pago, ni comisión, ni plan).

## 1. Pantallas nuevas / modificadas
| Pantalla | Estado | Qué cambió |
|---|---|---|
| Inbox (composer) | Modificada | Botón **Enviar** siempre visible (deshabilitado si está vacío), Enter envía, Shift+Enter salto de línea (campo multilínea con crecimiento automático), micrófono se mantiene. Causa del problema anterior: una regla CSS ocultaba el botón mientras no había texto. |
| Inbox (panel del contacto) | Modificada | Columna de datos **oculta por defecto** al entrar al Inbox; botón de panel y clic en el nombre la abren/cierran. En tablet/móvil se abre como drawer (patrón existente). |
| Inbox móvil | Modificada | Composer en dos filas (campo ancho arriba; adjuntar, emoji, programar, micrófono y **Enviar** abajo). Se corrigió un ancho de columna que dejaba el hilo en 320 px. |
| Mis ventas | **Nueva** (solo Asesor) | KPIs, filtros de período y estado, plan de comisión en solo lectura, tabla de ventas y drawer de detalle bloqueado. |
| Campañas masivas | Reescrita (Cliente, Súper Admin, Asesor) | Alcance visible del asesor, destinatarios con casillas, selector de conexión, plantilla/texto libre, envío ahora/programado, resultados por campaña. |
| Grupos de WhatsApp | **Nueva** | Gestor (tarjetas/lista, búsqueda, pestañas WhatsApp / En el CRM), detalle del grupo, enviar mensaje, mensajes programados, crear grupo. |
| Usuarios y permisos | Modificada | Nueva tarjeta «Acceso de asesores a campañas y grupos» con interruptores por asesor. |
| Asesores y comisiones | Modificada | Aviso «Lo define el Cliente» y botón «Ver Mis ventas como…». |
| Menú | Modificado | «Mis Ventas», «Campañas masivas» y «Grupos de WhatsApp» (según rol y permisos). |
| Mapa ChatIA → 2.0 | Modificada | 3 filas nuevas (grupos, campañas por asesor, Mis ventas). |

## 2. Componentes nuevos
Selector de perfil de asesor (Marcela / Diego / Pedro) bajo «Ver como: Asesor» · tarjeta de alcance de contactos con barra · selector de destinatarios con casillas y «no contactar» · selector de conexión con detección de tipo · vista previa de mensaje con variables · interruptor deshabilitado por dependencia · drawer de detalle de venta bloqueado · tarjetas y filas de grupo · selector de frecuencia recurrente con días · adjuntos con chips · drawer de resultados de campaña.

## 3. Permisos agregados al prototipo
| Permiso | Quién lo decide | Efecto |
|---|---|---|
| `camps` Campañas masivas (ya existía, ahora con alcance) | Cliente, por asesor | Muestra «Campañas masivas»; solo contactos propios o compartidos. |
| `capDay` Tope diario de campañas | Cliente, por asesor | Límite efectivo = mínimo entre el tope del asesor y el de la conexión. |
| `gv` Ver grupos | Cliente | Muestra «Grupos de WhatsApp» (solo lectura). |
| `gs` Enviar mensajes a grupos | Cliente (requiere `gv`) | Botón Enviar mensaje y Mensajes programados. |
| `gm` Administrar participantes | Cliente (requiere `gv`) | Agregar/quitar, admin, importar y descargar CSV, ajustes del grupo, crear grupo. |
| Mis ventas / comisión propia | Siempre para el asesor, solo lectura | Sin edición de ventas, comisión, método de pago ni plan. |
| `groups` (existente) | — | Renombrado «Ver chats de grupo (conversaciones)» para no confundirlo con el gestor. |

Reglas visibles: Súper Admin y Cliente conservan acceso total; el asesor no recibe nada automáticamente; la interfaz solo oculta (la protección real irá en el guard del servidor).

## 4. Flujos nuevos
1. Cliente activa campañas/grupos a un asesor → «Ver como» → el menú del asesor cambia.
2. Asesor crea campaña: base (Mis contactos / Compartidos) → destinatarios → conexión (oficial = plantilla; QR = texto libre) → ahora o programar → resultados.
3. Asesor consulta Mis ventas: período → detalle bloqueado → «Pedir corrección al administrador».
4. Grupo: lista → detalle → agregar/quitar/importar CSV/descargar → enviar mensaje (ahora, programado, recurrente) → mensajes programados.
5. Inbox: escribir → Enviar (clic o Enter); abrir/cerrar datos del contacto.

## 5. Datos mock
3 asesores (Marcela R., Diego T., Pedro V. — este último nuevo) con permisos distintos · 10 grupos (3 a 212 participantes) · 3 mensajes de grupo programados · 32 contactos de campañas (8 reales + 24 simulados, con «no contactar» y compartidos) · 6 campañas (3 existentes + 3 de asesores) · 4 plantillas (1 en revisión) · 14 ventas nuevas (cobradas, con saldo y anulada) con método de pago · plan de comisión del Cliente (8 %).

## 6. Solo visual / simulado
Todo el envío (campañas, grupos, mensajes), la sincronización de grupos, la importación y descarga de CSV (el CSV sí se genera con datos de ejemplo), los resultados de campañas, los límites, la solicitud de corrección de ventas, y el cambio de perfil. Nada se guarda ni se envía.

## 7. Entidades y cambios necesarios en el Build Spec (NO aplicados)
- **Contradicciones/huecos:** (a) Campañas masivas figuran en **V2**; (b) el gestor de grupos **no existe** en el spec; (c) la visibilidad `owner_id = yo OR participante` (ADR-14) está definida para conversaciones, no para contactos; (d) «cartera» ya significa cartera de clientes de una agencia: en la UI se llama «Mis contactos».
- **Permisos** (catálogo §5.2 y ADR-29, matriz provisional): `campaigns.send` (alcance propio), `groups.view|send|manage`, `sales.read_own`, `commissions.view` con alcance propio.
- **Entidades:** `campaigns`, `campaign_recipients` (estado por destinatario), `wa_groups`, `wa_group_participants`, `wa_group_scheduled_messages` (regla de recurrencia), `sale_change_requests`, límite diario por usuario; capacidad `groups` en `WhatsAppProvider` (solo QR); regla de acceso a contactos por asesor; `whatsapp_templates` ya existe.
- **Riesgos a decidir:** bloqueo de números QR (límites, calentamiento); verificar si la API oficial de Meta permite alguna gestión de grupos; si los grupos se asignan por asesor o son de toda la organización (hoy: de toda la organización); costo de plantillas de marketing; consentimiento y «no contactar» (V1).

## 8. Clasificación sugerida
| Función | Fase |
|---|---|
| Botón Enviar, Shift+Enter, panel oculto, composer móvil | **MVP** (corrección) |
| Mis ventas (ventas, totales, período) | **MVP** |
| Comisión propia del asesor, plan en solo lectura | **V1** (con Comisiones) |
| Gestor de grupos (con QR) y permisos por asesor | **V1** (con WhatsApp QR) |
| Campañas masivas del asesor (plantilla/texto libre, alcance, tope) | **V2** (coherente con el spec; adelantar exige decidir cobro, límites y consentimiento) |

## Pruebas realizadas
Navegador real (Chromium) en 1440, 820 y 390 px con los 4 perfiles: 0 errores de JavaScript, 0 desbordes horizontales en todas las pantallas, flujos previos intactos (nota interna, mensaje programado, respuesta rápida) y comparación con la copia v8 (se detectó y corrigió una regresión de ancho en el hilo móvil).

---
## Ajustes v10 (2026-10-09, por indicación de Josué)
- **Mis ventas (asesor):** columnas separadas **Valor · Abono · Saldo · Comisión**; botón **Registrar abono** (fila y detalle) con monto, método y nota, «pagó todo el saldo», validación contra el saldo, historial de abonos (no editable) y paso automático a «Cobrada». Valor, producto, comisión y plan siguen bloqueados.
- **Se quitó el pago de comisión:** columna «Pago de comisión», fila «Forma de pago de la comisión» y KPI «Comisión por cobrar» (reemplazado por «Saldo por cobrar»).
- **+ Contacto:** formulario completo (nombre, teléfono, correo, ciudad, interés, fuente, asignado, pipeline/etapa, etiquetas, consentimiento + campos personalizados); teléfono duplicado se rechaza; el asesor solo se asigna a sí mismo.
- **Campos del formulario:** en Configuración › Campos personalizados cada campo se puede mostrar/ocultar en el formulario de contacto y marcar como obligatorio; al crear un campo se indican opciones (selección), obligatorio y visibilidad; botón «Ver formulario de contacto». Los campos aparecen también al editar un contacto.
- **Solo visual:** todo se guarda en memoria del navegador; archivos adjuntos de campos de tipo «Archivo» simulados.
- Respaldo previo: `proto-v9-backup-20261009.html`.

