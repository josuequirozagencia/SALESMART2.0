// ESLint (flat config). Las reglas ADR24-P1…P10 convierten en verificables los patrones prohibidos de
// docs/ADR.md (ADR-24). noInlineConfig: ningún `eslint-disable` puede saltarse una regla (se reporta como warning
// y `--max-warnings 0` lo convierte en fallo).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ADR = 'docs/ADR.md → ADR-24';

/** Selectores `no-restricted-syntax` etiquetados. `allowIn` se resuelve por override de ruta más abajo. */
const SYNTAX = {
  'P1+P5-guc': [
    { selector: 'Literal[value=/set_config|app[.]org_id|\\bset\\s+(local|session)\\s+\\w/i]', message: `ADR24-P1: el contexto de tenant solo lo fija Database.withTenant (set_config local a la transacción). ${ADR}` },
    { selector: 'TemplateElement[value.raw=/set_config|app[.]org_id|\\bset\\s+(local|session)\\s+\\w/i]', message: `ADR24-P1: el contexto de tenant solo lo fija Database.withTenant. ${ADR}` },
  ],
  'P3-env': [
    { selector: 'MemberExpression[object.name="process"][property.name="env"]', message: `ADR24-P3: process.env solo se lee en src/config (loadConfig valida y rechaza roles privilegiados). ${ADR}` },
  ],
  'P4-repo-org-param': [
    { selector: 'ClassDeclaration[id.name=/Repository$/] MethodDefinition > FunctionExpression > Identifier.params[name=/^(org|organization|tenant)(_?id)?$/i]', message: `ADR24-P4: un repositorio no recibe la organización como parámetro; el aislamiento sale de TenantContext + RLS. ${ADR}` },
    { selector: 'ClassDeclaration[id.name=/Repository$/] MethodDefinition > FunctionExpression > ObjectPattern.params > Property[key.name=/^(org|organization|tenant)(_?id)?$/i]', message: `ADR24-P4: un repositorio no recibe la organización dentro de un objeto de parámetros. ${ADR}` },
    { selector: 'ClassDeclaration[id.name=/Repository$/] TSParameterProperty > Identifier[name=/^(org|organization|tenant)(_?id)?$/i]', message: `ADR24-P4: un repositorio no guarda la organización como dependencia. ${ADR}` },
  ],
  'P5-http-org': [
    { selector: 'Identifier[name=/^(org|organization|tenant)(_?id)$/i]', message: `ADR24-P5: controladores/DTOs no leen ni aceptan la organización del cliente; sale de la sesión autenticada. ${ADR}` },
    { selector: 'Literal[value=/^(org|organization|tenant)(_?id)$/i]', message: `ADR24-P5: controladores/DTOs no leen ni aceptan la organización del cliente. ${ADR}` },
  ],
  'P6-sql': [
    { selector: 'CallExpression[callee.object.name="sql"][callee.property.name="raw"]', message: `ADR24-P6: sql.raw prohibido (interpolación sin parametrizar). ${ADR}` },
    { selector: 'CallExpression[callee.property.name=/^(execute|query)$/] > TemplateLiteral[expressions.length>0]', message: `ADR24-P6: SQL con interpolación de plantilla; usa sql\`...\` con parámetros. ${ADR}` },
    { selector: 'CallExpression[callee.property.name=/^(execute|query)$/] > BinaryExpression[operator="+"]', message: `ADR24-P6: SQL por concatenación; usa sql\`...\` con parámetros. ${ADR}` },
  ],
  'P7-advisory': [
    { selector: 'Literal[value=/pg_(try_)?advisory_lock/i]', message: `ADR24-P7: solo pg_advisory_xact_lock (de transacción); los locks de sesión sobreviven en el pool. ${ADR}` },
    { selector: 'TemplateElement[value.raw=/pg_(try_)?advisory_lock/i]', message: `ADR24-P7: solo pg_advisory_xact_lock (de transacción). ${ADR}` },
  ],
  'P8-rls-bypass-sql': [
    { selector: 'Literal[value=/using\\s*\\(\\s*true\\s*\\)|security\\s+definer|\\bbypassrls\\b|disable\\s+row\\s+level/i]', message: `ADR24-P8: USING (true) / SECURITY DEFINER / BYPASSRLS / DISABLE RLS prohibidos fuera de un ADR aprobado. ${ADR}` },
    { selector: 'TemplateElement[value.raw=/using\\s*\\(\\s*true\\s*\\)|security\\s+definer|\\bbypassrls\\b|disable\\s+row\\s+level/i]', message: `ADR24-P8: USING (true) / SECURITY DEFINER / BYPASSRLS prohibidos. ${ADR}` },
  ],
  'P9-casts': [
    { selector: 'TSAsExpression[typeAnnotation.typeName.name=/^(TenantTx|PlatformTx|IdentityTx)$/]', message: `ADR24-P9: no se fabrica un TenantTx/PlatformTx/IdentityTx con 'as'; solo Database.withTenant/withPlatform/withIdentity los producen. ${ADR}` },
    { selector: 'TSTypeAssertion[typeAnnotation.typeName.name=/^(TenantTx|PlatformTx|IdentityTx)$/]', message: `ADR24-P9: no se fabrica un TenantTx/PlatformTx/IdentityTx con una aserción. ${ADR}` },
  ],
  'P10-platform': [
    { selector: 'CallExpression[callee.property.name="withPlatform"]', message: `ADR24-P10: withPlatform solo puede usarse desde src/modules/platform. ${ADR}` },
    { selector: 'CallExpression[callee.object.name="PlatformContext"][callee.property.name="run"]', message: `ADR24-P10: PlatformContext.run solo puede usarse desde src/modules/platform (o el borde de autenticación de plataforma). ${ADR}` },
  ],
  'P12-identity': [
    { selector: 'CallExpression[callee.property.name="withIdentity"]', message: `ADR24-P12 (ADR-25): withIdentity solo puede usarse desde src/modules/auth y src/modules/organizations. ${ADR}` },
  ],
};

