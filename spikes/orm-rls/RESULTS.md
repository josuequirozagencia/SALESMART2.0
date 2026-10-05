# Spike ORM/RLS — resultados (DESCARTABLE)

Fecha: 2026-10-03/04 · PostgreSQL 16.15 local · Node 22.22 · Prisma 7.10.0 (+ `@prisma/adapter-pg`) · Drizzle ORM 0.45.3 + drizzle-kit 0.31.11 · `pg` (node-postgres).
Roles: `app_owner` (migraciones; sin BYPASSRLS), `app_rw` (aplicación; sin BYPASSRLS), `app_platform` (tablas de plataforma). `FORCE ROW LEVEL SECURITY` en todas las tablas de negocio. Política: `organization_id = app_org()` con `app_org() = NULLIF(current_setting('app.org_id', true),'')::uuid` → **falla cerrado** si no hay contexto.

## Escenarios (mismo conjunto en ambos)

| # | Escenario | Prisma | Drizzle |
|---|---|---|---|
| S1 | Sin contexto: lectura vacía; INSERT bloqueado | ✅ | ✅ |
| S2 | Contexto A solo ve datos de A | ✅ | ✅ |
| S3 | A pide por id un contacto de B | ✅ `null` | ✅ 0 filas |
| S4 | A hace UPDATE sobre contacto de B | ✅ `updateMany`=0; `update()` lanza P2025 | ✅ 0 filas |
| S5 | A hace DELETE sobre contacto de B | ✅ | ✅ |
| S6 | A inserta con `organization_id` de B (WITH CHECK) | ✅ bloqueado (42501) | ✅ bloqueado |
| S7 | SQL crudo dentro de la tx respeta RLS (incl. `OR 1=1`) | ✅ | ✅ |
| S8 | JOIN / relaciones con RLS | ✅ | ✅ |
| S9 | El contexto no sobrevive al commit (pool de 1 conexión) | ✅ | ✅ |
| S10 | A y luego B en la misma conexión: sin fuga | ✅ | ✅ |
| S11 | 40 transacciones concurrentes A/B intercaladas (pool 4) | ✅ 0 fugas | ✅ 0 fugas |
| S12 | Advisory lock transaccional: 20 txs concurrentes | ✅ sin lock 6/20 (carrera) → con lock 20/20; 0 locks residuales | ✅ ídem (6/20 → 20/20; 0 residuales) |
| S13 | Tabla de plataforma: `app_rw` denegado, `app_platform` permitido | ✅ | ✅ |
| S14 | **Anti-patrón** `set_config(...,false)` (sesión): FILTRA entre peticiones | ⚠️ fuga demostrada | ⚠️ fuga demostrada |
| S15 | La app no puede `SET ROLE` ni `DISABLE ROW LEVEL SECURITY` | ✅ | ✅ |
| S16 | (solo Prisma) `$extends` inyecta contexto por operación | ✅ pero cada operación = su propia tx | n/a (no hay equivalente nativo) |

Total: Prisma 16/16 · Drizzle 15/15 (en BD creada a mano **y** en BD creada solo con migraciones de drizzle-kit).

## Otras pruebas

- **Obligatoriedad en compilación (tipo "marca")**: un repositorio que exige `TenantTx` **rechaza en compilación** tanto el cliente crudo como una transacción abierta sin contexto, en ambos ORMs (`typed-*.ts`). Un `as any` explícito lo evade → se cubre con lint.
- **Migraciones Drizzle**: `drizzle-kit generate` produjo `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` desde el esquema TypeScript. **No** genera `FORCE`, funciones, roles ni grants: se añadieron con migraciones SQL personalizadas (`--custom`), la función antes y FORCE/grants después. `drizzle-kit migrate` las aplicó; `generate` posterior dijo "No schema changes". La BD migrada pasó 15/15.
- **Migraciones Prisma: NO VERIFICADO.** El motor de migraciones (`schema-engine`) se descarga de `binaries.prisma.sh`, bloqueado (403) en este entorno; no pude ejecutar `migrate`. Lo que sí confirma la documentación consultada: `schema.prisma` no representa RLS, políticas ni grants (van como SQL manual en la migración) y `migrate deploy` no detecta deriva por diseño. `prisma generate` funcionó con un binario ficticio (el cliente 7.x ya no usa motor Rust).
- **Latencia** (n=200, entorno compartido, solo orientativa): tx con contexto (BEGIN + set_config + consulta + COMMIT) ≈ 1,1–1,5 ms en Drizzle y ≈ 2,0–2,4 ms en Prisma; consulta sin tx ≈ 0,4–0,7 ms.
- Observación: `npm i prisma` resolvió a `8.0.0-rc.19` mientras `@prisma/client` era 7.10.0 (hubo que fijar versión). Drizzle sigue en 0.x (API pre-1.0).

## Qué NO se probó
PgBouncer en modo transacción; NestJS; pgvector; API relacional `db.query` de Drizzle con RLS (es SQL, se espera igual); migraciones de Prisma; rendimiento a escala; hosting administrado.
