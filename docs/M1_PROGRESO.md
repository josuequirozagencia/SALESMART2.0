# M1 — Progreso

## Rebanada M1.1 — Sesiones y login (2026-10-04)

### Qué se implementó
- **Tablas** (identidad, ADR-25): `sessions`, `auth_throttle`; `users.session_version`. Migraciones `0003` (generada) y `0004` (GRANT SELECT/INSERT/UPDATE solo a `app_identity`, REVOKE a `app_rw`/`app_platform`). Catálogo del auditor actualizado.
- **Módulo `modules/auth`**: `tokens` (opacos + SHA-256 + comparación en tiempo constante), `SessionService` (crear / autenticar / refrescar con bloqueo de fila / cerrar), `ThrottleService` (UPSERT atómico, HMAC), `AuthService.login` (verificación Argon2id siempre, también para cuentas inexistentes), `AuthController` (`POST /auth/login|refresh|logout`, todas `@Public()`), `LocalAccessResolver` (reemplaza a DenyAll en `AppModule`).
- **Config**: `AUTH_THROTTLE_KEY` obligatoria (≥32 caracteres, sin valor por defecto); `dev:setup` la genera; `.env.example` y tests actualizados.
- **Errores**: `TooManyAttemptsError` → 429 con `Retry-After`.
- ADR-26 (propuesto) con las decisiones y riesgos.

### Pruebas: 304 + 6 e2e en verde; lint y typecheck limpios; `pnpm audit` limpio
`test/auth/auth.test.ts` (31): login (cookie HttpOnly/SameSite/Path, cuerpo sin refresh, error genérico idéntico para 5 casos, campos desconocidos, solo hashes en BD) · bloqueo (5.º fallo → 429 aun con la contraseña correcta, correos inexistentes, cuentas independientes, espera creciente, reinicio, claves sin datos en claro) · resolvedor (401 genérico, **A↔B: la organización sale de la sesión aunque la petición pida otra**, token de A con id de B, super_admin vs tenant/plataforma, 8 efectos inmediatos: membresía revocada, usuario desactivado/eliminado, versión de sesión, organización suspendida, sesión revocada, access y sesión vencidos) · refresh (rotación, reutilización → sesión revocada, concurrencia → solo uno rota, CSRF por cookie, estado inválido, access≠refresh) · logout (idempotente, no cierra sesiones ajenas).
**Mutaciones (revertidas):** quitar el filtro de membresía revocada → falla; quitar la revocación por reutilización → falla; logout sin verificar el hash del token → falla.

### Riesgos / pendiente de decisión tuya
Ver ADR-26 (refrescos simultáneos legítimos, consulta por petición, `trust proxy`, limpieza sin DELETE, versionado `/v1`).
No hay todavía registro, verificación de correo, reset de contraseña, RBAC, auditoría ni pruebas de 7 días (M1.2–M1.5). Correo, captcha, pasarela, hosting y valores provisionales siguen abiertos y no se tocaron.


## Correcciones de M1.1 solicitadas por Josué (2026-10-04, ADR-26 aprobado con ajustes)

1. **Refresh de un solo uso, sin ventana de gracia**: se mantiene el comportamiento estricto y se **prueba y documenta la concurrencia** (ver ADR-26 «Concurrencia del refresh»). Tests nuevos: 2 refrescos concurrentes → exactamente `[200, 401]` y la sesión queda revocada (también los tokens del ganador); 12 concurrentes → 1 rotación; reutilización inmediata; bloqueo de fila (el refresh espera a otra transacción); rotación atómica con rollback ante fallo simulado (trigger) — el token anterior sigue siendo válido.
2. **`/v1`**: prefijo global en `configureApp` (excepto `/health`, `/health/ready`). Endpoints: `/v1/auth/login|refresh|logout`; la cookie de refresh usa `Path=/v1/auth`. Tests: existen bajo `/v1` y devuelven 404 sin prefijo (app Nest y proceso real en e2e); el registro de endpoints y el descubrimiento de rutas usan `/v1`.
   - **Hallazgo corregido durante el cambio:** con prefijo global, una ruta inexistente fuera de `/v1` caía en el 404 HTML de Express (sin `request_id`, revela la tecnología) y `/health` perdía `x-request-id` (el middleware de Nest solo cubría `/v1`). Ahora `x-request-id` se asigna en un middleware de Express de `configureApp` y un 404 JSON estándar cierra la cadena. Tests: `app-boot` (3 rutas inexistentes, `x-request-id` en todas las respuestas) y e2e.
