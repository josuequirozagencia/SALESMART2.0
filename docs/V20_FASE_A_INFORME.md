# V20 · Fase A — Informe de investigación (atribución de anuncios de Meta y eventos)

> Fecha: 2026-11-20. Solo lectura: **no se cambió código ni datos**. Se lee con `PROMPT_CODE_V20_ATRIBUCION_ANUNCIOS_META.md` y su addendum de Pasiel (el addendum manda en el orden).
> Fuentes: el repositorio (`main`), la base de staging (solo conteos y nombres de campos; ningún teléfono, texto ni token), y las herramientas de lectura de Meta sobre el dataset PASIEL SPA.
> Estado: **espera la aprobación de las decisiones de la §7 (ADR-55) antes de la Fase B.**

---

## 1. La tabla del §1 de V20 contra el repositorio

V20 se escribió el 2026-11-18, **antes** de que se revisara el trabajo de M6.6 (historial de toques y «Anuncio ganador»). Varias filas ya no son ciertas.

| Fila de V20 | V20 dice | Lo que hay en `main` | ¿Coincide? |
|---|---|---|---|
| Leer el origen del anuncio (oficial) | No existe | **Existe** (M6.6): `referralOf()` en `channels/meta-webhook.ts` lee `source_id`, `source_type`, `source_url`, `headline`, `body`, `thumbnail_url`, `ctwa_clid`; `ConversationsService.ingestInbound` lo pasa a `AttributionService.recordIn` con el contacto ya resuelto | **No** |
| Leer el origen (QR) | No existe | **Cierto.** `evolution-webhook.ts` solo lee `contextInfo.stanzaId` (citas); no lee `externalAdReply` | Sí |
| `POST /v1/attribution/ctwa/:id` | Construido; nadie lo llama | Cierto. Pasiel tiene 0 puntos de entrada | Sí |
| Guardar IDs de campaña, conjunto y anuncio | No existe | **Parcial:** hay `first_touch_ad_id` / `last_touch_ad_id` (M6.6) y la tabla `contact_touch_events` (`ad_id`, `ctwa_clid`, `headline`, `source_url`, `source`). **No hay** `campaign_id`, `adset_id`, `source_id`, `source_url` ni `headline` en `contacts` | **Parcial** |
| Primera atribución inmutable + última | Construido | Cierto (`applyTouch`) | Sí |
| Historial de clics | Se difirió (ADR-45) | **Existe** (M6.6, `contact_touch_events`, solo inserción). ADR-55 fase A estaba aprobada de palabra | **No** |
| Evento Lead | Construido | Cierto: `user_data = { ph (hash), ctwa_clid }` y `action_source = business_messaging` | Sí |
| Evento Contact / Qualified Lead | No construido | Cierto: el CHECK de `meta_events.type` es `Lead, Schedule, Purchase, SaleCanceled` | Sí |
| Schedule, Purchase, SaleCanceled | Construidos | Cierto. Un Purchase solo sale si el contacto es «atribuible» (tiene `ctwa_clid` y teléfono); si no, queda `skipped` | Sí |
| Salida real a Meta | Construida | Cierto (Graph v21.0). **Sin validar contra Meta real** | Sí |
| Panel «Origen del lead» | Parcial; no se encontró el texto «Atribución del anuncio no disponible» | Existe `AttributionSection.tsx` (colapsable, solo lectura). **El texto exacto no existe**: el componente simplemente no se muestra si no hay atribución | Sí |
| Nombres desde la API de Meta Ads | No existe | Cierto | Sí |
| Reporte por anuncio | No lo menciona | **Existe**: `GET /v1/analytics/winning-ads` (M6.6): por anuncio, chats, citas, ventas, ingresos y cierre | **No** |

**Dos discrepancias de contenido que conviene corregir en V20:**

1. **«Quita whatsapp_business_account_id» (V20 §2.A.6).** El código no lo quita: `withWaba()` en `attribution/capi-sender.service.ts` lo **agrega** al enviar, buscando la cuenta de WhatsApp Business del número por el que habló el contacto o, si no, la primera de la empresa. **Solo existe para WhatsApp oficial** (`whatsapp_accounts.waba_id`). Para una conversación por QR, y en una empresa sin cuenta oficial como Pasiel, no hay a dónde buscar y el evento sale **sin** esa cuenta. No es un error de código: es que QR no tiene cuenta de WhatsApp Business.
2. **El nombre del anuncio se está llenando con el `headline`.** En `ingestInbound`, `ad_name` recibe `referral.headline`. El titular del anuncio **no es el nombre del anuncio** (V20 §9: «no inventes nombres»). Hoy el panel y el reporte «Anuncio ganador» muestran ese titular como si fuera el nombre.

