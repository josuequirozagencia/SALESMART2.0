# PROMPT PARA CODE (v2) — Rediseño del Inbox y navegación móvil · Sales Smart 2.0

> Estado: PREPARADO, NO ENVIADO. Se pasa a Code solo cuando el responsable lo pida.
> Fecha: 2026-11-04. Sustituye al prompt v1 («REDISEÑO UI/UX SALES SMART 2.0 — INBOX RESPONSIVE + DESKTOP + MOBILE»).
> Documentos que mandan: `CLAUDE.md`, `docs/ADR.md`, `docs/BUILD_SPEC.md`. Si algo de este prompt contradice un ADR, **para y pregunta**.

---

## 0. Rol y objetivo

Actúa como Senior Product Designer y Senior Frontend Engineer (React 19, Vite, Tailwind v4, react-router-dom 7) con experiencia en apps de mensajería móvil (WhatsApp Business, Telegram) y CRMs (Linear, Attio, HubSpot).

Objetivo: que el **Inbox** y la **navegación** sean fluidos y rápidos, **primero en teléfono** y después en escritorio:

- **Móvil (< 768 px):** lista de chats a pantalla completa, conversación a pantalla completa, barra inferior de accesos directos y un Menú de iconos en filas.
- **Escritorio (≥ 1280 px):** tres columnas con divisores arrastrables, **con el chat como protagonista** (más ancho que hoy).
- **Tablet (768–1279 px):** lista + chat; el panel del contacto se despliega encima.

Es un cambio **solo de interfaz** (`apps/web`). No es una redefinición de producto.

---

## 1. Decisiones ya tomadas por el responsable (no se discuten)

1. **Barra inferior móvil nueva**, con iconos de acceso directo, en este orden (de izquierda a derecha): **Inicio · Calendario · Ventas · Inbox · Menú**. **No hay botón central «+»**. No existe código previo que reutilizar (solo está dibujada en `prototype/sales-smart-2-prototipo.html`): se construye aquí, tomando el prototipo como referencia visual.
2. **Se mantiene la tipografía actual** (Plus Jakarta Sans + IBM Plex Mono). **No** se añade Inter. No se toca el CSP de fuentes.
3. **Un solo color por defecto: índigo**, con **fondo claro**. El selector de temas de Configuración **se conserva** (los temas verde/rojo/oscuro existentes siguen funcionando); solo cambia cuál es el predeterminado. **Se añade interruptor claro/oscuro para toda la plataforma** (ver §5.5) y **barra lateral plegable a solo iconos** (ver §5.4).
   - Referencia visual aprobada: prototipo «Sales Smart 2.0 · Inbox y navegación móvil» (artefacto, versión del 2026-11-04). Si el código y el prototipo difieren, manda este documento; el prototipo es guía visual, no código a reutilizar.
4. **La barra inferior solo existe en móvil.** En el Menú móvil, las secciones se muestran como **iconos en filas (cuadrícula)**.
5. **Quedan fuera de alcance** (no dibujar, no maquetar, no dejar botones muertos): filtro «Grupos», conversaciones fijadas, estado «en línea», botón de llamada.
6. **Chat con mayor espacio** en escritorio (ver §6).
7. **IA asistente en el composer: solo estudio de viabilidad** (ver §10). **No se implementa** en este trabajo.

## 2. Decisiones técnicas fijadas (recomendación del arquitecto, aprobadas por delegación)

- **Iconos:** componente propio `ui/Icon` con SVG en línea (trazo 1.75, 24×24, `currentColor`) y solo los iconos que se usan. **Sin Lucide ni otra dependencia.** Si ya existe un set de iconos en `apps/web/src/ui`, se reutiliza y se amplía en lugar de crear otro.
- **Divisores redimensionables:** implementación propia con Pointer Events (sin librería). Accesibles: `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max`, `tabIndex=0`, flechas del teclado (±16 px; Mayús ±64 px), `Inicio/Fin` para colapsar/expandir, doble clic para restaurar.
- **Persistencia de la distribución:** `localStorage`, con clave por persona **y** empresa: `ss.inbox.layout.v1:<userId>:<orgId>`. Siempre dentro de `try/catch` y con valores por omisión si falla. **Sin cambios de BD ni de API.** Queda documentado que es «por persona en este navegador» (no sigue a la persona entre dispositivos); sincronizarlo entre dispositivos sería una decisión aparte con endpoint nuevo.
- **Un solo origen de breakpoints:** `apps/web/src/ui/breakpoints.ts` con `MOBILE_MAX = 767`, `DESKTOP_MIN = 1280` (tablet = entre ambos) y un hook `useBreakpoint()` basado en `matchMedia`. Auditar los cortes actuales (hoy hay 760/900/1180 dispersos y el `SidebarShell` tiene el suyo) y **migrarlos a este módulo** para que barra lateral, barra inferior y Inbox no se contradigan.

