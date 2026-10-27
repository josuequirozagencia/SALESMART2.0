# Propuesta de ADR-55 — Integraciones (tarjetas), conexión con Facebook, historial de toques y «Anuncio ganador»

**Estado: PROPUESTO (2026-10-26).** Las cuatro decisiones de producto de la sección «Decisiones del responsable» las tomó Josué el 2026-10-26; el resto (diseño técnico) está pendiente de su aprobación y de la confirmación de lo marcado **«A VERIFICAR»**. No modifica el Build Spec: al aprobarse, Code aplica los cambios de la sección «Impacto» y renumera si ADR-55 ya estuviera usado.

## Contexto
Hoy las conexiones viven en Configuración › Conexiones (solo WhatsApp oficial, M5.1), GoHighLevel y la API de Conversiones tienen su propia pantalla, y la atribución de Meta (ADR-45) guarda solo el **primer y el último toque** como columnas del contacto, con el nombre del anuncio como texto. El responsable quiere: (1) una sección de **Integraciones en tarjetas**; (2) conectar **Facebook (Messenger), Instagram y la cuenta publicitaria** iniciando sesión con Facebook; (3) un **historial de actividad** del contacto con sus clics, primer y último toque; (4) la métrica **«Anuncio ganador»**: de qué creativo llegó cada venta y cuál fue su fuente. Referencias: GoHighLevel (actividad del contacto con «fuente de la primera atribución» y «más reciente», tarjetas de integraciones y ventana de configuración de Facebook con pestañas Messenger, Instagram y cuenta publicitaria).

## Decisiones del responsable (2026-10-26)
1. **Acreditar la venta al primer anuncio** (primer toque), con historial de actividades del contacto y su primer y último clic visibles.
2. **Por fases:** primero el medidor sin gasto; después la cuenta publicitaria (gasto, costo por venta, ROAS).
3. **Messenger e Instagram después de M6.**
4. **Conectar con «Iniciar sesión con Facebook»** (no pegar un token a mano).

## Decisión técnica (recomendada)

### 1. Sección «Integraciones» en tarjetas (Configuración › Integraciones)
Tarjetas con ícono, nombre, descripción corta, estado (**Conectada**, **Requiere atención**, **No conectada**, **Próximamente**) y botón **Conectar** o **Gestionar**; buscador. Solo el administrador de la empresa (`integrations.manage`, nuevo). Las pantallas actuales no se reescriben: cada tarjeta abre la que ya existe.
- **Calendario de Google** · **Facebook / Messenger** · **Instagram (mensajes)** · **WhatsApp oficial** (abre las conexiones de M5.1) · **GoHighLevel** (M7) · **API de Conversiones de Meta** (M6.4).
- **Mensajería de TikTok**: tarjeta **«Próximamente»** sin botón. **A VERIFICAR** si TikTok ofrece una API de mensajería de negocio utilizable en nuestros países y qué aprobación exige; hasta entonces no se promete ni se construye (no está en el Build Spec).
- **WhatsApp QR (no oficial)**: tarjeta con **aviso de riesgo siempre visible**: «No es la API oficial de WhatsApp. WhatsApp puede **bloquear o suspender el número**, la sesión puede **desconectarse** y no hay plantillas aprobadas. No lo uses con tu número principal.» Al conectar, el administrador marca una **confirmación explícita** («Entiendo el riesgo de bloqueo») que queda auditada. Hasta que exista el adaptador (ADR-54 lo deja al final y condicionado al spike de ADR-31, que no se ha ejecutado) la tarjeta aparece como **«Próximamente»**, con el aviso ya escrito.