---

## 2. Datos reales de QR (Evolution v2.3.7) — Pasiel, últimos 30 días

Se contó sobre los avisos guardados de Pasiel (sin leer teléfonos ni textos):

| Medida | Valor |
|---|---|
| Avisos de mensajes con `contextInfo.externalAdReply` | **203** |
| …con `ctwaClid` | **199** (98 %) |
| …con `sourceId` (id del anuncio) | **203** (100 %) |
| …con `sourceUrl` | **203** (100 %) |
| Anuncios distintos (`sourceId`) | **12** |
| Avisos con anuncio cuyo contacto llegó como `@lid` | **0** |
| Origen (`sourceApp`), muestra 9–17 de nov. | instagram 80 · facebook 54 · otros 3 |

Conclusiones:

- **Evolution 2.3.7 SÍ entrega `ctwaClid`** en `externalAdReply` (el addendum pedía confirmarlo). Faltó en 4 de 203 avisos: hay que tratar su ausencia como caso normal.
- Campos reales de `externalAdReply`: `title`, `body`, `ctwaClid`, `sourceId`, `sourceUrl`, `sourceApp`, `mediaType` y `thumbnail` (bytes de un JPEG de ~1–2,5 KB). **No trae IDs de campaña ni de conjunto**: solo el del anuncio.
- Los clics de anuncio de Pasiel **no** llegaron como `@lid`: en esos 203 avisos el contacto vino con su teléfono. La premisa de V20 («justo los clics de anuncio se pierden por `@lid`») **no se cumple en Pasiel**. El arreglo de `@lid` (ADR-73, ya en `main`) sigue siendo útil, pero no es lo que bloquea la atribución.
- **Hoy esos 203 avisos no se leen**: Pasiel tiene 183 contactos, todos con canal «WhatsApp» y sin anuncio, campaña ni `ctwa_clid`; el historial de toques tiene 140 registros `message_in` y ninguno con `ad_id`.
- El aviso guardado repite la miniatura (un JPEG de 1,2 a 2,5 KB, como lista de números) en **cada** mensaje con anuncio. Son pocos KB, pero se repite por mensaje; para la fase de captura conviene guardarla una sola vez por anuncio.

**Oficial (Meta Cloud):** no hay una muestra real de un clic a un número oficial. Lo que el código lee sale de la documentación de Meta, sin validar con un aviso real. **Hace falta un clic de prueba a un número oficial (ver §8).**

---

## 3. ¿Quién envía hoy los Lead al dataset PASIEL SPA (1357632116190288)?

**Sales Smart no.** Hechos de la base de staging:

| Comprobación (Pasiel) | Resultado |
|---|---|
| Credenciales de la API de Conversiones guardadas (`meta_settings`) | **Ninguna** |
| Eventos de Meta encolados | 2 Purchase, ambos `skipped` (el contacto no tenía `ctwa_clid`) |
| Conexión con GoHighLevel | **Ninguna** |
| Punto de entrada de atribución (`/attribution/ctwa`) | **Ninguno** |
| Formularios | 1 formulario, **0 envíos** |
| Ventas / citas | 2 / 0 |

Lo que se ve en Meta (herramientas de lectura, dataset PASIEL SPA):

- Activo; **todos los eventos de los últimos 7 días son de servidor** (`SERVER`), sin eventos de navegador en ese tramo.
- Desde el 27-oct: **≈210 Lead** (63 el 27-oct y 21 el 28-oct, es decir **antes** de que Pasiel conectara su QR a Sales Smart el 9-nov), **10 Schedule**, 23 PageView y 22 ViewContent (el Pixel de una página web, en días sueltos), **0 Purchase**.
- Calidad de coincidencia del Lead: **3,4/10**; teléfono 100 %, país 100 %, nombre 100 %, apellido 33 %. Sales Smart no envía nombre, apellido ni país (solo `ph` con hash y `ctwa_clid`), así que **estos Lead no salen de Sales Smart**.
- La configuración del dataset no indica qué integración envía los eventos.

**No puedo identificar la fuente con las herramientas de lectura.** Candidatos por descarte: una integración de otra herramienta (por ejemplo un GoHighLevel propio de la agencia fuera de Sales Smart, un chatbot o un CRM) que envía por la API de Conversiones con nombre y país. **Pregunta para el responsable (§8):** qué herramientas envían eventos a PASIEL SPA; se ve en el Administrador de eventos › PASIEL SPA › Configuración (integraciones / fuentes de datos).

