# Despliegue en Railway (staging / piloto)

> Estado: **guía sin ejecutar**. ADR-30 (hosting) y ADR-36 (un solo origen) están aprobados, pero todavía no se ha desplegado nada ni se hizo la prueba de una hora de roles/RLS/pgvector. Los valores marcados **«VALIDAR»** deben comprobarse en el primer despliegue.

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
| `TRUST_PROXY_HOPS` | `1` — **VALIDAR** (dos peticiones desde IPs distintas no deben compartir contador de intentos) |
| `MAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | clave de **solo envío** creada en Resend (ADR-37) |
| `MAIL_FROM` | `Sales Smart <no-reply@mail.growthconsulting.digital>` (la dirección debe pertenecer al dominio verificado en Resend) |
| `CAPTCHA_PROVIDER` | `turnstile` |
| `TURNSTILE_SECRET_KEY` | clave **secreta** del sitio de Turnstile |
| `VITE_CAPTCHA_PROVIDER` y `VITE_TURNSTILE_SITE_KEY` | `turnstile` y la clave de **sitio** (pública). Son variables de **compilación** (Vite las incrusta al construir la web): deben existir cuando corre `pnpm build`, y cambiarlas exige volver a construir |
| `LOG_LEVEL` | `info` (opcional) |
| `JOBS_ENABLED` | omitir (encendido) — cuando exista un worker aparte, `false` en la API |

`HTTP_PORT` no hace falta: se usa el `PORT` que inyecta Railway. **No** definir `DATABASE_URL_OWNER`, `DATABASE_URL_ADMIN` ni `TOOLS_*` en este servicio.

## 3. Correo y anti-bots (ADR-37)
Los pasos de alta de **Resend** (dominio `growthconsulting.digital`: registros SPF/DKIM/DMARC en tu DNS) y de **Cloudflare Turnstile** (clave de sitio y clave secreta) están en `docs/ADR.md` (ADR-37). Las claves se escriben directamente en las variables de Railway; no se guardan en el repositorio.

## 4. Primer Súper Admin
Desde tu equipo, con las tres URLs de la app y `AUTH_THROTTLE_KEY` en el entorno:
`BOOTSTRAP_SUPER_ADMIN_EMAIL=tu@correo pnpm bootstrap:super-admin` → imprime la contraseña **una sola vez**; cámbiala al primer ingreso.

## 5. Lista de comprobación posterior al despliegue
1. `GET https://<dominio>/health/ready` → `{"status":"ok"}`.
2. Cabeceras de `GET /` (CSP, HSTS, `X-Frame-Options`) y que `/login` abra la pantalla.
3. Registro completo con un correo real: llega el código, se verifica y se entra.
4. Recuperar contraseña: llega el enlace y funciona una sola vez.
5. Cinco intentos fallidos con una cuenta bloquean **solo a esa cuenta**; otro usuario desde otra red puede entrar (valida `TRUST_PROXY_HOPS`).
6. `pnpm db:audit` contra la base de Railway sin violaciones.
