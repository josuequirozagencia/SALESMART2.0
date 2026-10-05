# M0 — Progreso · Bloque 2 (monorepo, config, logger, roles, TenantContext, RLS, tests de aislamiento)

> Estado: implementado y verificado localmente (PostgreSQL 16.15, Node 22.22, pnpm 10.28). Bloque aprobado por Josué (2026-10-04).
> No se modificaron `docs/BUILD_SPEC.md` ni el texto de ADR-24. No se implementó ningún módulo funcional (CRM, Inbox, IA, Meta, GHL…).

## 1. Estructura
```
apps/api      NestJS (modular monolith): config · logger · tenant · db · health · test/
apps/worker   cascarón (importa @sales-smart/api); sin trabajos todavía
apps/web      README (se construye desde el prototipo en un bloque posterior)
packages/shared  isUuid (compilado a dist; los tests lo resuelven a src)
packages/ui   README
infra/postgres   bootstrap-roles.sql · bootstrap-database.sql      scripts/db-bootstrap.sh
```
Reglas de dependencia: el resto de la app solo importa de `db/` su barrel (`Database`, `TenantTx`, `PlatformTx`, `tenantTable`, `platformTable`, `DbModule`…). Lo verifican ESLint (P2) y un test del barrel.

## 2. Mecanismo de aislamiento (cómo se cumplen las reglas del bloque)
| Regla | Implementación | Verificación |
|---|---|---|
| Contexto **por transacción**, nunca global | `Database.withTenant` abre UNA transacción y ejecuta `set_config('app.org_id', $1, true)` como primera sentencia | S9, S10, S11, canario, mutación M1 |
| Ningún camino sin TenantContext | `withTenant` lee `TenantContext.current()` (lanza antes de conectar); no se exponen pools/clientes/drizzle; `ping()` no toca datos | S1, `database-surface`, test de barrel |
| RLS segunda barrera | `app_org()` falla cerrado; políticas USING+WITH CHECK; ENABLE+FORCE; `app_rw` sin BYPASSRLS ni propiedad | `rls-contract`, `roles`, `policy-coverage` |
| organización nunca es parámetro | `organization_id DEFAULT app_org()`; P4/P5 en lint | S13, `lint-rules` |
| Patrones prohibidos → reglas | ESLint `ADR24-P1…P10` + `noInlineConfig` + escáner SQL de migraciones + auditor de catálogo | `lint-rules` (35 casos que fallan + controles), `migrations`, `policy-coverage` |

## 3. Decisiones tomadas en este bloque (sin ADR nuevo; todas reversibles)
1. **`tenantTable()` es la única forma de declarar tablas de negocio** (organization_id + política + ENABLE RLS + `UNIQUE(organization_id,id)`); `pgTable/pgPolicy/pgView` directos prohibidos fuera de `db/`.
2. **FK entre tablas tenant siempre compuestas con `organization_id`** (hallazgo, ver §5): auditor `FK_CROSS_TENANT`.
3. **Llamadas anidadas a `withTenant` reutilizan la transacción** (misma conexión, atómico, sin agotar el pool); mezclar tenant/plataforma está prohibido.
4. **Guarda de transacción**: la conexión que ve Drizzle es un proxy; tras terminar el callback solo admite COMMIT/ROLLBACK; tras liberarla lanza `LeakedTransactionError`.
5. **Auditoría de catálogo** (`pnpm db:audit`): roles, `app_org()`, SECURITY DEFINER, vistas sin `security_invoker`, políticas, FORCE, GRANT, FKs, propiedad. Toda tabla debe ser tenant (tiene `organization_id`) o estar clasificada en `db/audit/catalog.ts` (vacío en producción hoy).
6. **Roles se crean en el bootstrap (superusuario), no en migraciones**; contraseñas por variable, sin valores por defecto. Timeouts de rol (`statement_timeout 30s/60s`, `lock_timeout 5s`, `idle_in_transaction 30s`) son **provisionales**.
7. **Config**: sin valores por defecto para `NODE_ENV` ni URLs de BD; la API se niega a arrancar si ve `DATABASE_URL_OWNER/ADMIN` o si usa `postgres`/`app_owner`; los errores nunca incluyen valores.
8. **Logger**: redacción por clave + por patrón + errores con lista blanca (se elimina el bloque `params:` que Drizzle mete en el mensaje) + bindings de `child()`. Mejor esfuerzo: no sustituye la regla de no registrar contenido de clientes.
9. Plataforma: `app_platform` sin RLS (no hay `org`); su aislamiento es por GRANT y lo verifica el auditor.
10. Sin valores de pricing/créditos/billing/retención en ningún archivo.