3. **Se mantienen**: sesiones opacas en BD, revalidación de usuario/organización/membresía, throttle en PostgreSQL, `AUTH_THROTTLE_KEY`, errores uniformes. Correo y CAPTCHA siguen sin proveedor (se implementarán como interfaces con fakes en M1.2).
4. **Parámetros provisionales ahora configurables** por entorno (`AUTH_*`, con rangos y validaciones cruzadas; test de configuración) y marcados `PROVISIONAL` en el esquema.
5. **Limpieza de `sessions`/`auth_throttle`**: documentada como requisito previo a producción; **no** se otorgó DELETE a `app_identity`.

### Resultados
`pnpm check`: **320 tests en verde** (19 archivos), typecheck y lint limpios · `pnpm e2e`: **7 en verde** (incluye login → refresh → reutilización contra el proceso compilado) · `pnpm audit`: sin vulnerabilidades.
Mutaciones (revertidas): quitar `FOR UPDATE` del refresh → fallan los 2 tests de concurrencia; (anteriores) filtro de membresía revocada, revocación por reutilización, verificación de hash en logout.
M1.2: ver sección siguiente.


## M1.2 — Registro y verificación de correo (2026-10-04) · APROBADA con ajustes (contraseña mínima 8; lista pública de dominios desechables cargada)

**Qué hay:** `POST /v1/auth/signup` (202), `/verify` (200), `/resend` (202); tablas `email_verifications`, `signup_attempts`, `disposable_domains` (migraciones 0005–0006, sin DELETE para `app_identity`; `disposable_domains` solo SELECT); puertos `MailProvider`/`CaptchaVerifier` con fakes `memory`/`console`/`fake` y variantes «sin proveedor» (503); configuración `MAIL_PROVIDER`, `CAPTCHA_PROVIDER`, `SIGNUP_*` (PROVISIONALES, rechazo de fakes en producción). Decisiones y alternativas en **ADR-27**.

**Supuestos que hice explícitos (corrígelos si no te sirven):** código de 6 dígitos / 15 min / 5 intentos; verificación **no** abre sesión; organización creada al verificar con la zona horaria enviada por el navegador (UTC si falta); contraseña mínima 8 caracteres (definido por Josué), sin reglas de composición; lista de dominios desechables **vacía** (sin fuente elegida).

**Pruebas nuevas (`test/auth/signup.test.ts`, 22; `config.test.ts` +2):** flujo completo signup→verify→login; solo HMAC/Argon2id en BD (ni código, ni contraseña, ni correo en contadores); respuesta uniforme (correo nuevo / cuenta activa); la cuenta activa no cambia contraseña ni recibe código ni con el cooldown vencido; re-registro de pendiente; CAPTCHA inválido; dominios desechables; validación; error de verify idéntico en 5 causas; 5 intentos queman el código; reenvío invalida el anterior; 6 verify simultáneos → 1 organización; verify espera el bloqueo de fila; límites por correo/IP (429 + Retry-After); fallo del proveedor de correo → 202 y reenvío; aislamiento entre dos registros; permisos (`app_identity` sin DELETE/TRUNCATE ni escritura en `disposable_domains`); 503 sin proveedores; CAPTCHA `none` falla cerrado.
**Mutaciones:** sin incremento de intentos → falla el test de quemado; sin la regla «cuenta activa» → fallan 2 tests (el primero NO lo detectaba por el cooldown: se reforzó); quitar `FOR UPDATE` no cambia el resultado porque el consumo condicional garantiza una sola organización (el bloqueo queda como optimización, cubierto por el test de espera de fila).

### Resultados
`pnpm check`: **344 tests en verde** (20 archivos), typecheck y lint limpios · `pnpm e2e`: **7 en verde** · `pnpm audit`: sin vulnerabilidades.