## 3. Reglas de protección (inviolables)

No modificar: base de datos, migraciones, esquemas, API, endpoints, webhooks, integración de WhatsApp, multi-tenant/RLS, autenticación, permisos, roles, asignación, SLA, automatizaciones, estados de conversación, contactos, lógica de ventas.

- Ningún dato inventado ni de ejemplo en pantalla. Si un dato no llega por una API existente, **no se muestra** (no se maqueta).
- No se elimina ninguna función existente del Inbox: respuestas rápidas, plantillas, programar, adjuntos, nota de voz, emojis, reacciones, notas internas, transferir/compartir, finalizar, aceptar/tomar, etiquetas, banner del agente de IA, chips de SLA, mensajes automáticos, avisos de sesión QR, tiempo real.
- Sin dependencias nuevas. Si en algún punto parece imprescindible una, **para y pregunta** con la justificación.
- Sin `console.log`; textos de interfaz en español; identificadores en inglés.
- La visibilidad por permisos se mantiene: cada acceso (barra inferior y Menú) solo aparece si la persona tiene el permiso de esa sección, **con la misma regla que ya usa `AppShell`**. No se duplica la lógica: se reutiliza la definición de secciones.

---

## 4. FASE 1 — Auditoría (y **PARADA**)

Entregar un informe corto (sin cambiar código) y **detenerse para aprobación**:

1. Estructura de `AppShell` / `SidebarShell`: cómo define secciones, grupos, permisos e insignia de Inbox sin leer. Cuál es la fuente única de las secciones para reutilizarla en la barra inferior y el Menú.
2. Componentes del Inbox (`features/inbox`): lista, hilo, composer, panel de contacto; cómo se organiza hoy el layout de tres columnas y los cortes responsive.
3. Rutas actuales del Inbox y cómo se selecciona la conversación (estado vs URL).
4. Estado de la lista (filtros, pestañas, búsqueda, scroll) y de la conversación abierta; cómo se actualiza (Socket.IO + consulta de respaldo).
5. Tokens de estilo (`index.css`), cómo se implementan los temas y el modo oscuro, y dónde está el tema por omisión.
6. Iconos existentes y componentes de UI reutilizables.
7. Qué datos del contacto ya llegan en el Inbox sin endpoint nuevo (para la columna 3).
8. Las pruebas E2E existentes del Inbox (para no romperlas).
9. Lista de **riesgos** y una **propuesta de ADR-58** (decisión, alternativas, ventajas, desventajas, motivo, impacto) para el rediseño de la capa de navegación/Inbox. El ADR queda «PROPUESTO» hasta aprobación.

**No continuar a la Fase 2 sin respuesta.**

---

## 5. FASE 2 — Base visual y navegación (tras aprobar la Fase 1)

### 5.1 Tema
- Predeterminado: **índigo**, fondo claro. Mapear a los tokens existentes (no crear un segundo sistema de variables). Valores de partida: acento `#4F46E5`, acento suave `#EEF2FF`, fondo `#F6F7FB`, superficie `#FFFFFF`, borde `#E6E8F0`, texto `#1F2433`. Ajustar para cumplir contraste **WCAG AA** (texto ≥ 4.5:1; elementos de interfaz ≥ 3:1).
- Los temas existentes siguen seleccionables en Configuración y se aplican igual que hoy.
- El acento se usa en: acción principal, selección, insignias y estado activo. **Nunca** como fondo dominante.
- Movimiento: transiciones de 150–200 ms; respetar `prefers-reduced-motion` (ya hay regla global).