**Consecuencia (addendum §6):** hasta saberlo, **no se activa el envío de Lead propio**. Sí se pueden activar Purchase y SaleCanceled (hay 0 Purchase en Meta y nadie más los envía).

---

## 4. Qué exige Meta para eventos de mensajería (V20 §2.A.6)

De la documentación pública de [Conversions API for Business Messaging](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging) (a verificar al llegar a la Fase D; esta lectura es parcial):

- `action_source = business_messaging` y `messaging_channel = whatsapp` (ya los enviamos).
- En `user_data`, para WhatsApp: `ctwa_clid` (ya) y la **cuenta de WhatsApp Business** (`whatsapp_business_account_id`); la guía de incorporación habla de obtener el dataset desde esa cuenta y de permisos `whatsapp_business_management` y `whatsapp_business_manage_events`.
- Los tipos de evento admitidos en mensajería, según la propia guía, son **Lead y Purchase** (no se confirmó que Schedule, Contact o Qualified Lead se acepten como mensajería).
- Meta no deduplica estos eventos: hay que evitar el solapamiento antes de enviar.

**Implicación para QR (addendum §2):** un número QR no tiene cuenta de WhatsApp Business de Meta, así que **no está garantizado** que Meta acepte o atribuya el evento. Se prueba (§4 del addendum, con `test_event_code`); no se asume.

---

## 5. Tabla: campo → oficial / QR / guardado hoy / faltante

| Campo | Oficial (Meta Cloud) | QR (Evolution 2.3.7) | Guardado hoy | Falta |
|---|---|---|---|---|
| Click ID (`ctwa_clid`) | `referral.ctwa_clid` (doc. Meta; sin muestra real) | `externalAdReply.ctwaClid` (199/203) | Oficial: sí (`contacts.ctwa_cl_id`, toques). QR: **no** | Lector de QR |
| ID del anuncio | `referral.source_id` | `externalAdReply.sourceId` (203/203) | Oficial: sí (`*_touch_ad_id`, `contact_touch_events.ad_id`). QR: **no** | Lector de QR |
| URL de la fuente | `referral.source_url` | `externalAdReply.sourceUrl` (203/203) | Solo en el historial de toques (oficial). **No** en `contacts` | Columna en `contacts`; QR |
| Tipo de fuente (anuncio / publicación) | `referral.source_type` | No existe como campo | No | Solo oficial |
| Titular | `referral.headline` | `externalAdReply.title` | `contact_touch_events.headline`; **y se usa como «nombre del anuncio»** (ver §1) | Separar titular de nombre |
| Texto del anuncio | `referral.body` | `externalAdReply.body` | `contact_touch_events` (oficial) | QR |
| Miniatura | `referral.thumbnail_url` (URL de Meta; la política de contenido no permite mostrarla) | `thumbnail` (JPEG en bytes) | No | Guardar una vez por anuncio (decisión §7.3) |
| Plataforma (Facebook / Instagram) | No viene como campo claro | `sourceApp` (`facebook` / `instagram`) | Solo el canal derivado del `placement` (oficial) | QR: derivar el canal de `sourceApp` |
| ID de campaña / de conjunto | **No lo entrega** | **No lo entrega** | No (solo nombres opcionales por el punto de entrada) | **Marketing API** a partir del `source_id` (decisión §7.3) |
| Nombre de campaña / conjunto / anuncio | No lo entrega | No lo entrega | Solo si llegan por el punto de entrada, que nadie llama | Marketing API |
| Cuenta de WhatsApp Business | `whatsapp_accounts.waba_id` (se agrega al enviar) | **No existe** | Oficial: sí | Limitación de QR |
| Teléfono resuelto con `@lid` | Siempre trae teléfono | Los clics de Pasiel traen teléfono | Contactos `@lid`: ADR-73 | — |

---

## 6. Riesgos y hallazgos para el diseño

