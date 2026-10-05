/* CLI de migraciones: se ejecuta con el rol app_owner, NUNCA desde la API. */
import { runMigrations } from './migrate';

const url = process.env['DATABASE_URL_OWNER'];
if (!url) {
  process.stderr.write('db:migrate: define DATABASE_URL_OWNER (rol app_owner)\n');
  process.exit(2);
}
runMigrations(url).then(
  () => process.stdout.write('db:migrate OK\n'),
  (e: unknown) => {
    process.stderr.write(`db:migrate ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