### 5.2 Barra inferior móvil (`ui/BottomNav`)
- Solo visible en `< 768 px`. En ≥ 768 px no se monta.
- 5 accesos, en este orden: **Inicio, Calendario, Ventas, Inbox, Menú**. Icono + etiqueta debajo (etiqueta siempre visible). Estado activo: icono y etiqueta en acento + indicador (punto o píldora) — no depender solo del color.
- Insignia de **no leídos** en Inbox (misma fuente que el menú lateral; tope «99+»).
- Un acceso que la persona no puede ver por permisos **no se muestra** (la barra queda con menos de 5 y se reparte el espacio). El Menú siempre está.
- Cada objetivo táctil ≥ **44×44 px**. Barra blanca, bordes superiores redondeados, sombra suave, `padding-bottom: env(safe-area-inset-bottom)`.
- Es un `<nav aria-label="Navegación principal">`, con `aria-current="page"` en el activo. Orden de tabulación lógico.
- **Se oculta por completo** en: conversación individual (`/inbox/:id`) y cuando el **teclado virtual está abierto** en cualquier pantalla con campos de texto (detectar con `visualViewport`: altura visible muy menor que `innerHeight`).
- El contenido de las pantallas reserva espacio inferior (`padding-bottom` = alto de la barra + área segura) para que la barra nunca tape contenido. Probar en todas las secciones principales.
- Ventas y Calendario apuntan a las secciones existentes «Ventas» y «Agenda» (no se crean pantallas nuevas).

### 5.3 Menú móvil (`/menu`)
- Pantalla propia en móvil (no un panel lateral). Arriba: nombre de la empresa, persona y rol.
- Secciones como **cuadrícula de iconos en filas** (3 columnas en 360–430 px; icono grande + nombre debajo, nombre de hasta 2 líneas, sin recortes), agrupadas con los **mismos grupos** que la barra lateral (títulos de grupo discretos).
- Mismos permisos que el menú lateral. Insignias donde ya existan.
- Al final: **Configuración** y **Cerrar sesión**, bien separados y con confirmación solo si hoy ya la hay.
- En móvil desaparece la barra superior con ☰ y el panel lateral deslizante (los reemplaza barra inferior + `/menu`). En tablet y escritorio, la barra lateral sigue como hoy (en tablet puede ser un riel de iconos colapsado si el espacio lo exige).
- El estado activo se mantiene: dentro de una sección, el icono «Menú» se marca activo si la sección no es una de las cuatro de la barra.

---

### 5.4 Barra lateral plegable (escritorio y tablet) — NUEVO
- Dos estados: **expandida** (~232 px: icono + nombre) y **plegada** (~68 px: solo iconos). Botón de plegar/desplegar con chevrones dobles, `aria-label` y `title`; transición de ancho de 200 ms (desactivada con `prefers-reduced-motion`). La preferencia se guarda en `localStorage` (misma clave por persona y empresa de §2). Tablet: plegada por defecto.
- Plegada: cada icono con `title`/tooltip accesible con el nombre; la insignia de no leídos pasa a un punto sobre el icono; los títulos de grupo se sustituyen por un separador fino; foco visible; sin truncar ni solapar.
- Expandida: grupos con título corto en minúsculas (Principal, Ventas, IA y automatización), ítems de 40 px, estado activo con fondo + barra de 3 px a la izquierda (no solo color), insignias numéricas.
- Pie de la barra: interruptor de tema (§5.5) y persona/rol (solo avatar cuando está plegada).
- Es la misma fuente de secciones y permisos de §3 (no duplicar la lista).
- Al plegar, el espacio ganado va al chat (el panel de contacto y la lista conservan su ancho).

