# AGENTS.md — Sales Smart 2.0

Instrucciones para agentes de IA (Codex, Cursor, Claude Code…) que trabajen en este repositorio.

**La fuente única de instrucciones es [`CLAUDE.md`](CLAUDE.md). Léelo completo antes de tocar código.** Este archivo no las duplica a propósito: una copia se desactualiza (el estado del trabajo cambia en cada hito) y dos fuentes terminan contradiciéndose. Si algo de aquí choca con `CLAUDE.md`, manda `CLAUDE.md`.

## Lo imprescindible (todo está desarrollado en `CLAUDE.md`)
- Idioma: textos de interfaz, comentarios de producto y commits de documentación en **español**; identificadores de código en **inglés**.
- Documentos que mandan: `docs/BUILD_SPEC.md`, `docs/ADR.md`, `docs/FLUJOS.md`, `docs/DESPLIEGUE_RAILWAY.md`. Si algo contradice un ADR, **para y pregunta**.
- Un hito (y una rebanada) a la vez. No inventes funcionalidades ni supongas lo que hacía el sistema antiguo; no copies código del repo antiguo.
- **Multi-tenancy:** toda tabla de negocio con `organization_id` y RLS forzada; nunca un rol con `BYPASSRLS`; cada endpoint nuevo trae su prueba de aislamiento A↔B.
- **Seguridad:** secretos sin valores por defecto, credenciales de terceros cifradas y nunca devueltas (solo los últimos 4), todo webhook con firma, límite de peticiones e idempotencia, sin PII en logs.
- **Pruebas:** corren contra PostgreSQL real (`TEST_PG_ADMIN_URL`); `pnpm check` = tipos + lint + pruebas. Las reglas de lint (ADR24-P1…P12) no se desactivan con comentarios.
- Commit, push y migraciones en staging solo cuando el responsable de producto lo ordena.
