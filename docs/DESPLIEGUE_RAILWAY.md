# Despliegue en Railway (staging / piloto)

> Estado: **prueba de base de datos de ADR-30 ejecutada (2026-10-12)** y **despliegue de prueba en la URL pública de Railway** (correo y captcha en `none`, sin dominio propio; aún no abierto a usuarios). Resultado en la sección «Resultado de la prueba de ADR-30». Los valores marcados **«VALIDAR»** que siguen abiertos deben comprobarse en el primer despliegue.

## Resultado de la prueba de ADR-30 (2026-10-12, proyecto `virtuous-wonder`)
- **Imagen**: `ghcr.io/railwayapp-templates/postgres-ssl:18` → **PostgreSQL 18.6** (la CI usa PostgreSQL 16; la guía de producción debe decidir si se fija una versión o se sube la CI).
- **Superusuario real**: el rol `postgres` del servicio es `SUPERUSER`, con `CREATEROLE` y `CREATEDB` → el bootstrap funciona sin cambios.
- **pgvector**: disponible (`vector` 0.8.7); `CREATE EXTENSION vector` funciona (probado dentro de una transacción revertida; todavía no se instala porque ninguna migración lo usa).
- **Bootstrap**: `scripts/db-bootstrap.sh` con `DB_NAME=sales_smart` terminó bien. Los cuatro roles (`app_owner`, `app_rw`, `app_platform`, `app_identity`) quedan sin superusuario ni `BYPASSRLS`.
- **Migraciones**: `pnpm db:migrate` aplicó 17 migraciones; **`pnpm db:audit` sin violaciones de ADR-24**.
- **Acceso público TCP**: se activó solo para esta prueba y se **eliminó** al terminar (el Postgres se redesplegó sin `DATABASE_PUBLIC_URL`). Para tareas desde tu equipo (p. ej. `bootstrap:super-admin`) hay que reactivarlo temporalmente o usar `railway connect Postgres --tunnel-only`.
- **Variables de la app**: las tres URLs de rol usan el host privado con la referencia de Railway `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` (puerto 5432, base `sales_smart`); se cargan a mano en el servicio app. No existen `DATABASE_URL_OWNER`, `DATABASE_URL_ADMIN` ni `TOOLS_*` en ese servicio.
- **`TRUST_PROXY_HOPS` = 2 (no 1)**. Primer despliegue de prueba (`MAIL_PROVIDER=none`, `CAPTCHA_PROVIDER=none`, URL pública de Railway): con `1`, 59 inicios de sesión fallidos desde una misma IP nunca activaron el bloqueo por IP (umbral 25), mientras que el bloqueo por cuenta sí funcionaba → la IP que veía la API no era estable. Con `2`, los mismos intentos, cada uno con un `X-Forwarded-For` falso distinto, bloquearon desde el intento 26 (HTTP 429 con `Retry-After`): la IP real es estable y lo que escriba el cliente no cuenta. **Falta**: comprobar desde una segunda red (p. ej. el móvil con datos) que otro cliente no queda bloqueado por los intentos del primero.
- **Salud y cabeceras** (despliegue de prueba): `/health` y `/health/ready` OK; CSP, HSTS (`max-age=15552000; includeSubDomains`) y `X-Frame-Options: DENY` presentes; `/login` carga.
- **Pendiente de VALIDAR**: región/latencia (EU West, Ámsterdam, para usuarios en Ecuador), política de copias del plan y el envío real de correo. Antes de abrir a usuarios reales hay que pasar de `none` a `resend` y `turnstile`, registrar el dominio propio y rehacer el despliegue.

## Arquitectura (ADR-36)
Un servicio **app** (la API, que también sirve la web compilada) + un servicio **PostgreSQL**. Un dominio público (p. ej. `app.growthconsulting.digital`) apuntando al servicio **app**. No hay CORS.

## 1. Antes del primer despliegue: prueba de una hora de la base de datos (ADR-30)
Con el PostgreSQL de Railway creado, desde tu equipo (usa la URL pública/TCP proxy con el superusuario):
1. `DB_ADMIN_URL=<superusuario> DB_NAME=sales_smart APP_OWNER_PASSWORD=… APP_RW_PASSWORD=… APP_PLATFORM_PASSWORD=… APP_IDENTITY_PASSWORD=… bash scripts/db-bootstrap.sh` (cuatro contraseñas distintas y aleatorias).
2. `DATABASE_URL_OWNER=<app_owner> pnpm db:migrate` y luego `DATABASE_URL_OWNER=<app_owner> pnpm db:audit` → debe terminar **sin violaciones**.
3. **VALIDAR**: que el rol de administración pueda crear roles y bases (`CREATE ROLE`, `CREATE DATABASE`); si Railway no entrega superusuario real, hay que ajustar el bootstrap.
4. **VALIDAR**: región/latencia y política de copias de seguridad del plan elegido.