### 5.5 Modo claro / oscuro de TODA la plataforma — NUEVO
- Interruptor visible en: pie de la barra lateral (escritorio/tablet), cabecera del Menú móvil y cabecera de la lista del Inbox móvil. Es un `role="switch"` con `aria-checked` y texto («Modo oscuro» / «Modo claro»); icono luna/sol.
- Valores posibles: Claro · Oscuro · **Sistema** (por defecto sigue `prefers-color-scheme`; la elección manual se guarda en `localStorage`). Ya existe una regla `prefers-color-scheme: dark` en `index.css` y un selector de temas en Configuración: **se integra con ellos, no se crea un tercer mecanismo**. Combinar con el color de marca: el tema (índigo por defecto, y los que ya existan) cambia el acento; el modo claro/oscuro cambia las superficies.
- Todo el color de la interfaz sale de **variables CSS** (tokens) con valores para claro y oscuro; prohibido dejar colores fijos en componentes. Auditar los colores en línea actuales y migrarlos a tokens (listado de archivos afectados en la Fase 1).
- Valores de partida (ajustar con contraste AA real): 
  - Claro: fondo `#F6F7FB`, superficie `#FFFFFF`, superficie 2 `#F1F2F9`, borde `#E6E8F0`, texto `#1F2433`, secundario `#5B6275`, acento `#4F46E5`.
  - Oscuro: fondo `#0F1020`, superficie `#17182B`, superficie 2 `#1F2138`, borde `#2B2D4A`, texto `#E8E9F5`, secundario `#A0A3BF`, acento de botón `#5B5CF0`, acento de texto/icono `#A5B4FC`.
  - Etiquetas, notas internas, chips de SLA, estados de entrega, insignias y sombras tienen par claro/oscuro propio (no se reutiliza el color claro sobre fondo oscuro).
  - Barra lateral oscura en ambos modos (más profunda en modo oscuro).
- Sin parpadeo al cargar (aplicar el tema antes del primer pintado, p. ej. atributo en `<html>` desde un script mínimo en `index.html` **compatible con el CSP vigente**; si el CSP lo impide, usar una clase añadida lo antes posible desde el bundle y documentarlo).
- Imágenes/adjuntos/avatares con color fijo mantienen su contraste (texto oscuro sobre pasteles).
- Pruebas: captura de las pantallas principales en ambos modos; verificar contraste AA en ambos.

### 5.6 Auditoría de diseño y modernización visual (transversal)
Incluir en el informe de la Fase 1 una auditoría de UI con hallazgos y propuesta, y aplicar de forma gradual (sin reescribir módulos ajenos):
- Escala tipográfica coherente (cuerpo 14 px, secundarios 12–13 px, nunca menos de 12 px; hoy hay textos de 11–13.5 px), jerarquía clara de títulos.
- Radios y sombras consistentes (controles 10–12 px, tarjetas 14–16 px, sombras suaves y de un solo nivel), bordes de 1 px con token.
- Espaciado con escala de 4/8 px; áreas táctiles ≥ 44 px en móvil y ≥ 32–36 px en escritorio.
- Estados completos en componentes de lista/tabla (hover, foco, seleccionado, deshabilitado, cargando, vacío, error).
- Menos ruido: agrupar acciones secundarias, mostrar la acción principal una sola vez por pantalla, filtros visibles o en hoja (no ocultos).
- Consistencia de iconos (trazo 1.75, mismo tamaño por contexto) y de nombres de acciones.
- Cada hallazgo se clasifica RECUPERAR / REDISEÑAR / NUEVO, con esfuerzo estimado, para decidir qué entra en este trabajo y qué queda para después.

## 6. FASE 3 — Inbox de escritorio y tablet

### 6.1 Escritorio (≥ 1280 px): tres columnas, chat prioritario
- Columnas: **Conversaciones | Chat | Contacto**. El chat es la única columna flexible (`flex: 1`); las otras dos tienen ancho en px.
- Valores (con el área útil ≈ pantalla − barra lateral):
  - Conversaciones: **mín 260 · defecto 300 · máx 420**.
  - Contacto: **mín 280 · defecto 300 · máx 420**, **plegado por defecto bajo 1440 px de ancho total** (se abre con un botón en la cabecera del chat y se recuerda).
  - Chat: **mín 520**; recibe todo el espacio sobrante. Con contacto plegado a 1280 px el chat debe superar ~60 % del área útil.
- Prioridad al reducir el espacio: 1.º se pliega el panel de contacto, 2.º se estrecha la lista hasta su mínimo, **nunca** el chat por debajo de 520 px. Los paneles **no se superponen** en escritorio.
- Divisores: indicador al pasar el cursor (línea de acento de 2 px y cursor `col-resize`), área de agarre de ≥ 8 px, `user-select: none` y bloqueo de selección mientras se arrastra, `requestAnimationFrame` para no re-renderizar el hilo en cada movimiento (el redimensionado **no** debe reiniciar ni recargar la conversación ni perder el borrador del composer).
- Controles: plegar/expandir lista y contacto, y «Restaurar distribución» (botón y doble clic en el divisor).
- Guardar con el mecanismo de §2; validar lo leído (números dentro de rangos); si no cabe, recalcular.

