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