### Pendiente / riesgos
Proveedor de correo y de CAPTCHA, fuente de dominios desechables y plantilla del correo (abiertos). Limpieza de `email_verifications`/`signup_attempts`/`sessions`/`auth_throttle` antes de producción (M1.5). Registro sobre correo pendiente reemplaza el registro anterior (ADR-27). `req.ip` sin `trust proxy`: los límites por IP agruparían clientes detrás de un proxy.


**Ajustes tras la aprobación de M1.2:** contraseña mínima por defecto **8** (`8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128`; **corrección:** el reporte anterior decía «desde 6» y el código aceptaba 6–64, lo cual contradecía el requisito aprobado; corregido y probado). Lista de dominios desechables: `data/disposable_email_blocklist.conf` (9 203 dominios, lista pública `disposable-email-domains`, CC0) y comando `pnpm db:load-disposable-domains` (rol propietario, idempotente; la API solo tiene SELECT). Hay que ejecutarlo tras migrar y repetirlo periódicamente; la lista no es exhaustiva. Pruebas: parseo, archivo íntegro (>3000 dominios, 0 descartados) y carga idempotente.

## M1.3 — Olvido, restablecimiento y cambio de contraseña (2026-10-04) · pendiente de aprobación

**Qué hay:** `POST /v1/auth/forgot` (202 uniforme, CAPTCHA, límites por IP y correo), `POST /v1/auth/reset` (token de un solo uso; error 400 uniforme), `POST /v1/auth/password` (autenticado, nuevo acceso `@SelfService`). Tabla `password_resets` (migraciones 0007–0008, sin DELETE); `MailProvider.sendPasswordReset`; parámetros `RESET_*` PROVISIONALES. Decisiones en **ADR-28**.

**Supuestos que hice explícitos:** token caduca a 30 min; restablecer revoca todas las sesiones y levanta el bloqueo por intentos de la cuenta; el cambio voluntario conserva la sesión actual y cierra las demás; no hay correo de aviso «tu contraseña cambió» (falta proveedor/plantilla); el enlace se construye en el servidor con `FRONTEND_BASE_URL` (configuración explícita, nunca derivada del Host de la petición) y el token va en el fragmento `#token=`.

**Pruebas (`test/auth/password.test.ts`, 21):** flujo completo con sesiones previas revocadas y `session_version`; solo SHA-256 del token en BD; forgot uniforme (inexistente/pendiente/desactivada/activa); error de reset idéntico en 6 causas; contraseña corta no consume el token; nuevo forgot invalida el anterior y respeta cooldown; 6 reset simultáneos → 1; levanta el bloqueo de login; CAPTCHA/fallo del correo; límite por correo; validación estricta; cambio: requiere sesión, conserva la actual y revoca las demás (también `revoke_reason`), contraseña actual errónea cuenta para el bloqueo (429), nueva ≠ actual, **sin ids ajenos (A↔B)**, Súper Admin puede cambiar la suya; permisos de `password_resets`; 429 por IP; 503 sin proveedores.
**Mutaciones (todas revertidas):** sin subir `session_version` → 2 fallos; sin actualizar la sesión actual → falla; sin `recordFailure` → falla; sin comparar el hash del token → falla; sin comprobar el estado del usuario → falla; sin levantar el bloqueo → falla; la revocación explícita de otras sesiones es redundante con `session_version` (defensa en profundidad, cubierta por el assert de `revoke_reason`).

### Resultados
`pnpm check`: **401 tests en verde** (22 archivos; 369 antes de la corrección), typecheck y lint limpios · `pnpm e2e`: **7 en verde** · `pnpm audit`: sin vulnerabilidades.

### Pendiente / riesgos
Proveedor de correo (plantilla, aviso de cambio), valor real de `FRONTEND_BASE_URL`, CAPTCHA. Limpieza de `password_resets` y demás tablas de identidad antes de producción (M1.5). `trust proxy`.