1. **QR puede atribuir en Sales Smart sin que Meta lo acepte.** Los dos objetivos son distintos (addendum §2): ver de qué anuncio vino la venta **dentro de Sales Smart** solo necesita guardar `sourceId`/`ctwaClid` (disponibles en QR); que **Meta** cruce el evento con el anuncio depende de lo que acepte para un número sin cuenta de WhatsApp Business.
2. **El Lead que ya llega a PASIEL SPA viene de otra fuente.** Enviar el nuestro duplicaría el conteo.
3. **EMQ 3,4 y qué mejoraría:** hoy Sales Smart enviaría solo `ph` y `ctwa_clid`; añadir nombre, apellido (si lo hay), país y `external_id`, con hash y solo con datos reales (addendum §5).
4. **Purchase de Pasiel:** hay 2 ventas y 2 Purchase `skipped`, porque esos contactos no tienen `ctwa_clid`. Con el lector de QR (Fase C) los clics nuevos sí quedarían atribuibles; las ventas viejas, no (no tienen clic guardado), salvo la recuperación de los avisos de los últimos 30 días.
5. **Los avisos se borran a los 30 días** (redacción de privacidad): la recuperación de los clics ya recibidos debe hacerse antes de que caduquen.

---

## 7. Decisiones que necesito del responsable (ADR-55)

Las cinco de V20 §5, con mi recomendación a la luz de lo medido:

1. **Fuente de los clics.** Recomiendo **(a) captura directa desde WhatsApp**, **QR primero** (Pasiel manda) y oficial en paralelo. Sin depender de un workflow externo.
2. **Historial de clics.** Ya existe (M6.6, `contact_touch_events`); basta con aprobar que QR escriba en él.
3. **Nombres, campaña y conjunto desde Meta Ads.** El mensaje **no trae** campaña ni conjunto, solo el ID del anuncio. O (a) mostrar solo el ID, el titular y el texto que llegan (recomendado ahora), o (b) integración de **lectura** con la Marketing API (permiso nuevo del cliente) para traducir el `source_id` a anuncio, conjunto y campaña. Sin (b), el reporte por campaña y por conjunto del addendum §7 no es posible: quedaría **por anuncio**.
4. **Contact y Qualified Lead.** No se envían sin definir cuándo (propuesta de V20: Contact al primer mensaje humano del cliente; Qualified Lead al mover la oportunidad a una etapa marcada como calificada). Además, la documentación de Meta para mensajería lista **Lead y Purchase** como eventos admitidos: conviene validar si Contact y Qualified Lead se aceptan antes de construirlos.
5. **Lead de contactos creados a mano o importados:** no se envían (regla actual). Confirmar.

Decisiones nuevas que salieron de la investigación:

6. **Titular ≠ nombre del anuncio.** Dejar de rellenar el «nombre del anuncio» con el titular y mostrar «Titular» como lo que es (corrige lo ya construido en M6.6).
7. **Miniatura:** guardarla **una vez por anuncio** (JPEG de ~2 KB, ya viene en el aviso) y quitarla de los avisos guardados, para mostrar el anuncio ganador con imagen. (El responsable ya confirmó en el chat que le interesa la miniatura para el «anuncio ganador».)
8. **Recuperación de los avisos ya guardados** (los 203 de Pasiel y los de otras empresas en sus 30 días): atribuir a los contactos existentes **sin** enviar a Meta lo que tenga más de 7 días. Confirmado de palabra por el responsable.
9. **No activar el Lead propio hacia PASIEL SPA** hasta saber qué otra herramienta lo envía (addendum §6).

---

## 8. Lo que necesito de ti (el responsable)

1. **Qué herramienta(s) envían Lead a PASIEL SPA.** Mira el Administrador de eventos › Orígenes de datos › PASIEL SPA › Configuración (integraciones / socios) o dime qué usan hoy (GoHighLevel de la agencia, un chatbot, otro CRM).
2. **Un clic de prueba a un número de WhatsApp OFICIAL** (de cualquier cliente de la agencia con API oficial): hace falta un aviso real con `referral` para comparar y para que Meta lo valide. Para QR **ya tengo 203 clics reales de Pasiel**, así que no hace falta otro clic para la Fase A; lo pediré para la validación con `test_event_code` de la Fase D.
3. **Las decisiones de la §7** (con tu «sí» a las recomendaciones basta).
4. **El token del dataset de PASIEL SPA** solo se necesitará en la Fase D, para pegarlo en Configuración › API de Conversiones. No lo pegues aquí.

## 9. Sin validar contra Meta real

`referral` de un número oficial con un aviso real · aceptación y atribución de eventos de un número QR por Meta · formato de `user_data` para mensajería (la lectura de la documentación fue parcial) · permisos del token · calidad de coincidencia tras añadir nombre, apellido, país y `external_id` · quién envía hoy Lead a PASIEL SPA · la lectura de la fuente `sourceApp` en todos los clics (la muestra es de 9–17 de noviembre).
