# orm-rls — spike DESCARTABLE
Compara Prisma 7 y Drizzle bajo el mismo escenario de aislamiento multiempresa. Resultados en `RESULTS.md`; decisión propuesta en `docs/ADR.md` (ADR-24). **No reutilizar este código en el producto.**

Reproducir (PostgreSQL 16 local con roles `app_owner`/`app_rw`/`app_platform`): `shared/schema.sql` + `shared/seed.sql` (`shared/reset.sh <bd>`), luego `npx tsx run.ts` en cada carpeta.