### Corrección posterior al reporte de M1.3 (2026-10-05)
Error mío: el esquema aceptaba `SIGNUP_PASSWORD_MIN_LENGTH` entre 6 y 64 y yo lo documenté como «configurable desde 6»; el requisito aprobado es **8 ≤ valor ≤ 128**. Corregido en `config/env.schema.ts` (`PASSWORD_MIN_LENGTH_FLOOR = 8`, techo 128), `.env.example`, ADR-27/ADR-28, este documento y los tests. No había otra configuración (dev-setup, CI, e2e, tests) que fijara un valor inferior a 8; ADR-26 y `M1_PLAN` no mencionaban la longitud. Tests nuevos (`config.test.ts`): rechazan -1, 0, 1, 5, 6, 7, 7.9, vacío, 129, 1000 y no numéricos; el esquema rechaza todo entero de -5 a 7; aceptan 8, 9, 12, 64 y 128; por defecto 8. Mutación comprobada: con el suelo en 6 los tests fallan.
**URL base del frontend:** nueva `FRONTEND_BASE_URL` (+ `RESET_LINK_PATH`, por defecto `/reset-password`), explícita y obligatoria si `MAIL_PROVIDER != none`; valida http(s), sin credenciales/query/fragmento, https en producción. `forgot` responde 503 si no está configurada. Test: `Origin`, `Referer`, `X-Forwarded-Host/Proto` hostiles no alteran el enlace.
Parámetros de M1.3 sin cambios: token de un solo uso, TTL 30 min, 3/h por correo, 10/h por IP, anti-enumeración, revocación de todas las sesiones tras el reset, sin auto-login, el cambio voluntario conserva la sesión actual y revoca las demás.


## M1.4 — RBAC y auditoría (2026-10-05) — APROBADA 2026-10-05 (matriz PROVISIONAL)
**Hecho:** catálogo de 33 permisos (`src/rbac`), tablas `roles/permissions/role_permissions` sembradas por migración (0009–0010), `PermissionService`, `@RequirePermission` + comprobación en `AccessGuard`, `audit_logs` (tenant, RLS+FORCE, append-only) con `writeAudit`/`AuditService`, `platform_audit` con `PlatformAuditService`, cambio de contraseña auditado. El registro de endpoints ahora exige permisos del catálogo en toda ruta tenant/platform.
**Pruebas:** `rbac.test.ts` (14: 401/403 genérico, sin escalada por cabeceras/cuerpo, ámbito de permisos, matriz) y `audit.test.ts` (13: append-only, RLS A↔B, atomicidad, redacción, plataforma). Mutaciones comprobadas (se revierten): quitar la comprobación del guard (6 fallos), quitar el control de ámbito (1), dar UPDATE a `app_rw` sobre `audit_logs` (1).
**Resultados:** `pnpm check` **430 tests en verde**, typecheck y lint limpios · `pnpm e2e` 7 en verde · `pnpm audit` sin vulnerabilidades.
**Ajustes durante la implementación:** `FORCE RLS` de `audit_logs` movido a la migración 0009 (el escáner lo exige en el mismo archivo; migración aún no publicada); `PlatformAuditService.record` pasó a `async`.
**Pendiente / riesgos:** matriz PROVISIONAL (confirmar); limpieza de tablas de identidad antes de producción; `trust proxy`; correo/CAPTCHA/URL del frontend sin decidir; sin consulta de auditoría en la UI.


## M1.5 — Pruebas de 7 días, extensión única, vencimiento y cuenta en pausa (2026-10-09) · APROBADA (2026-10-09; ADR-33 aprobado)
Decisión de Josué (2026-10-09): las tareas periódicas usan **PostgreSQL con `FOR UPDATE SKIP LOCKED`**, sin Redis/BullMQ por ahora. Decisiones y límites en **ADR-33 (PROPUESTO)**.

