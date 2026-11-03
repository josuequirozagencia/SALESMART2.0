/* CLI: vuelve a borrar las empresas ya purgadas tras restaurar una copia de seguridad. Se ejecuta con el rol app_owner, NUNCA desde la API. Ver docs/RESTAURACION_Y_BORRADOS.md */
import { readFileSync } from 'node:fs';
import { parseOrgIds, reapplyPurges } from './reapply-purges';

const url = process.env['DATABASE_URL_OWNER'];
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--actor');
const actorIdx = args.indexOf('--actor');
const actor = actorIdx >= 0 ? args[actorIdx + 1] : undefined;
if (!url || !file || !actor) {
  process.stderr.write('Uso: DATABASE_URL_OWNER=<app_owner> pnpm db:reapply-purges <archivo-con-ids-de-empresas> --actor <id-de-un-super-admin>\n');
  process.exit(2);
}
reapplyPurges(url, parseOrgIds(readFileSync(file, 'utf8')), actor).then(
  (results) => {
    for (const r of results) process.stdout.write(`${r.outcome.padEnd(14)} ${r.organizationId}${r.detail ? `  (${r.detail})` : ''}\n`);
    process.stdout.write(`db:reapply-purges OK: ${results.filter((r) => r.outcome === 'purged').length} borradas, ${results.filter((r) => r.outcome !== 'purged').length} sin cambios\n`);
  },
  (e: unknown) => {
    process.stderr.write(`db:reapply-purges ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