## 4. Pruebas (178, todas en verde) — `pnpm check`
`rls-contract` 18 (S1–S16 reescritos contra el rol real) · `policy-coverage` 16 (2 positivos/control + 14 negativos con detección) · `roles` 23 · `database-surface` 11 · `type-enforcement` 2 (+control negativo) · `lint-rules` ~48 · `migrations` 6 (desde cero, idempotencia, `drizzle-kit generate` sin cambios, escáner SQL con dientes, DDL de `tenantTable`) · `canary` 2 (+control negativo) · `concurrency` 1 (240 tx, 3 orgs, pool 5, verificación independiente con superusuario) · `endpoint-registry` 3 · `app-boot` 3 (Nest + decoradores bajo vitest/swc) · `config` 10 · `logger` 35.
**Pruebas de mutación manuales** (revertidas): (M1) `set_config(...,false)` → falla S9 + canario; (M2) tx sin sellar → falla el test de fuga; (M3) sin contexto usa org vacía → falla S1; (M4) quitar `REVOKE ... FROM PUBLIC` → falla `roles`.
También ejecutado: `pnpm build` + arranque del JS compilado (`/health` 200, `/health/ready` 503 sin BD, como debe) y `db:bootstrap → db:migrate → db:audit` con los CLIs reales.

## 5. Riesgos y hallazgos
- **Hallazgo (no cubierto por ADR-24 ni por el spike): las FK eluden RLS.** Una FK simple `deals.contact_id → contacts.id` permite referenciar —y sondear la existencia de— filas de otra organización. Mitigación implementada: FK compuestas + auditor + test S14. **Regla P11 aprobada por Josué (2026-10-04) y registrada en ADR-24.**
- `set_config(..., false)` ejecutado por código malicioso no se puede impedir desde la BD; lo cubren lint P1 (+`noInlineConfig`) y el canario. Defensa adicional posible: reset al devolver la conexión (costo: 1 round-trip).
- Los errores de Drizzle llevan SQL y **params en `message`**: el filtro HTTP futuro NO debe devolver `error.message` al cliente (pendiente del módulo de errores).
- ESLint sin reglas con tipos (`no-floating-promises`, etc.): decisión consciente por velocidad; recomendado activarlo antes de M1.
- Lint P4/P5 son heurísticos por nombre (`*Repository`, `*.controller.ts`, `*.dto.ts`); alias (`import {sql as s}`) o nombres creativos los eluden → el aislamiento real descansa en RLS + roles + guarda, no solo en lint.
- Paquete compartido: la API compilada requiere `packages/shared` compilado (`pnpm build` ya lo hace); empaquetado/Dockerfile quedan para cuando se decida hosting.
- PgBouncer en modo transacción no probado (compatible en teoría: `set_config` local + sentencias sin nombre).
- Redacción de teléfonos puede dar falsos positivos con cadenas numéricas largas (p. ej. epoch en ms dentro de texto).
- Seguridad de la dependencia: versiones fijadas exactas; no se ejecutó auditoría de vulnerabilidades (`pnpm audit`) por red del sandbox.

## 6. Criterios de aceptación de M0 cerrados por este bloque
Monorepo estructurado y reproducible · configuración validada sin secretos por defecto · logger JSON con redacción de PII · roles de PostgreSQL (owner/rw/platform) con bootstrap idempotente · TenantContext obligatorio · RLS con FORCE + auditor de catálogo · patrones P1–P10 como reglas verificables · suite de aislamiento (contrato, cobertura, roles, tipos, lint, migraciones, canario, concurrencia) en verde · build y arranque de la API · `/health`.