**Qué hay**
- **Datos** (migraciones `0011_trials`, `0012_trials_grants_seed`; tablas de identidad, `app_identity`): `trials` (una por organización; la extensión es parte de la fila), `trial_config` (una fila sembrada: 7 / 3 / 30 días y 1000 créditos de bienvenida inertes, todo PROVISIONAL). `CHECK trials_ext_consistent` + trigger `trials_ext_transition` (solo `none → pending → approved|denied`, campos inmutables, decisión no editable). Sin `DELETE` para nadie; `trial_config` solo `SELECT`.
- **Alta**: la prueba nace en la misma transacción que la organización, **al verificar el correo**, con la duración de `trial_config`.
- **Endpoints**: `GET /v1/trials/me` (`@SelfService`: estado de la prueba de la organización del principal), `POST /v1/trials/me/extension` (202; `billing.manage`; única), `GET /v1/platform/trials` (filtros `extension`, `state`; cursor; `pending_extensions` para la insignia), `POST /v1/platform/trials/:id/approve|deny` (`platform.trials.manage`). Aprobar antes de vencer suma al fin vigente; ya vencida cuenta desde la aprobación y reactiva la cuenta.
- **Cuenta en pausa**: el resolvedor marca `Principal.paused` (por la hora, no por el estado) y el guard responde `403 TRIAL_EXPIRED` en las rutas de tenant, salvo `@AllowWhenPaused` y `@SelfService`.
- **Tareas periódicas** (`src/jobs`): `JobRunner` + `trial-expiry` (lotes de 100 con `SKIP LOCKED`). `JOBS_ENABLED`, `JOBS_TRIAL_EXPIRY_INTERVAL_SECONDS` (PROVISIONAL).
- **Auditoría**: solicitud → `audit_logs` de la organización; decisiones → `platform_audit` (sin el motivo). Se escribe tras el commit (ADR-33 #6).

**Pruebas nuevas (51):** `test/trials/trials.test.ts` (33: alta al verificar con duración de `trial_config`; `/trials/me` solo la propia, sin ids ajenos, 404 para Súper Admin/sin prueba; pausa por la hora y por estado, rutas abiertas, reapertura con el mismo token; solicitud: permisos, validación, **una sola** en pending/approved/denied, **6 simultáneas → 1×202 + 5×409**, A↔B; consola: 401/403, filtros, cursor sin repetidos ni huecos, aprobar antes/después de vencer, días desde `trial_config`, denegar, 404/409/400, **aprobar y denegar a la vez → una gana**; auditoría; CHECK y trigger de la BD; privilegios de los 3 roles; job: idempotente, lotes, **SKIP LOCKED** (no espera una fila bloqueada), tres ejecuciones simultáneas sin duplicar ni perder, carrera con una aprobación), `trial-domain.test.ts` (6), `job-runner.test.ts` (6: apagado, periódico, sin solapamiento, fallo → reintento, runOnce, cierre ordenado), `config.test.ts` (+6). Registro de endpoints, catálogo de fixtures y superficie del barrel de `db/` actualizados.
**Mutaciones (revertidas):** guard sin la comprobación de pausa → 3 fallos; sin `SKIP LOCKED` → 2 fallos; aprobar sin reactivar → 2 fallos.

### Resultados y entorno de verificación (léelo)
Typecheck y lint (`--max-warnings 0`) limpios; `drizzle-kit generate` → «No schema changes»; `db:audit` (cobertura de políticas) limpio con `trials` y `trial_config`.
Suite completa: **469 tests en verde, 4 omitidos y 8 fallos que NO vienen de este cambio** sino del entorno donde la corrí (Windows, **Node 24 y PostgreSQL 13** efímero, no Node 22 / PostgreSQL 16 de la CI): `security_invoker` no existe en PG 13 (1); en PG 13 `PUBLIC` puede crear tablas en `public` (5: `roles` ×2, `identity` ×1 y la tabla `evil` que esa prueba deja y contamina a `policy-coverage` ×2 — corriendo `policy-coverage` sola, esas dos pasan); y `spawnSync('pnpm')` no resuelve `pnpm.cmd` en Windows (2: `migrations`, `type-enforcement`; `drizzle-kit generate` lo comprobé a mano). No pude correr `pnpm e2e` ni el vitest oficial (el binario nativo de SWC se niega a materializar su caché en este entorno; usé una configuración temporal de vitest con el compilador de TypeScript, que no se versiona). **Falta una pasada verde en tu CI (PG 16, Node 22).**

### Pendiente / decisiones tuyas
1. **Aprobar ADR-33** (y la corrección al Build Spec §4.2: `trial_config` es de identidad, no de plataforma).
2. **Limpieza de las tablas de identidad** (requisito previo a producción): elegir mecanismo (a/b/c del ADR-33; recomiendo la función `SECURITY DEFINER` mínima).
3. **Purga a los 30 días** y su aviso por correo: se construye cuando haya datos de negocio y plantilla de correo.
4. Aviso al Súper Admin por correo y en tiempo real, edición de `trial_config` por endpoint: diferidos (sin proveedor de correo ni WebSocket).
5. Las matrices de permisos siguen PROVISIONALES: la extensión usa `billing.manage` (solo `client_admin`); si prefieres un permiso propio (`trial.request_extension`), es una migración.


## M1.6 — Pantallas de acceso (React) y E2E del flujo ADR-23 (2026-10-09) · APROBADA (2026-10-11; ADR-34 aprobado)
Decisiones y diferencias con el prototipo en **ADR-34 (PROPUESTO)**.

**Qué hay**
- **`apps/web`** (React 19 + Vite + TypeScript + Tailwind 4 con los tokens del prototipo, claro/oscuro, responsive): Iniciar sesión, Crear cuenta, Verificar correo (código de 6 dígitos, reenvío con espera), Recuperar contraseña, Crear contraseña nueva (enlace del correo), **Prueba vencida** (cuenta en pausa), aviso de prueba con **Pedir extensión** (modal accesible, única), y una pantalla inicial provisional (organización, rol, estado de la prueba; consola de plataforma para el Súper Admin).
- **Sesión**: access token solo en memoria; refresh por cookie HttpOnly; un único refresh en vuelo + candado entre pestañas; recuperación al recargar; cierre de sesión con la cabecera anti-CSRF.
- **API (cambios necesarios para la web)**: `GET /v1/auth/me` (`@SelfService`), `retention_days` y `extension_days` en `GET /v1/trials/me`, y **corrección de un bug previo**: la cookie de refresh se emitía con `Path=/v1/auth` pero se borraba con `Path=/auth`, así que el navegador nunca la eliminaba al cerrar sesión (test nuevo).
- **ESLint** para la web (antes `apps/web` estaba ignorado) con las reglas de hooks de React; `pnpm test` ahora corre también las pruebas de la web; `pnpm dev:web`, `pnpm e2e:web`; CI con el E2E web.

**Pruebas**
- **Web (Vitest + Testing Library, 50):** login (validación, éxito sin tocar el almacenamiento, 401 genérico, 429 con espera, sin red, Súper Admin, mostrar contraseña, redirección con sesión), registro (validación, **payload exacto** sin campos inventados, contraseña fuera de la URL/historial/almacenamiento, 503/dominio desechable/429, errores de campo), verificación (flujo completo con entrada automática, solo dígitos, código inválido, sin contraseña en memoria, reenvío), recuperar/crear contraseña (respuesta uniforme, token del fragmento **borrado de la URL**, token inválido, StrictMode), sesión (**un solo refresh** aunque React monte dos veces, 401 simultáneos comparten uno, sesión perdida, logout con CSRF y aunque falle la red, rutas públicas sin token) y prueba (aviso, asesor sin extensión, estados pendiente/aprobada/denegada, modal: validación/409/Escape, pantalla de vencida por rol y estado, vencimiento a mitad de sesión por 403 `TRIAL_EXPIRED`).
- **E2E en navegador real (Playwright, 11):** BD efímera con los 4 roles + API compilada + web compilada. **ADR-23 completo** (registro por la UI → código del «correo» → prueba → pedir extensión → Súper Admin aprueba → recargar conserva la sesión → **segunda solicitud 409** → vence → pantalla de vencida sin extensión → cerrar sesión), vencida sin extensión usada → pedir → denegar, **bloqueo tras 5 intentos** (el 6.º falla aun con la contraseña correcta), mensaje idéntico para correo inexistente y contraseña errónea, **correo desechable rechazado**, **correo duplicado no revelado** (la cuenta original sigue entrando), recuperar contraseña (enlace de un solo uso), Súper Admin a su consola, redirecciones y 3 pantallas a 390 px sin desborde.
- **API (nuevas):** `GET /v1/auth/me` (identidad, 401, A↔B sin ids, membresía revocada), cookie de logout, `retention_days`/`extension_days`.
- **Mutaciones (revertidas):** refresh sin compartir → 1 fallo; sin cabecera anti-CSRF en el refresh → 1 fallo; el memo del arranque es redundante con el refresh compartido (mutación equivalente).

### Resultados y entorno de verificación (léelo)
Typecheck, ESLint (`--max-warnings 0`) y `vite build` limpios. Web: **50/50**. E2E: **11/11** (Microsoft Edge instalado, PostgreSQL 13 desechable, Node 24). API: **474 en verde, 4 omitidos y los mismos 8 fallos de entorno de M1.5** (PG 13 en vez de 16; `spawnSync('pnpm')` en Windows); la CI de M1.5 con PG 16 y Node 22 los pasa. **Falta la pasada verde de la CI con el E2E web** (el paso nuevo instala Chromium en el runner).

### Pendiente / decisiones tuyas
1. **Aprobar ADR-34** y confirmar las diferencias con el prototipo: **¿se capturan «nombre» y «WhatsApp» en el registro?** (hoy no hay dónde guardarlos), y la contraseña mínima de 8.
2. **Dominio y CORS**: producción necesita web y API bajo el mismo origen (proxy) o CORS con credenciales; depende del hosting.
3. **Proveedor de CAPTCHA** (hoy `fake`/`none`) y de correo: sin ellos el registro en producción responde 503.
4. **Consola de plataforma** (M2): hoy el Súper Admin no puede aprobar extensiones desde la UI.
5. Heredado de M1.5: mecanismo de limpieza de tablas de identidad.

### Ajustes tras la aprobación de M1.6 (2026-10-11)
- **Nombre completo y WhatsApp en el registro** (decisión del responsable de producto): migración `0013_users_profile` (`users.full_name`, `users.phone`, CHECK de longitud y de formato E.164, nulos permitidos para cuentas creadas por otras vías); `signup` los exige y un re-registro pendiente los actualiza; `/auth/login` y `/auth/me` devuelven `full_name`; `GET /platform/trials` añade `owner_name` y `owner_phone`; el formulario web tiene selector de país (EC, CO, PE, MX, ES, US), arma el número en E.164 (quita el 0 de marcación nacional) y exige al menos 7 dígitos nacionales; el encabezado muestra el nombre.
- **Contraseña mínima de 8**: confirmada.
- **Pruebas nuevas:** API (+5: perfil guardado y actualizado en el re-registro, 11 formatos inválidos de nombre/teléfono → 400 sin crear nada, CHECK de la BD, login ≡ /me, nombre en /me y en la lista del Súper Admin), web (+16: payload exacto con `full_name`/`phone`, prefijo de país, número corto, formato E.164) y el E2E verifica que el perfil del registro llega a la lista del Súper Admin y al encabezado.
- **Resultados:** web **66/66**; E2E **11/11** (Edge); API **478 en verde, 4 omitidos y los mismos 8 fallos de entorno** (PG 13 / Windows); typecheck, ESLint y `pnpm audit` limpios.

### Estado de los pendientes de M1 tras la respuesta del 2026-10-11
1. ADR-34 y nombre/WhatsApp: **resuelto**. 2. Contraseña de 8: **resuelto**. 3. Dominio y CORS: recomendación = una sola URL para web y API (la API sirve la web compilada), ver el mensaje de cierre; sin implementar. 4. Correo y CAPTCHA: recomendación Resend + Cloudflare Turnstile; sin implementar. 5. Consola del Súper Admin: primera rebanada de M2 («Pruebas»). 6. Limpieza de identidad: recomendación (a) del ADR-33; sin implementar.

## Limpieza de identidad (ADR-35, 2026-10-11)
Función `purge_expired_identity_rows()` (migración 0014) + job `identity-cleanup`, con auditor y escáner ampliados. Pruebas: borra solo lo caducado de cada una de las 5 tablas y conserva lo vivo o reciente, nunca toca usuarios/organizaciones, privilegios por rol, sin parámetros, `SKIP LOCKED`, más de un lote en una pasada, dos ejecuciones simultáneas, y el auditor rechaza una función aprobada pero insegura (dueño, `search_path`, EXECUTE). Resultado local: todo en verde salvo los fallos de entorno ya conocidos (PG 13/Windows).

## Un solo origen y proxy (ADR-36, 2026-10-11)
La API sirve la web compilada (`WEB_DIST_DIR`) con CSP y cabeceras de seguridad; `TRUST_PROXY_HOPS` y `PORT` para Railway; guía `docs/DESPLIEGUE_RAILWAY.md`. Pruebas: 11 de la web servida (SPA, caché, 404 JSON, `..`/dotfiles/%2e, HEAD/POST, HSTS en producción, CSP), 3 de trust proxy (suplantación de `X-Forwarded-For`, 1 y 2 saltos), 3 de configuración; el E2E (12/12 en Edge) ahora corre contra esta arquitectura y verifica que la CSP no rompa ninguna pantalla. **Pendiente de validar en el primer despliegue:** el valor real de `TRUST_PROXY_HOPS` en Railway y la prueba de una hora de la base de datos (ADR-30).

## Correo y anti-bots reales (ADR-37, 2026-10-11)
`ResendMailProvider` (plantillas en español) y `TurnstileVerifier` detrás de sus puertos, con configuración validada, widget de Turnstile en la web (registro, reenvío y recuperar contraseña; token de un solo uso). Pruebas: 18 de contrato de los adaptadores (forma exacta de la petición, escape de HTML, enlaces solo http(s), errores sin filtrar claves, tiempos máximos, fail-closed), 7 de integración con la red externa simulada (registro → correo → verificación → entrada; Turnstile rechaza o cae → 400 y sin correo; Resend cae → mismo 202 y se puede reenviar; enlace de restablecer), 5 de configuración y 11 de la web (widget, token de un solo uso, caducidad, sin clave, script que no carga). **No validado todavía:** el envío real por Resend (necesita las claves y el DNS del dominio) ni el widget contra Cloudflare real.

## M2.1 — Consola del Súper Admin: pestaña «Pruebas» (2026-10-11)
**Primera rebanada de M2** (confirmada por el responsable de producto): sin ella, las solicitudes de extensión no tenían quién las aprobara desde la interfaz.
- **Web** (`features/platform`): marco de la consola (`/platform/trials`, solo `super_admin`; cualquier otra persona vuelve a su inicio y no se consulta nada de plataforma) con navegación y la **insignia** de solicitudes pendientes (se refresca cada minuto); resumen global (pruebas activas, vencen en menos de 2 días, solicitudes pendientes); filtros (Solicitudes pendientes —por defecto—, Todas, Activas, Vencidas); lista paginada por cursor («Cargar más»); por fila: empresa, correo, titular, **WhatsApp con enlace seguro** (`wa.me`, `noopener`), fechas, estado, extensión y el motivo; **Aprobar/Rechazar con confirmación** que explica el efecto exacto (suma los días / cuenta desde hoy y reactiva / la prueba no cambia) y avisa si otra persona ya la resolvió (409). Responsive (tarjetas en móvil) y accesible (roles `tab`, `dialog`, etiquetas por fila).
- **API:** `GET /v1/platform/trials` añade `summary` (`active`, `expiring_soon`, `pending`, `extension_days`) con totales de TODA la plataforma, independientes de la página y de los filtros.
- **Pruebas:** web +15 (`platform-trials.test.tsx`: acceso y redirecciones, resumen, filtros que piden lo correcto a la API, paginación, vacío/error/reintento, contenido y acciones por fila, los tres textos de confirmación, cancelar/Escape sin llamar a la API, 409), API (resumen y su independencia de página/filtros) y **E2E en navegador real**: el Súper Admin ve la solicitud con el perfil del titular, **aprueba una y rechaza otra desde la interfaz** (una ya vencida) y el efecto llega al servidor. Capturas revisadas en escritorio y móvil.
- **Fuera de alcance:** el editor de «Reglas de la prueba» del prototipo (días, extensión, retención) — requiere un endpoint de edición de `trial_config` que sigue diferido (ADR-33); los demás apartados de M2 (empresas y planes, agencias, carteras, accesos, proveedores).