### 6.2 Contenido de cada columna (solo lo que ya existe)
- **Lista:** búsqueda; pestañas Trabajando/Pendientes/Finalizadas con conteos; filtros existentes; filas con avatar, nombre, último mensaje (1 línea, truncado), hora, no leídos, chip de SLA, etiquetas (máx. 2 visibles + «+n»), marca de canal («QR · no oficial», GHL) y «Agente de IA» donde ya se muestran.
- **Chat:** cabecera (avatar, nombre, canal, acciones existentes: aceptar/tomar/finalizar/transferir-compartir); hilo con separadores por fecha, burbujas entrante/saliente diferenciadas, estados de entrega, reacciones, adjuntos, audio y notas internas distinguibles; composer con **todas** las funciones actuales. Composer fijo abajo; el hilo es el único elemento con scroll.
- **Contacto:** solo los datos y pestañas que ya existen (responsable, origen del lead, etiquetas, próxima cita, oportunidades, ventas, notas, tareas, GoHighLevel). Si un bloque necesita una llamada que hoy no existe en la bandeja, **no se añade**: se reutiliza el componente de la ficha del contacto o se omite y se anota en el informe.

### 6.3 Tablet (768–1279 px)
- Lista + chat visibles. Panel de contacto como **cajón superpuesto** desde la derecha (con fondo atenuado, cierre con Esc/tocar fuera/botón, foco atrapado y devuelto al cerrar).
- Anchos: lista 300 px fija (320 en ≥ 1024), chat el resto.

---

## 7. FASE 4 — Móvil (< 768 px): lista de chats

Pensado como WhatsApp Business, con las funciones reales del Inbox:

- Cabecera compacta: título «Inbox», buscador (campo de 44 px), botón de filtros que abre una **hoja inferior** con los filtros existentes.
- Pestañas **Trabajando / Pendientes / Finalizadas** como segmento desplazable horizontal (con conteos); filtros rápidos solo si ya existen (p. ej. «No leídos» si el filtro existe hoy; si no existe, **no se inventa**: anotarlo como propuesta).
- Fila de conversación: altura ≥ 72 px, ancho completo, avatar 44–48 px, nombre (negrita si no leída), hora a la derecha, último mensaje en 1 línea con ícono de estado de entrega si es saliente, insignia de no leídos, hasta 2 etiquetas (colores discretos, contraste AA), chip de SLA y marcas de canal. Sin texto superpuesto: `min-width: 0` + `text-overflow: ellipsis` en todos los contenedores flex.
- Estados completos: carga (esqueleto de filas), vacío (texto de qué hacer), error (con «Reintentar»), sin resultados de búsqueda.
- Scroll infinito/cursor como hoy; “jalar para actualizar” **no** (evita conflicto con el scroll del navegador; la actualización ya es en vivo).
- Barra inferior visible aquí.

## 8. FASE 5 — Móvil: conversación a pantalla completa

### 8.1 Ruta y estado
- Rutas: `/inbox` (lista) y `/inbox/:conversationId` (chat). En móvil, abrir una conversación **navega** a `/inbox/:id`; el botón atrás del sistema/navegador vuelve a la lista (`navigate(-1)` con respaldo a `/inbox` si no hay historia, p. ej. se abrió desde un aviso).
- **La lista no se desmonta** al abrir el chat (se oculta con CSS/`inert`), de modo que se conservan filtros, pestaña, búsqueda, **posición de scroll** y datos en caché; no se vuelve a pedir la lista al volver. En escritorio/tablet la URL también refleja la conversación seleccionada (enlace compartible/recargable) sin cambiar el comportamiento actual de selección.
- Un enlace directo a `/inbox/:id` de una conversación a la que la persona no tiene acceso debe mostrar el mismo estado «no encontrada» que ya devuelve el servidor (404 uniforme), sin pistas.
- Marcar como leída al abrir, como hoy.