## 7. Pendiente para completar M0 (no iniciado; esperando aprobación)
- Test **A↔B por endpoint**: el registro y su guardia existen (falla si aparece un endpoint sin clasificar), pero aún no hay endpoints de negocio que probar.
- Módulo de errores HTTP (sin filtrar `message`), validación de DTO (zod), request-id/borde de autenticación que establece `TenantContext.run`.
- Identidad/organizaciones/usuarios/membresías (tablas reales con `tenantTable`) y bootstrap de super admin.
- docker-compose de desarrollo y CI (GitHub Actions) ejecutando `pnpm check` contra PostgreSQL 16 efímero.
- Reglas ESLint con tipos; prueba con PgBouncer; `pnpm audit`; `pnpm dev`/`pnpm e2e`.
- Hosting/región, correo, pasarela de pago, PoC de voz, retención de grabaciones, Events Manager: siguen abiertos (no decididos).


---

# Bloque 3 — Capa HTTP segura (parcial: se detuvo ante una decisión de diseño)

> Aprobado por Josué (2026-10-04) «tal como está». Se implementaron los puntos 1, 2, 3 y 5; el punto 4 (tablas de identidad + bootstrap del super_admin) **no** se implementó: depende de ADR-25 (propuesto). No se avanzó al Bloque 4.

## Qué se implementó
1. **Errores** (`src/errors`): `AppError` y subclases con mensaje seguro; filtro global `{error:{code,message,request_id,details}}`; `mapException` **nunca** expone `message` de errores que no sean `AppError` (Drizzle/pg/body-parser/Nest); SQLSTATE → 409/400 genéricos; 500 genérico + log redactado; 404 para rutas inexistentes.
2. **Validación** (`ZodValidationPipe`): detalles = ruta + mensaje del esquema, nunca el valor recibido; DTO con `.strict()` rechaza campos desconocidos (p. ej. `organization_id`).
3. **Borde de acceso** (`src/http`): puerto `AccessResolver` (la implementación real —LocalAuthProvider + membresías— es M1; por defecto **deniega todo**), `AccessGuard` **denegar-por-defecto** (`@Public()`, `@PlatformOnly()`; el resto es de tenant), `ContextInterceptor` que establece `TenantContext`/`PlatformContext` solo desde el principal verificado, `RequestIdMiddleware` (acepta `x-request-id` solo con formato seguro), `configureApp` (sin `x-powered-by`). `/health*` son `@Public()`.
5. **A↔B por endpoint**: generador reutilizable `describeTenantEndpointIsolation` (invariante: ninguna respuesta a A contiene ids/datos/organización de B; 404 por id; 401 sin credenciales; datos de B intactos) aplicado a una app de fixture con 5 rutas; registro de endpoints que ahora **descubre las rutas reales de Nest** y exige clasificación (`public|platform|tenant`) y suite A↔B para cada ruta de negocio.

## Pruebas: 215 en verde (`pnpm check`), +37 respecto al Bloque 2
`http-layer` 21 (errores seguros, request_id, 413, JSON malformado, validación, deny-by-default, plataforma vs tenant, la organización **solo** del principal aunque cabecera/query/cuerpo digan otra, 60 peticiones concurrentes A/B) · `fixture-contacts.isolation` 12 · `endpoint-registry` 4 · `lint-rules` +3.
**Mutaciones (revertidas):** H1 guard permite todo → 6 fallos; H2 el filtro expone `message` → 2 fallos; H3 organización tomada de una cabecera → falla; restaurado → verde.

