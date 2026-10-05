// Los patrones prohibidos de ADR-24 (P1–P10) son reglas VERIFICABLES: cada una tiene casos que deben fallar
// y controles que deben pasar (en la ubicación donde el patrón sí está permitido).
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
// Los casos usan archivos virtuales (no existen en el proyecto de TypeScript): se desactivan SOLO las reglas con tipos;
// éstas se prueban aparte, sobre un archivo real, en el último bloque.
const TYPED = ['no-floating-promises', 'no-misused-promises', 'await-thenable', 'no-unnecessary-type-assertion', 'only-throw-error', 'require-await'].map((r) => `@typescript-eslint/${r}`);
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, 'eslint.config.mjs'),
  overrideConfig: { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: false, project: null } }, rules: Object.fromEntries(TYPED.map((r) => [r, 'off'])) },
});
const typedEslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'eslint.config.mjs') });

async function lint(code: string, file: string) {
  const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return r!.messages;
}
const adr = (m: Array<{ message: string }>) => m.map((x) => /(ADR24-P\d+|LOGGER-PII)/.exec(x.message)?.[1]).filter(Boolean) as string[];

const CRM = 'apps/api/src/modules/crm/contacts.service.ts';
const REPO = 'apps/api/src/modules/crm/contacts.repository.ts';
const CTRL = 'apps/api/src/modules/crm/contacts.controller.ts';
const DTO = 'apps/api/src/modules/crm/contacts.dto.ts';
const PLAT = 'apps/api/src/modules/platform/orgs.service.ts';
const DB = 'apps/api/src/db/something.ts';
const CFG = 'apps/api/src/config/x.ts';
const GUARD = 'apps/api/src/http/other.guard.ts';
const HTTP_OTHER = 'apps/api/src/http/other.ts';
const AUTH = 'apps/api/src/modules/auth/login.service.ts';
const ORGS = 'apps/api/src/modules/organizations/orgs.service.ts';
const AUTH_CLI = 'apps/api/src/modules/auth/bootstrap-super-admin.cli.ts';
const INTERCEPTOR = 'apps/api/src/http/context.interceptor.ts';

type Case = [id: string, label: string, file: string, code: string];