### 2. Conexión con Facebook (fase 3; ver «Fases»)
- Flujo OAuth con «Iniciar sesión con Facebook» desde la tarjeta. Tras autorizar se abre una ventana como la de referencia con tres pestañas: **Facebook Messenger**, **Instagram** y **Cuenta publicitaria**. Se listan **solo las páginas y cuentas de Instagram que esa persona administra**; cada una tiene su interruptor y **las páginas nuevas nacen desactivadas** (no se enciende nada sin que el administrador lo decida). Cuenta publicitaria: una seleccionada «para informes», cambiable.
- **Aislamiento (crítico):** quien inicia sesión puede administrar páginas de **otros clientes** (caso típico de una agencia). Solo se vincula a la empresa activa lo que el administrador enciende, y una página o cuenta de Instagram **solo puede estar activa en una empresa** (ruta de identidad tipo `channel_routes`, ADR-50). El `state` del OAuth va firmado y atado a la sesión y la empresa (anti-CSRF); la URL de retorno es fija.
- **Credenciales:** tokens cifrados con la bóveda (AAD `integration/<id>`), nunca devueltos (solo últimos 4), por empresa. Si Meta los revoca o vencen, la tarjeta pasa a **Requiere atención** (el ícono naranja de la referencia) y se avisa al administrador.
- **A VERIFICAR con la documentación de Meta antes de construir:** la lista exacta de permisos (mensajes de páginas, mensajes de Instagram, lectura de anuncios), cuáles requieren **revisión de la app y verificación del negocio**, el **callback de eliminación de datos** que Meta exige a las apps con Facebook Login, y las reglas de ventana de respuesta de Messenger e Instagram. Esto fija el calendario real: la revisión de Meta tarda semanas.

### 3. Historial de toques (actividad del contacto)
- Tabla nueva `contact_touch_events` (negocio, RLS forzada, **solo inserción**, sin DELETE): `occurred_at`, `kind` (`ad_click`, `form_submit`, `message_in`; `page_visit` queda reservado), `source` (pago social, orgánico, directo, formulario…), `campaign`, `adset`, `ad`, **`ad_id`**, `ctwa_clid`, `utm` (jsonb), referencia al origen. Es lo que ADR-45 dejó previsto como alternativa.
- `contacts.first_touch_*` y `last_touch_*` se **mantienen** como resumen (el primero inmutable) y se agrega **`first_touch_ad_id`** / **`last_touch_ad_id`**: el **nombre de un anuncio puede repetirse o cambiar; el id no**. Los contactos ya existentes siguen agrupándose por nombre hasta que lleguen toques nuevos.
- Ficha del contacto: pestaña **«Actividad»** con la línea de tiempo (como la referencia) y al pie «Fuente de la primera atribución» y «Fuente de atribución más reciente».
- **A VERIFICAR en el código:** hoy los datos de anuncio entran por `POST /v1/attribution/ctwa/:id` (ADR-45). Conviene que también se lean **directo del aviso de Meta** del mensaje entrante (el que trae el id del anuncio, su titular y el `ctwa_clid` en los clics a WhatsApp), de modo que no dependa de una configuración externa. Code confirma si M5.2 ya lo recibe.
- **No incluye visitas de página** (la captura de GoHighLevel las muestra). Exigen un script de seguimiento en las páginas del cliente y una política de consentimiento. Se decide aparte; `embed.js` (M9.2) sería el punto natural.
- Retención de los toques: **PROVISIONAL** (propuesta 24 meses), configurable.

### 4. «Anuncio ganador» (fase 1, sin cuenta publicitaria)
- Por anuncio (clave `first_touch_ad_id`, o el nombre si no hay id): **chats nuevos**, **citas**, **ventas** (cantidad), **ingresos** (suma del total de las ventas, no de los abonos) y **cierre** = ventas ÷ chats. Orden por cierre; filtros 7, 15, 30, 90 días o rango. Miniatura y titular solo si Meta los entregó con el clic.
- **Por defecto, cohorte:** los leads cuyo primer mensaje cayó en el periodo y cuántos de ellos ya compraron (una venta tardía suma a su anuncio original). Interruptor **«Por fecha de conversión»**: cuenta las ventas ocurridas en el periodo, sea cual sea su fecha de llegada. Ambos modos se explican en pantalla.
- Fuente de las ventas: las de M6.2 con alcance por persona (el asesor ve solo lo suyo; el administrador, todo). Entra en el dashboard de M6.5 como bloque propio y en el CSV.
- En la lista de conversaciones del Inbox, el filtro de fecha gana **«Por conversión»** (fecha de la venta o cita del contacto), además de «Primer mensaje» y «Último mensaje».