## Hallazgos del bloque
- **Bug propio detectado por los tests:** el interceptor anidaba `TenantContext.run` al registrar la petición y dejaba las peticiones colgadas; corregido (el log no puede romper la respuesta).
- **Vacío de diseño (ADR-25):** las tablas de identidad se leen antes de existir contexto y cruzan organizaciones; ADR-24 P10 y el Build Spec §4.2 no cubren su acceso. Ver ADR-25 (opciones A–D; recomiendo A: rol `app_identity` + `withIdentity`).
- Los tests de endpoints usan un resolvedor de PRUEBA que confía en una cabecera; jamás debe existir en `src/` (lint P5 aplica a `*.guard.ts`, `*.controller.ts`, `*.dto.ts`).
- Límites aún sin implementar en HTTP: CORS, CSRF, CSP/cabeceras de seguridad, rate limit, idempotencia (Build Spec §7/§11) — no estaban en el alcance.

## Pendiente (a la espera de decisión sobre ADR-25)
Tablas `users`/`organizations`/`organization_members` (categoría `identity`), rol y pool `app_identity`, `withIdentity`, regla P12, **bootstrap del super_admin** (contraseña única generada; Argon2id: elegir librería con binarios precompilados y verificarla en este entorno), migración y pruebas A↔B de esos endpoints.
Bloque 4 (docker-compose, CI, ESLint con tipos, PgBouncer, `pnpm audit`) **sin iniciar**.


---

# Bloque 3b — Identidad (ADR-25 aprobado, opción A)

> Aprobado por Josué (2026-10-04): «Si, Avanza con lo que recomiendas». Cierra el punto 4 del Bloque 3. No se avanzó al Bloque 4.

## Qué se implementó
- **Rol y pool `app_identity`** + `Database.withIdentity` (`IdentityTx`), configuración con tres URLs distintas (valida y prohíbe `postgres`/`app_owner`), `bootstrap-roles.sql`/`db-bootstrap.sh` y `.env.example` actualizados.
- **Tablas** `users`, `organizations`, `organization_members` (`identityTable`, fuera de RLS) con CHECK/UNIQUE de integridad (detalle en ADR-25). Migraciones `0001_identity` (generada) y `0002_identity_grants` (GRANT mínimo + REVOKE a `app_rw`/`app_platform`; sin DELETE/TRUNCATE).
- **Auditor** (`db:audit`): categoría `identity`; verifica que `app_rw`/`app_platform` no tengan privilegios sobre identidad, que `app_identity` no tenga acceso a nada más y que no tenga DELETE/TRUNCATE/REFERENCES/TRIGGER.
- **Lint P12** (`withIdentity` solo en `modules/auth` y `modules/organizations`) y `IdentityTx` añadido a P9 (casts).
- **Hasher Argon2id** (`src/security`): `@node-rs/argon2` 2.0.2 (binarios precompilados; verificado). Parámetros m=19456/t=2/p=1 **provisionales**; `needsRehash`; rechaza contraseñas vacías o >1024.
- **Bootstrap del super_admin** (`src/modules/auth`, `pnpm bootstrap:super-admin`).
- `uuidv7` en `@sales-smart/shared` (ids de identidad). El esquema de identidad falla al cargar si `shared` está desactualizado (hallazgo del smoke test: con `dist` obsoleto drizzle omitía el `id`).

## Pruebas: 266 en verde (`pnpm check`: typecheck + lint + test), +51 respecto al Bloque 3
Nuevas: `identity.test` (privilegios de `app_identity`; `app_rw`/`app_platform` sin acceso; integridad: email, argon2id, kind, plataforma única, jerarquía, membresía activa única, FK; bootstrap: crea, contraseña única que verifica, idempotente, 6 ejecuciones concurrentes → 1 creación, super_admin revocado, no adopta usuarios, emails inválidos, atomicidad, `app_identity` no puede leer `contacts`), `password-hasher.test` (5), auditoría de identidad (9), lint P12/P9/P10 (+10), config (+4).
**Mutaciones (revertidas):** GRANT de identidad también a `app_rw` → 4 fallos; selector P12 desactivado → 3 fallos.
**Smoke CLI en BD real:** `db:bootstrap → db:migrate → db:audit (OK) → bootstrap:super-admin` (crea y muestra la contraseña una vez) → segunda ejecución (no cambia nada).