> Las migraciones y el bootstrap **no** se ejecutan desde el servicio de la app: la API se niega a arrancar si ve `DATABASE_URL_OWNER` en su entorno. Se corren desde tu equipo (o un job aparte) contra la base de Railway.

## 2. Servicio «app» (desde el repo de GitHub)
- **Build**: `pnpm install --frozen-lockfile && pnpm build` (compila `packages/shared`, la API y la web).
- **Start**: `node apps/api/dist/main.js`
- **Healthcheck**: `/health` (liveness) — `/health/ready` comprueba la base de datos.
- **Node 22**: `NIXPACKS_NODE_VERSION=22` (el repo trae `.nvmrc`). pnpm 10 (`packageManager` en `package.json`).
- **Variables** (todas obligatorias salvo las marcadas):

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL_APP` / `DATABASE_URL_PLATFORM` / `DATABASE_URL_IDENTITY` | URLs **internas** de Railway con cada rol (`app_rw`, `app_platform`, `app_identity`) |
| `AUTH_THROTTLE_KEY` | cadena aleatoria de 48+ caracteres (distinta de cualquier otra clave) |
| `WEB_DIST_DIR` | `apps/web/dist` |
| `FRONTEND_BASE_URL` | `https://app.growthconsulting.digital` (https, sin barra final; así se arman los enlaces de los correos) |
| `TRUST_PROXY_HOPS` | `2` — **validado en Railway el 2026-10-12** (con `1` el límite por IP nunca bloqueaba: hay dos proxies delante de la app; ver «Resultado de la prueba de ADR-30») |
| `MAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | clave de **solo envío** creada en Resend (ADR-37) |
| `MAIL_FROM` | `Sales Smart <no-reply@mail.growthconsulting.digital>` (la dirección debe pertenecer al dominio verificado en Resend) |
| `CAPTCHA_PROVIDER` | `turnstile` |
| `TURNSTILE_SECRET_KEY` | clave **secreta** del sitio de Turnstile |
| `VITE_CAPTCHA_PROVIDER` y `VITE_TURNSTILE_SITE_KEY` | `turnstile` y la clave de **sitio** (pública). Son variables de **compilación** (Vite las incrusta al construir la web): deben existir cuando corre `pnpm build`, y cambiarlas exige volver a construir |
| `PROVIDER_CREDENTIALS_KEY` | *(opcional por ahora, obligatoria antes de abrir a usuarios reales)* clave maestra que cifra las credenciales de los proveedores (ADR-42): **32 bytes en base64**, generada con `openssl rand -base64 32`, distinta de cualquier otra clave. Sin ella la API arranca (en producción avisa en el registro), pero «Proveedores» no puede guardar credenciales (responde 503) y tampoco Configuración › Conexiones (los tokens de los números de WhatsApp de cada empresa, M5.1/ADR-50; los cifra con esta misma clave). Para rotarla: la nueva pasa a esta variable con `PROVIDER_CREDENTIALS_KEY_VERSION` mayor y la anterior a `PROVIDER_CREDENTIALS_KEY_PREVIOUS` + `PROVIDER_CREDENTIALS_KEY_PREVIOUS_VERSION`. **Guárdala en un gestor de secretos aparte**: si se pierde, los secretos guardados no se pueden recuperar |
| `WHATSAPP_PROVIDER` | omitir (por defecto `meta`, el adaptador real). `fake` es solo para desarrollo y pruebas y la API **no arranca** en producción con él |
| `LOG_LEVEL` | `info` (opcional) |
| `JOBS_ENABLED` | omitir (encendido) — cuando exista un worker aparte, `false` en la API |

`HTTP_PORT` no hace falta: se usa el `PORT` que inyecta Railway. **No** definir `DATABASE_URL_OWNER`, `DATABASE_URL_ADMIN` ni `TOOLS_*` en este servicio.

## 3. Correo y anti-bots (ADR-37)
Los pasos de alta de **Resend** (dominio `growthconsulting.digital`: registros SPF/DKIM/DMARC en tu DNS) y de **Cloudflare Turnstile** (clave de sitio y clave secreta) están en `docs/ADR.md` (ADR-37). Las claves se escriben directamente en las variables de Railway; no se guardan en el repositorio.

## 4. Primer Súper Admin
Desde tu equipo, con las tres URLs de la app y `AUTH_THROTTLE_KEY` en el entorno:
`BOOTSTRAP_SUPER_ADMIN_EMAIL=tu@correo pnpm bootstrap:super-admin` → imprime la contraseña **una sola vez**; cámbiala al primer ingreso.

## 4b. WhatsApp oficial: webhook de Meta (M5.2, ADR-50)
Una sola aplicación de Meta para todas las empresas; solo el Súper Admin la configura:
1. En Plataforma › **Proveedores › WhatsApp oficial › Meta WhatsApp Cloud API › Configurar**: guarda el ID y el **secreto de la app** de Meta y un **token de verificación** (una cadena larga que inventas tú). Pulsa **Usar**. Requiere `PROVIDER_CREDENTIALS_KEY`.
2. En el panel de tu app de Meta (producto WhatsApp › Configuración del webhook): pega como **URL de devolución de llamada** la «Dirección del webhook» que muestra esa tarjeta (`<FRONTEND_BASE_URL>/v1/channels/meta/webhook`; por eso `FRONTEND_BASE_URL` debe ser la URL pública real) y el mismo **token de verificación**; al verificar, Meta llama a esa dirección y debe responder el desafío. Suscribe el campo **`messages`**.
3. Cada empresa conecta su número en Configuración › Conexiones (WABA ID, Phone number ID y token permanente). «Último aviso de Meta» en la conexión dice si los avisos están llegando.
4. **VALIDAR con credenciales reales** (hasta hoy solo se probó con firmas simuladas): que Meta verifique la dirección; que un mensaje real a un número conectado cree el contacto, la conversación y el mensaje (en unos segundos); que reenviar el mismo aviso no duplique; los `wa_id` de México y Argentina (prefijos 521 y 549); y si hace falta suscribir la app a cada cuenta de WhatsApp Business al conectar un número. Con la API en producción `WHATSAPP_PROVIDER` queda en `meta`.
5. **VALIDAR el envío con el número de prueba de Meta** (M5.4; hasta hoy solo se probó contra un servidor simulado): que responder a un cliente dentro de las 24 h salga y el mensaje pase a «Enviado», «Entregado» y «Leído» (los avisos de estado llegan por el mismo webhook, a veces antes de que anotemos el identificador: se reintentan 2 minutos); que un mensaje fuera de la ventana de 24 h falle con el código 131047 (la pantalla dice que solo valen plantillas); que un número destinatario inválido o sin WhatsApp quede «fallido» con su explicación (códigos 131026/131030/131021/133010); que un token vencido deje el error en Configuración › Conexiones; y el límite de envíos (130429/131056); que una reacción del cliente (un emoji) aparezca sobre el mensaje y que quitarla la borre (y si, en Meta, una reacción abre o no la ventana de 24 h: hoy NO la abrimos). Con la API apagada a mitad de un envío, el mensaje se reenvía al volver (puede repetirse: ver ADR-50, riesgo residual de M5.4).

6. **VALIDAR las plantillas con Meta real** (M5.6a; hasta hoy solo se probaron con un Meta simulado): que Configuración › Conexiones › «Plantillas» liste lo mismo que WhatsApp Manager (nombre, idioma, categoría, estado y motivo de rechazo); que una plantilla sin variables, una con variables en el cuerpo y una con botón de URL salgan al celular y pasen a Enviado, Entregado y Leído; que una pendiente o rechazada aparezca como «no se puede enviar» con su motivo; que una plantilla pausada o borrada en Meta falle con el texto de «ya no está disponible» (códigos 132001/132015/132016) y una con datos que no coinciden con el de «Meta no aceptó los datos» (132000/132005/132007/132012); que un mensaje que Meta no entrega por calidad (131049) quede «fallido»; que fuera de las 24 h solo se pueda enviar una plantilla; y el cobro por mensaje en la cuenta de Meta (la cuenta necesita medio de pago).

## 5. Lista de comprobación posterior al despliegue
1. `GET https://<dominio>/health/ready` → `{"status":"ok"}`.
2. Cabeceras de `GET /` (CSP, HSTS, `X-Frame-Options`) y que `/login` abra la pantalla.
3. Registro completo con un correo real: llega el código, se verifica y se entra.
4. Recuperar contraseña: llega el enlace y funciona una sola vez.
5. Cinco intentos fallidos con una cuenta bloquean **solo a esa cuenta**; otro usuario desde otra red puede entrar (valida `TRUST_PROXY_HOPS=2`). Si se cambia de hosting o Railway altera su cadena de proxies, repetir la prueba: 26+ fallos desde una IP deben dar 429 aunque el cliente envíe `X-Forwarded-For` falsos distintos.
6. `pnpm db:audit` contra la base de Railway sin violaciones.
7. **Antes de abrir a usuarios reales:** `PROVIDER_CREDENTIALS_KEY` definida (32 bytes en base64; una copia guardada en un gestor de secretos aparte) y en la pestaña «Proveedores» del Súper Admin ya no aparece el aviso de falta de clave.
