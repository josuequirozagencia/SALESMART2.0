/* Herramienta de línea de comandos (no forma parte del runtime de la API). */
import { Client } from 'pg';
import { PRODUCTION_CATALOG } from './catalog';
import { auditDatabase } from './schema-audit';

async function main() {
  const url = process.env['DATABASE_URL_OWNER'] ?? process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('Define DATABASE_URL_OWNER (o DATABASE_URL_APP) para auditar');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const violations = await auditDatabase(c, PRODUCTION_CATALOG);
    if (violations.length === 0) {
      process.stdout.write('db:audit OK — sin violaciones de ADR-24\n');
      return;
    }
    for (const x of violations) process.stderr.write(`[${x.code}] ${x.object}: ${x.message}\n`);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}
main().catch((e: unknown) => {
  process.stderr.write(`db:audit ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