### 5. Cuenta publicitaria: gasto, costo por venta y ROAS (fase 2)
Con permiso de lectura de anuncios: tarea diaria `ad-insights-sync` (`SKIP LOCKED`) que trae gasto, impresiones y clics por anuncio y día a `ad_insights_daily` (negocio, RLS). El medidor suma **gasto, costo por chat, costo por venta y ROAS** (ingresos ÷ gasto). **Solo cuando la moneda de la cuenta publicitaria coincide con la de la empresa**; no se convierten monedas por ahora (si difieren se muestra el aviso). Los datos de una empresa jamás se mezclan con los de otra aunque compartan la misma cuenta publicitaria (cada una lee con su propio token).

## Fases
| Fase | Contenido | Depende de |
|---|---|---|
| **A** (ahora, dentro de M6) | Sección Integraciones en tarjetas (con QR y TikTok como «Próximamente»); `contact_touch_events` + pestaña Actividad; medidor «Anuncio ganador» sin gasto; filtro «Por conversión» | Nada externo |
| **B** | Conexión con Facebook (OAuth), páginas y cuenta publicitaria; gasto, costo por venta y ROAS | **Revisión de la app de Meta** (a verificar) |
| **C** (después de M6, hito nuevo) | Messenger e Instagram en el Inbox con su adaptador, topes de recordatorio de 5 ya definidos en ADR-13 | B y la revisión de Meta |
| **D** | Mensajería de TikTok | Spike de viabilidad |

## Alternativas
Acreditar al último toque (se queda como segunda columna de lectura, no como regla); pegar un token a mano (descartado por el responsable; más simple pero peor experiencia y token de larga vida en manos del administrador); calcular el medidor solo con la Marketing API (descartado: no hace falta para la fase A y añade dependencia y revisión); no guardar historial y reconstruirlo (imposible después: el clic no se puede recuperar).

## Ventajas y desventajas
+ La fase A entrega valor sin esperar a Meta; el id del anuncio evita errores por nombres repetidos; el historial inserta-solo es auditable; el aviso de riesgo del QR y su confirmación quedan registrados.
− Más tablas y datos personales (hay que definir retención); las fases B y C dependen de aprobaciones de Meta que no controlamos; atribuir al primer anuncio subestima al que cerró la venta (por eso se conserva el último toque visible).

## Impacto (lo que Code aplicaría tras aprobar)
- **Migraciones nuevas:** `contact_touch_events`, columnas `first_touch_ad_id`/`last_touch_ad_id`, `integration_connections` (y su ruta de identidad por página/cuenta) en la fase B, `ad_insights_daily` en la fase B; permiso `integrations.manage`.
- **Build Spec:** §6 (tablas), §7 (API), §14 (nueva rebanada de M6 para la fase A y un hito nuevo para las fases B a D); `CLAUDE.md` y el ADR definitivo.
- **Web:** Configuración › Integraciones, pestaña Actividad del contacto, bloque «Anuncio ganador» en el dashboard, filtro «Por conversión» en el Inbox.
- **Pruebas:** aislamiento A↔B por endpoint, firma/estado del OAuth, una página no activable en dos empresas, el token nunca devuelto, los dos modos del medidor con ventas tardías, cambio de nombre de anuncio con el mismo id.

## Decisiones que quedan para el responsable (recomendación entre paréntesis)
1. Retención de los toques: **24 meses, provisional**.
2. Visitas de página (script de seguimiento): **no ahora**.
3. Páginas nuevas **desactivadas** al conectar (recomendado).
4. Una cuenta publicitaria **por empresa para informes** (recomendado), permitiendo la misma cuenta en dos empresas.
5. Modo por defecto del medidor: **cohorte** (recomendado).
6. Spike de viabilidad de TikTok: **sí, solo lectura de documentación**, antes de ofrecerlo.