const syntaxRule = (omit = []) => ['error', ...Object.entries(SYNTAX).filter(([k]) => !omit.includes(k) && k !== 'P5-http-org').flatMap(([, v]) => v)];
const syntaxRuleHttp = (omit = []) => ['error', ...Object.entries(SYNTAX).filter(([k]) => !omit.includes(k)).flatMap(([, v]) => v)];

const msgP2 = (what) => `ADR24-P2: ${what} solo se importa dentro de src/db (la app usa Database.withTenant). ${ADR}`;
const importsRule = (allow = []) => {
  const paths = [
    { name: 'pg', message: msgP2('pg') },
    { name: 'pg-pool', message: msgP2('pg-pool') },
    { name: 'postgres', message: msgP2('postgres') },
    { name: 'drizzle-orm/node-postgres', message: msgP2('drizzle-orm/node-postgres') },
    { name: 'drizzle-orm/postgres-js', message: msgP2('drizzle-orm/postgres-js') },
    { name: 'drizzle-orm/pg-core', importNames: ['pgTable', 'pgPolicy', 'pgView', 'pgMaterializedView', 'pgSchema'], message: `ADR24-P8: declara tablas con tenantTable()/platformTable() (db/schema/helpers); pgTable/pgPolicy/pgView directos eluden RLS. ${ADR}` },
    { name: 'pino', message: 'LOGGER-PII: usa el logger de src/logger (redacción de PII); pino directo no redacta.' },
  ].filter((p) => !allow.includes(p.name));
  const patterns = allow.includes('db-internals') ? [] : [
    { group: ['**/db/database', '**/db/guarded-client', '**/db/roles', '**/db/migrate', '**/db/types', '**/db/schema/*', '**/db/audit/*', '**/db/errors'], message: `ADR24-P2: importa solo desde la API pública de src/db (index). ${ADR}` },
  ];
  return ['error', { paths, patterns }];
};

const TS_FILES = ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'spikes/**', 'prototype/**', 'docs/**', '**/migrations/**', 'apps/web/**', 'packages/ui/**'] },
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': ['error', { fixToUnknown: false }],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false, 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  // ── Reglas con tipos (solo src de la API): errores de promesas y aserciones inútiles ───────────────
  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  // ── Código de producción: reglas ADR-24 ────────────────────────────────────────────────────────
  {
    files: TS_FILES,
    rules: { 'no-restricted-syntax': syntaxRule(), 'no-restricted-imports': importsRule() },
  },
  // Capa HTTP: además, nada de organización en controladores/DTOs
  {
    files: ['apps/api/src/**/*.controller.ts', 'apps/api/src/**/*.dto.ts', 'apps/api/src/**/*.guard.ts'],
    rules: { 'no-restricted-syntax': syntaxRuleHttp() },
  },
  // Configuración: único lugar con process.env
  {
    files: ['apps/api/src/config/**/*.ts'],
    rules: { 'no-restricted-syntax': syntaxRule(['P3-env']) },
  },
  // Logger: único lugar con pino
  {
    files: ['apps/api/src/logger/**/*.ts'],
    rules: { 'no-restricted-imports': importsRule(['pino']) },
  },
  // Capa de datos: único lugar con pg/drizzle, set_config y pgTable
  {
    files: ['apps/api/src/db/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntaxRule(['P1+P5-guc', 'P8-rls-bypass-sql', 'P9-casts', 'P10-platform', 'P12-identity']),
      'no-restricted-imports': importsRule(['pg', 'drizzle-orm/node-postgres', 'drizzle-orm/pg-core', 'db-internals']),
    },
  },
  // Herramientas de línea de comandos dentro de db/ (no corren en la API)
  {
    files: ['apps/api/src/db/migrate-cli.ts', 'apps/api/src/db/audit/cli.ts', 'apps/api/src/db/load-disposable-domains.cli.ts'],
    rules: { 'no-restricted-syntax': syntaxRule(['P1+P5-guc', 'P3-env', 'P8-rls-bypass-sql', 'P9-casts', 'P10-platform', 'P12-identity']) },
  },
  // Identidad (ADR-25): únicos módulos autorizados a usar withIdentity. El CLI de bootstrap además lee process.env.
  {
    files: ['apps/api/src/modules/auth/**/*.ts', 'apps/api/src/modules/organizations/**/*.ts'],
    rules: { 'no-restricted-syntax': syntaxRule(['P12-identity']) },
  },
  {
    files: ['apps/api/src/modules/auth/**/*.cli.ts'],
    rules: { 'no-restricted-syntax': syntaxRule(['P12-identity', 'P3-env']) },
  },
  // Módulo de plataforma (futuro): puede usar withPlatform
  {
    files: ['apps/api/src/modules/platform/**/*.ts', 'apps/api/src/http/context.interceptor.ts'],
    rules: { 'no-restricted-syntax': syntaxRule(['P10-platform']) },
  },
  // Tests: pueden atacar la base de datos directamente (es su función). Siguen sin poder desactivar reglas.
  {
    files: ['apps/api/test/**/*.ts', 'apps/api/*.ts', '*.mjs'],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },
);
