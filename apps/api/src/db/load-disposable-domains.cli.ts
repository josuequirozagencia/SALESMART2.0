/* CLI: pnpm db:load-disposable-domains [archivo]. Por defecto data/disposable_email_blocklist.conf (raíz del repo). */
import path from 'node:path';
import { loadDisposableDomains } from './load-disposable-domains';

const url = process.env['DATABASE_URL_OWNER'];
if (!url) {
  process.stderr.write('db:load-disposable-domains: define DATABASE_URL_OWNER (rol app_owner)\n');
  process.exit(2);
}
const file = process.argv[2] ?? path.resolve(__dirname, '../../../../data/disposable_email_blocklist.conf');
loadDisposableDomains(url, file).then(
  (r) => process.stdout.write(`db:load-disposable-domains OK: ${r.read} leídos, ${r.inserted} nuevos, ${r.skipped} descartados\n`),
  (e: unknown) => {
    process.stderr.write(`db:load-disposable-domains ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