## Riesgos / pendientes
Ver «Riesgos aceptados» de ADR-25. Además: parámetros Argon2id y timeouts sin calibrar en carga real; la contraseña inicial del bootstrap se imprime por stdout (quien ejecute el CLI debe guardarla; no pasa por el logger); no existe aún login, sesiones ni recuperación de contraseña (M1).
**Criterios de M0 cerrados por este bloque:** identidad/organizaciones/membresías con acceso mínimo-privilegio verificable · bootstrap seguro del super_admin · Argon2id verificado.
**Sin iniciar (Bloque 4, esperando aprobación):** docker-compose, CI, ESLint con tipos, PgBouncer, `pnpm audit`, `pnpm dev`/`pnpm e2e`. Siguen abiertos hosting/región, correo, pasarela, PoC de voz, retención de grabaciones, Events Manager.


---

# Bloque 4 — Herramientas de desarrollo, CI y pruebas de entorno

> Iniciado tras «Avanza» de Josué (2026-10-04). Fin del alcance de M0 técnico; no se tocó ningún módulo funcional.

## Qué se implementó
- **ESLint con tipos** (solo `apps/api/src`): `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-type-assertion`, `only-throw-error`, `require-await`. Corrigió 4 hallazgos reales. Los tests de lint usan archivos virtuales con las reglas tipadas desactivadas y un bloque aparte las prueba sobre un archivo real.
- **`pnpm audit`**: 1 vulnerabilidad moderada (esbuild ≤0.24.2, transitiva de drizzle-kit, solo desarrollo) → `pnpm.overrides.esbuild >=0.25.0`; resultado: 0 vulnerabilidades; `drizzle-kit generate` sigue verde. CI la ejecuta con `--audit-level moderate`.
- **docker-compose.yml**: PostgreSQL 16 solo en loopback; PgBouncer opcional (perfil `pooler`, imagen **no probada**). **`pnpm dev:setup`** genera `.env` con contraseñas aleatorias (gitignored), levanta PostgreSQL, crea roles, migra y audita. **`pnpm dev`** arranca la API sin las variables de herramientas/administración.
- **PgBouncer real** (1.22, modo transacción, 2 conexiones de servidor para 12 de cliente): 300 transacciones intercaladas de 3 orgs sin fugas; canario de contexto; fallo cerrado sin contexto; `withIdentity` operativo. **Mutación:** pasar `set_config` a nivel de sesión → el canario falla (revertido).
- **e2e** (`pnpm e2e`): `dist/main.js` como proceso real con puerto y BD reales: `/health`, `/health/ready`, 404 con forma estándar sin filtrar tecnología, deny-by-default, `x-request-id` inseguro descartado, log de arranque sin contraseñas, cierre ordenado con SIGTERM.
- **CI** (`.github/workflows/ci.yml`): PostgreSQL 16 efímero + PgBouncer; audit → typecheck → lint → test → e2e.

## Pruebas: 273 + 6 e2e en verde; `pnpm audit` limpio.

## Límites / riesgos
- **Docker no tiene daemon en este entorno**: `docker-compose.yml` solo se validó estáticamente (`docker compose config`) y `dev.sh` se probó contra el PostgreSQL local; `dev:setup` y el workflow de CI **no se han ejecutado de extremo a extremo**: la primera ejecución en tu máquina/GitHub es su prueba real.
- El workflow usa acciones por etiqueta mayor (`@v4`), no fijadas por SHA (decisión pendiente de supply-chain).
- PgBouncer se probó con `server_reset_query` vacío y sentencias sin nombre (lo que usa node-postgres/drizzle); sentencias preparadas con nombre no están cubiertas.
- Sigue sin implementar: CORS/CSRF/CSP, rate limit, idempotencia, login/sesiones (M1). Siguen abiertos hosting/región, correo, pasarela, PoC de voz, retención de grabaciones, Events Manager.

**Criterios de M0 cerrados:** compatibilidad con PgBouncer verificada · CI definido · entorno reproducible · calidad estática con tipos · auditoría de dependencias.