const MUST_FAIL: Case[] = [
  ['ADR24-P1', 'set_config en módulo de negocio', CRM, "export const q = sql`SELECT set_config('app.org_id', ${x}, false)`;"],
  ['ADR24-P1', 'SET LOCAL app.* en cadena', CRM, "export const q = 'SET LOCAL app.org_id = 1';"],
  ['ADR24-P1', 'mención de app.org_id en plantilla', CRM, 'export const q = `${a} app.org_id`;'],
  ['ADR24-P2', "import { Pool } from 'pg'", CRM, "import { Pool } from 'pg'; export const p = Pool;"],
  ['ADR24-P2', 'drizzle() node-postgres fuera de db/', CRM, "import { drizzle } from 'drizzle-orm/node-postgres'; export const d = drizzle;"],
  ['ADR24-P2', 'pg-pool', CRM, "import Pool from 'pg-pool'; export default Pool;"],
  ['ADR24-P2', 'import interno de db/ (database)', CRM, "import { Database } from '../../db/database'; export const d = Database;"],
  ['ADR24-P2', 'import interno de db/ (guarded-client)', CRM, "import { guardClient } from '../../db/guarded-client'; export const g = guardClient;"],
  ['LOGGER-PII', 'pino directo (sin redacción)', CRM, "import pino from 'pino'; export const l = pino();"],
  ['ADR24-P8', 'pgTable directo (elude tenantTable)', CRM, "import { pgTable } from 'drizzle-orm/pg-core'; export const t = pgTable;"],
  ['ADR24-P8', 'pgPolicy directo', CRM, "import { pgPolicy } from 'drizzle-orm/pg-core'; export const t = pgPolicy;"],
  ['ADR24-P3', 'process.env fuera de config', CRM, 'export const u = process.env.DATABASE_URL_OWNER;'],
  ['ADR24-P3', "process.env['X'] fuera de config", CRM, "export const u = process.env['X'];"],
  ['ADR24-P4', 'repositorio con parámetro orgId', REPO, 'export class ContactsRepository { find(orgId: string) { return orgId; } }'],
  ['ADR24-P4', 'repositorio con organizationId', REPO, 'export class ContactsRepository { find(organizationId: string) { return organizationId; } }'],
  ['ADR24-P4', 'repositorio con objeto { organizationId }', REPO, 'export class ContactsRepository { find({ organizationId }: { organizationId: string }) { return organizationId; } }'],
  ['ADR24-P4', 'repositorio guarda tenantId inyectado', REPO, 'export class ContactsRepository { constructor(private readonly tenantId: string) {} }'],
  ['ADR24-P5', 'controlador lee organizationId del body', CTRL, 'export class C { f(req: { body: { organizationId: string } }) { return req.body.organizationId; } }'],
  ['ADR24-P5', "controlador lee 'x-org-id' como clave organization_id", CTRL, "export class C { f(q: Record<string, string>) { return q['organization_id']; } }"],
  ['ADR24-P5', 'DTO acepta organizationId', DTO, 'export const dto = { organizationId: 1 };'],
  ['ADR24-P6', 'sql.raw', CRM, "import { sql } from 'drizzle-orm'; export const q = sql.raw('select 1');"],
  ['ADR24-P6', 'execute con plantilla interpolada', CRM, 'export const f = (tx: { execute(q: string): unknown }, id: string) => tx.execute(`select * from t where id = ${id}`);'],
  ['ADR24-P6', 'query por concatenación', CRM, "export const f = (c: { query(q: string): unknown }, id: string) => c.query('select * from t where id = ' + id);"],
  ['ADR24-P5', 'guard que lee la organización de la petición', GUARD, "export const g = (req: { headers: Record<string, string> }) => req.headers['x-organization-id'] ?? (req as unknown as { organizationId: string }).organizationId;"],
  ['ADR24-P10', 'PlatformContext.run fuera del borde autorizado (http/otro)', HTTP_OTHER, "import { PlatformContext } from '../tenant'; export const f = () => PlatformContext.run({ actorUserId: 'x' }, () => 1);"],
  ['ADR24-P7', 'pg_advisory_lock de sesión', CRM, "export const q = 'SELECT pg_advisory_lock(1)';"],
  ['ADR24-P7', 'pg_try_advisory_lock', CRM, 'export const q = `SELECT pg_try_advisory_lock(1)`;'],
  ['ADR24-P8', 'USING (true)', CRM, "export const q = 'CREATE POLICY p ON t USING (true)';"],
  ['ADR24-P8', 'SECURITY DEFINER', CRM, "export const q = 'CREATE FUNCTION f() SECURITY DEFINER';"],
  ['ADR24-P8', 'BYPASSRLS', CRM, "export const q = 'ALTER ROLE x BYPASSRLS';"],
  ['ADR24-P9', 'cast `as TenantTx`', CRM, "import type { TenantTx } from '../../db'; export const f = (x: unknown) => x as TenantTx;"],
  ['ADR24-P9', 'cast `<PlatformTx>`', CRM, "import type { PlatformTx } from '../../db'; export const f = (x: unknown) => <PlatformTx>x;"],
  ['ADR24-P12', 'withIdentity desde un módulo de negocio', CRM, 'export const f = (db: { withIdentity(fn: () => void): void }) => db.withIdentity(() => undefined);'],
  ['ADR24-P12', 'withIdentity desde http/', HTTP_OTHER, 'export const f = (db: { withIdentity(fn: () => void): void }) => db.withIdentity(() => undefined);'],
  ['ADR24-P12', 'withIdentity desde el módulo platform', PLAT, 'export const f = (db: { withIdentity(fn: () => void): void }) => db.withIdentity(() => undefined);'],
  ['ADR24-P9', 'cast `as IdentityTx`', CRM, "import type { IdentityTx } from '../../db'; export const f = (x: unknown) => x as IdentityTx;"],
  ['ADR24-P10', 'withPlatform desde el módulo auth', AUTH, 'export const f = (db: { withPlatform(fn: () => void): void }) => db.withPlatform(() => undefined);'],
  ['ADR24-P10', 'withPlatform fuera del módulo platform', CRM, 'export const f = (db: { withPlatform(fn: () => void): void }) => db.withPlatform(() => undefined);'],
  ['ADR24-P10', 'PlatformContext.run fuera del módulo platform', CRM, "import { PlatformContext } from '../../tenant'; export const f = () => PlatformContext.run({ actorUserId: 'x' }, () => 1);"],
];

describe('reglas ESLint ADR-24 — casos que DEBEN fallar', () => {
  it.each(MUST_FAIL)('%s — %s', async (id, _label, file, code) => {
    expect(adr(await lint(code, file))).toContain(id);
  });

  it('as any está prohibido (P9)', async () => {
    const m = await lint('export const f = (x: unknown) => x as any;', CRM);
    expect(m.some((x) => x.ruleId === '@typescript-eslint/no-explicit-any')).toBe(true);
  });
  it('console.* está prohibido (usar el logger)', async () => {
    const m = await lint("console.log('x');", CRM);
    expect(m.some((x) => x.ruleId === 'no-console')).toBe(true);
  });
  it('@ts-ignore y @ts-expect-error sin descripción están prohibidos', async () => {
    const a = await lint('// @ts-ignore\nexport const x: number = "a";', CRM);
    const b = await lint('// @ts-expect-error\nexport const x: number = "a";', CRM);
    expect(a.some((x) => x.ruleId === '@typescript-eslint/ban-ts-comment')).toBe(true);
    expect(b.some((x) => x.ruleId === '@typescript-eslint/ban-ts-comment')).toBe(true);
  });
});

