# M1 — Auth, organizaciones y acceso · Plan de ejecución

> Preparado 2026-10-04 tras cerrar M0. Fuente: Build Spec §14 (M1), §6.1/6.2, §7, §11; ADR-01, ADR-23, ADR-24, ADR-25.
> Regla: no se deciden los puntos ABIERTOS (correo, captcha real, pasarela, hosting, valores provisionales). Lo que depende de ellos se construye **detrás de un puerto con fake** y se marca.

## 1. Aceptación de M1 (Build Spec)
Flujo completo de ADR-23 en E2E · segunda solicitud de extensión rechazada · bloqueo tras 5 intentos · correo desechable/duplicado rechazado · mensajes de error genéricos. Más: pantallas de acceso del prototipo (frontend), RBAC, auditoría.

## 2. Dependencias y bloqueos
| Tema | Estado | Tratamiento en M1 |
|---|---|---|
| Proveedor de correo (#3) | ABIERTO | Puerto `MailProvider` + `FakeMailProvider` (test) + `ConsoleMailProvider` (solo `development`, jamás en producción). El proveedor real **no** se elige aquí. |
| Captcha real (#9) | PROPUESTA | Puerto `CaptchaVerifier` + fake. hCaptcha/Turnstile se decide después. |
| Valores de prueba (7 d, 3 d, 30 d, 1000 créditos) (#8) | PROVISIONAL | Solo en `trial_config` (editable), nunca en código. |
| Redis/BullMQ | no hay infraestructura aún | Throttling de login en PostgreSQL (tabla `auth_throttle`), sin Redis. Los jobs de vencimiento de prueba (M1.5) requieren cola: se decide entonces (ver riesgo R3). |
| Frontend | no existe `apps/web` | Pantallas de acceso van en M1.6, después de que la API esté estable. |

## 3. Rebanadas (cada una termina con tests, documentación y parada para revisión)
| # | Contenido | Estado |
|---|---|---|
| **M1.1** | **Sesiones y login**: tablas `sessions` y `auth_throttle`; `SessionService` (token opaco, refresh rotativo con detección de reutilización, revocación, `session_version`); `POST /auth/login`, `/auth/refresh`, `/auth/logout`; `AccessResolver` real (reemplaza DenyAll); bloqueo tras 5 intentos con espera creciente; mensajes genéricos; A↔B de los endpoints | **HECHA y APROBADA (2026-10-04), con correcciones aplicadas** — ver `M1_PROGRESO.md` |
| M1.2 | Registro y verificación: `POST /auth/signup|verify|resend`; `email_verifications`, `signup_attempts`, `disposable_domains`; `MailProvider`/`CaptchaVerifier` + fakes; creación de organización `client` + membresía `client_admin` | **HECHA y APROBADA (2026-10-04)** — ver `M1_PROGRESO.md` y ADR-27 |
| M1.3 | Olvido/reset de contraseña (`password_resets`), cambio de contraseña (sube `session_version`), mensajes que no revelan existencia | **APROBADA** — ver `M1_PROGRESO.md` y ADR-28 |
| M1.4 | RBAC: `roles/permissions/role_permissions`, guard de permisos central, `@RequirePermission`, matriz de roles (Build Spec §5); auditoría (`audit_log` tenant + `platform_audit`) | **APROBADA 2026-10-05** (matriz PROVISIONAL) — ver `M1_PROGRESO.md` y ADR-29 |
| M1.5 | Pruebas: `trials`, `trial_config`, extensión única con aprobación (transición por CHECK + trigger), vencimiento (job con `SKIP LOCKED`), estado «vencida» (cuenta en pausa); endpoints `/trials/me`, `/trials/me/extension`, `/platform/trials*` | **HECHA (2026-10-09), pendiente de aprobación** — ver `M1_PROGRESO.md` y ADR-33. R3 resuelto: PostgreSQL + `SKIP LOCKED` |
| M1.6 | Pantallas de acceso (React) del prototipo + E2E del flujo ADR-23 | pendiente |

## 4. Decisiones propuestas (requieren tu revisión) — ver ADR-26
1. Tokens **opacos** (no JWT), guardados solo como hash SHA-256, con la sesión en BD → revocación inmediata y verificación de usuario activo/versión en cada petición (Build Spec §11.6).
2. Refresh rotativo con **detección de reutilización**: presentar un refresh ya rotado revoca la sesión entera.
3. Una tabla `sessions` (access y refresh como columnas de hash) en lugar de `sessions` + `refresh_tokens` del §6.1: menos filas y una sola transacción por rotación. Desviación menor y reversible del §6.1.
4. Throttling en PostgreSQL por hash de correo y por hash de IP (también para correos inexistentes, para no revelar cuentas).
5. Refresh en cookie `HttpOnly; SameSite=Strict; Path=/v1/auth` (`Secure` en producción) o en cuerpo para clientes no web; CSRF mitigado con SameSite + cabecera obligatoria `X-Requested-By`.
6. Duraciones **provisionales**: access 15 min (Build Spec), refresh 30 días rotativo, sesión absoluta 90 días.

## 4b. Política de contraseña (aprobada)
Longitud mínima por defecto 8, configurable solo en el rango `8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128` (nunca menos de 8). Aplica a registro, restablecimiento y cambio. Enlaces de correo con `FRONTEND_BASE_URL` explícita (no derivada del Host).

## 5. Riesgos
- **R1** Verificación por petición con una consulta a BD (rol `app_identity`): coste aceptable al inicio; si aparece en profiling, caché corta con invalidación por `session_version`.
- **R2** `auth_throttle` puede crecer: limpieza periódica (job de M1.5).
- **R3** (RESUELTO 2026-10-09) Jobs de vencimiento de prueba y purga: se usa PostgreSQL con `SELECT … FOR UPDATE SKIP LOCKED` en proceso, sin Redis (ADR-33). La limpieza de tablas de identidad y la purga quedan pendientes.
- **R4** El resolvedor consulta identidad en cada petición: cualquier error de lógica allí es un fallo de aislamiento → tests A↔B obligatorios por endpoint (ya generados por el registro).
- **R5** Cambio de contexto de agencia/super_admin (M2) amplía el principal (`actingAs`): el resolvedor ya devuelve la forma completa para no rediseñarlo.