### 8.2 Layout (clave para que se sienta nativo)
- Contenedor raíz del chat con `height: 100dvh` (con respaldo `100vh`) y estructura en tres filas: **cabecera fija · hilo (único scroll, `overscroll-behavior: contain`) · composer fijo**. La barra inferior **no se monta** aquí.
- Teclado virtual: usar `visualViewport` (`resize`/`scroll`) para ajustar la altura del contenedor y mantener el composer pegado sobre el teclado; el último mensaje queda visible; al enfocar el campo, el hilo conserva el anclaje al final **si ya estaba al final** (no saltar si la persona estaba leyendo mensajes antiguos; en ese caso mostrar un botón flotante «↓ Nuevos mensajes» con contador).
- Áreas seguras: `env(safe-area-inset-top/bottom/left/right)` en cabecera y composer.
- `font-size` de los campos de texto **≥ 16 px** en móvil (evita el zoom automático de iOS Safari).
- `touch-action`/`overscroll-behavior` para que arrastrar el hilo no mueva toda la página; sin scroll horizontal en ninguna pantalla.

### 8.3 Cabecera del chat
- Botón atrás (44×44 px), avatar, nombre (1 línea con elipsis), subtítulo con canal y quien atiende, y un botón «⋯» que abre una **hoja inferior** con las acciones existentes (aceptar/tomar, finalizar, transferir/compartir, etiquetas, programadas, ver contacto, agente de IA: pausar/reanudar). **Sin botón de llamada. Sin “en línea”.**
- «Ver contacto» abre el panel del contacto como **pantalla/hoja de pantalla completa** con botón cerrar (reutiliza el contenido de §6.2).

### 8.4 Hilo
- Burbujas con ancho máx. ~80 %, cola/redondeo diferenciado, hora y estado de entrega dentro de la burbuja, separadores de fecha pegajosos («Hoy», «Ayer», fecha), imágenes con vista ampliada, documentos y audio con controles de ≥ 44 px, reacciones sobre el mensaje, notas internas con estilo distinto y rótulo claro, mensajes automáticos con su etiqueta.
- Mensajes fallidos con acción «Reintentar» visible; mensajes en cola con indicador.
- Ventana de 24 h cerrada: el composer muestra el aviso y ofrece **Plantillas** (como hoy), no un campo muerto.

### 8.5 Composer móvil
- Fila: adjuntar · campo multilínea que crece hasta ~5 líneas · emoji · **enviar / nota de voz** (el botón se alterna: micrófono si el campo está vacío, enviar si hay texto; mantener la función de nota de voz existente).
- Acciones secundarias (plantillas, respuestas rápidas «/», programar, nota interna) en una **hoja inferior** abierta desde un botón «＋/…» **del composer** (no confundir con la barra de navegación, que ya no tiene «+»); la nota interna se distingue con color de fondo del composer y rótulo.
- El borrador por conversación se conserva al volver a la lista y al reabrir (en memoria durante la sesión; no se persiste en servidor).
- Enter inserta salto de línea en móvil; envía solo con el botón. En escritorio se mantiene el comportamiento actual.

### 8.6 Rendimiento percibido
- Transición lista → chat de ≤ 200 ms (desplazamiento horizontal sutil, desactivado con `prefers-reduced-motion`).
- Hilo: pintar primero los últimos mensajes ya en caché y completar; evitar re-renderizar toda la lista por cada mensaje nuevo (claves estables, `memo` donde se mida beneficio).
- No bloquear la interfaz por la consulta de respaldo ni por la reconexión del socket.

---

## 9. Accesibilidad y calidad de interacción (transversal)

- Foco visible en todo; orden de tabulación lógico; hojas y cajones con `role="dialog"`, `aria-modal`, foco atrapado/devuelto y cierre con Esc.
- Etiquetas `aria-label` en botones de solo icono; insignias con texto accesible («3 mensajes sin leer»).
- Contraste AA; no transmitir estado solo por color.
- Tamaños táctiles ≥ 44 px; separación ≥ 8 px entre objetivos adyacentes.
- Textos de interfaz: cortos, en español, el mismo nombre para la misma acción en todo el flujo.

---

## 10. FASE 6 — Viabilidad de «IA asistente en el composer» (solo documento, SIN implementar)

El responsable quiere evaluar un interruptor, **dentro de la información del contacto**, que active/desactive **respuestas sugeridas** en el composer. Entregar **solo** una propuesta `ADR-59` (PROPUESTO) con:

1. **Qué es:** sugerencia de borrador para la persona (no se envía sola, no es el agente autónomo existente). La persona la edita y envía.
2. **Reutilización:** `AIProvider`, `AgentTurnService`/composición de prompt con reglas fijas de «no inventar», búsqueda en la base de conocimiento (con `organization_id` y `agent_id`), créditos «reservar y liquidar» (tipo propio, p. ej. `suggest`), topes de uso, auditoría.
3. **Lo que NO cabe hoy sin backend:** endpoint nuevo (p. ej. `POST /v1/conversations/:id/ai/suggest`, con permiso, test de aislamiento A↔B, 404 uniforme) y **dónde guardar el interruptor** (por conversación, por persona o por contacto) → exige migración con RLS. Comparar opciones y recomendar una; indicar si conviene separarlo de `ai_conversation_state` (que es del agente autónomo) para no mezclar conceptos.
4. **Privacidad y seguridad:** el teléfono del cliente nunca entra al mensaje; la sugerencia se genera solo con datos que la persona ya ve; qué ocurre sin créditos; qué ocurre si la IA falla.
5. **UX propuesta:** interruptor en la pestaña/bloque de IA del panel de contacto; con él activo, aparece sobre el composer una tarjeta con el borrador y acciones «Usar» (lo copia al campo), «Descartar», «Regenerar»; indicador de costo en créditos si aplica; estado de carga y error.
6. **Costos y riesgos:** gasto de créditos por cada mensaje entrante, ruido/latencia, calidad sin validar contra OpenAI real.
7. **Recomendación** (hacerlo / posponer) y plan de rebanadas.

**No escribir código** de esta función ni un interruptor de maqueta.

---

## 11. Pruebas y validación (obligatorias)

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` y `pnpm e2e:web` en verde (ejecutar y pegar el resultado).
- Playwright con viewports de teléfono y tablet: **360×800, 375×812, 390×844, 412×915, 430×932, 768×1024, 1024×768, 1280×800, 1440×900**. Por cada una, comprobar sin scroll horizontal (`scrollWidth <= clientWidth`) en Inbox, Menú y chat.
- Casos mínimos:
  1. Móvil: barra inferior visible en lista/Inicio/Ventas/Agenda/Menú; **no existe** en `/inbox/:id`; reaparece al volver.
  2. Móvil: al volver del chat se conservan pestaña, búsqueda y posición de scroll de la lista.
  3. Móvil: el Menú muestra solo secciones permitidas para administrador y para asesor (usuarios de prueba existentes).
  4. Escritorio: arrastrar divisor, teclado en divisor, doble clic restaura, plegar/expandir, persistencia tras recargar, clave por persona/empresa distinta no se mezcla, mínimos respetados, el borrador del composer y el hilo **no se reinician** al redimensionar.
  5. Tablet: el cajón de contacto abre/cierra con Esc y devuelve el foco.
  6. Las pruebas E2E del Inbox existentes siguen pasando.
  7. Temas: índigo por defecto en cuenta nueva; cambio de tema en Configuración sigue funcionando; contraste AA del tema por defecto.
- **Declarar expresamente lo que NO se puede validar** sin dispositivo real: comportamiento del teclado virtual en iOS/Android reales, áreas seguras reales (notch/barra de gestos), rendimiento en gama baja, lectores de pantalla. No afirmar «validado» sin evidencia.

## 12. Método de entrega

- **Una fase por PR**, pequeña y revisable, con: qué, por qué, impacto en multi-tenancy/seguridad (debe ser «ninguno»), pruebas. Fases: **1** auditoría (parada) → **2** base visual + barra inferior + Menú → **3** escritorio/tablet con divisores → **4** lista móvil → **5** chat móvil → **6** documento ADR-59 de la IA asistente → **7** regresión y pulido.
- Entre fases 2→3→4→5 se puede seguir sin esperar aprobación **solo si** no hace falta tocar nada de §3. Si surge cualquier necesidad de API/BD/dependencia, **parar y preguntar**.
- Actualizar `CLAUDE.md` (estado del trabajo) y dejar el ADR-58 en el estado que corresponda; no marcar como «APROBADO» nada que no haya aprobado el responsable.

## 13. Informe final

Archivos modificados · componentes creados · componentes reutilizados · cambios de escritorio · cambios móviles · cómo funcionan los divisores y qué se guarda · comportamiento de la barra inferior y del Menú · pruebas ejecutadas (con resultado) · lo no validado · errores encontrados · pendientes y propuestas (incluidos los filtros rápidos que hoy no existen y el ADR-59).