describe('las reglas no se pueden desactivar con comentarios (noInlineConfig)', () => {
  it('eslint-disable no evita el error y además se reporta', async () => {
    const m = await lint("/* eslint-disable no-restricted-syntax */\nexport const q = sql.raw('x');", CRM);
    expect(adr(m)).toContain('ADR24-P6');
    expect(m.some((x) => /noInlineConfig/.test(x.message))).toBe(true);
  });
  it('eslint-disable-next-line tampoco', async () => {
    const m = await lint("// eslint-disable-next-line no-restricted-imports\nimport { Pool } from 'pg';\nexport default Pool;", CRM);
    expect(adr(m)).toContain('ADR24-P2');
  });
});

describe('controles: el código correcto y las ubicaciones permitidas NO fallan', () => {
  const MUST_PASS: Array<[string, string, string]> = [
    ['servicio de negocio limpio', CRM, "import { Database } from '../../db'; export class S { constructor(private readonly db: Database) {} list() { return this.db.withTenant(async () => []); } }"],
    ['repositorio sin organización', REPO, 'export class ContactsRepository { find(id: string) { return id; } }'],
    ['servicio (no repositorio) puede llamar a su parámetro orgId?', CRM, 'export class S { f(orgId: string) { return orgId; } }'],
    ['controlador sin organización', CTRL, 'export class C { f(id: string) { return id; } }'],
    ['advisory lock de transacción', CRM, 'export const q = `SELECT pg_advisory_xact_lock(1)`;'],
    ['SQL parametrizado con sql``', CRM, "import { sql } from 'drizzle-orm'; export const q = (id: string) => sql`select * from t where id = ${id}`;"],
    ['módulo platform puede usar withPlatform', PLAT, 'export const f = (db: { withPlatform(fn: () => void): void }) => db.withPlatform(() => undefined);'],
    ['db/ puede importar pg y fijar el contexto', DB, "import { Pool } from 'pg'; export const q = \"SELECT set_config('app.org_id', $1, true)\"; export { Pool };"],
    ['config/ puede leer process.env', CFG, 'export const e = process.env;'],
    ['el interceptor de contexto (único borde HTTP) puede usar PlatformContext.run', INTERCEPTOR, "import { PlatformContext } from '../tenant'; export const f = () => PlatformContext.run({ actorUserId: 'x' }, () => 1);"],
    ['módulo auth puede usar withIdentity', AUTH, 'export const f = (db: { withIdentity(fn: () => void): void }) => db.withIdentity(() => undefined);'],
    ['módulo organizations puede usar withIdentity', ORGS, 'export const f = (db: { withIdentity(fn: () => void): void }) => db.withIdentity(() => undefined);'],
    ['CLI de bootstrap (auth) puede leer process.env', AUTH_CLI, 'export const e = process.env;'],
    ['importar la API pública de db/', CRM, "import { Database, tenantTable } from '../../db'; export { Database, tenantTable };"],
  ];
  it.each(MUST_PASS)('%s', async (_n, file, code) => {
    expect(adr(await lint(code, file))).toEqual([]);
  });

  it('el módulo auth (no CLI) NO puede leer process.env', async () => {
    expect(adr(await lint('export const e = process.env;', AUTH))).toContain('ADR24-P3');
  });

  it('db/ NO puede leer process.env (solo config/ y las CLI)', async () => {
    expect(adr(await lint('export const e = process.env;', DB))).toContain('ADR24-P3');
  });
});

describe('reglas con tipos (promesas) sobre un archivo real del proyecto', () => {
  const REAL = path.join(ROOT, 'apps/api/src/health/health.controller.ts');
  const run = async (code: string) => (await typedEslint.lintText(code, { filePath: REAL }))[0]!.messages.map((m) => m.ruleId);
  it('promesa sin await/catch → no-floating-promises', async () => {
    expect(await run('const f = async (): Promise<void> => { await Promise.resolve(); };\nf();\nexport {};')).toContain('@typescript-eslint/no-floating-promises');
  });
  it('promesa en un if → no-misused-promises', async () => {
    expect(await run('const f = (): Promise<boolean> => Promise.resolve(true);\nif (f()) { /* x */ }\nexport {};')).toContain('@typescript-eslint/no-misused-promises');
  });
  it('código correcto no falla', async () => {
    expect(await run('export const f = async (): Promise<number> => { await Promise.resolve(); return 1; };')).toEqual([]);
  });
});
