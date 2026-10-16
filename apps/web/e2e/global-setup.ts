import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..');
const REPO = path.resolve(WEB, '../..');
const API_DIST = path.join(REPO, 'apps/api/dist');
export const RUN_DIR = path.join(here, '.run');
export const STATE_FILE = path.join(RUN_DIR, 'state.json');
export const API_LOG = path.join(RUN_DIR, 'api.log');

export interface E2EState { adminDbUrl: string; rootEmail: string; rootPassword: string; apiBase: string }

const rnd = (n = 24) => randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const urlFor = (base: string, user: string, password: string, db: string): string => {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
};

async function waitFor(url: string, proc: ChildProcess, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* aún no escucha */ }
    if (proc.exitCode !== null) throw new Error(`${what} terminó al arrancar (código ${proc.exitCode}); revisa ${API_LOG}`);
    await sleep(200);
  }
  throw new Error(`${what} no arrancó a tiempo`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = process.env['TEST_PG_ADMIN_URL'];
  if (!adminUrl) throw new Error('TEST_PG_ADMIN_URL no definido: el E2E necesita un PostgreSQL desechable (superusuario). Ver docs/M1_PROGRESO.md');
  for (const f of ['main.js', 'db/migrate-cli.js', 'modules/auth/bootstrap-super-admin.cli.js']) {
    if (!existsSync(path.join(API_DIST, f))) throw new Error(`falta apps/api/dist/${f}: ejecuta \`pnpm build\` antes del E2E`);
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });

  // 1) Base de datos efímera con los 4 roles reales y las migraciones
  const name = `ss_e2e_${rnd(4).toLowerCase()}`;
  const pw = { owner: rnd(), rw: rnd(), platform: rnd(), identity: rnd() };
  execFileSync('bash', [path.join(REPO, 'scripts/db-bootstrap.sh')], {
    env: { ...process.env, DB_ADMIN_URL: adminUrl, DB_NAME: name, APP_OWNER_PASSWORD: pw.owner, APP_RW_PASSWORD: pw.rw, APP_PLATFORM_PASSWORD: pw.platform, APP_IDENTITY_PASSWORD: pw.identity },
    stdio: 'pipe',
  });
  const ownerUrl = urlFor(adminUrl, 'app_owner', pw.owner, name);
  const adminDbUrl = urlFor(adminUrl, decodeURIComponent(new URL(adminUrl).username), decodeURIComponent(new URL(adminUrl).password), name);
  const node = process.execPath;
  const toolEnv = { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', DATABASE_URL_OWNER: ownerUrl };
  execFileSync(node, [path.join(API_DIST, 'db/migrate-cli.js')], { env: toolEnv, stdio: 'pipe' });
  execFileSync(node, [path.join(API_DIST, 'db/load-disposable-domains.cli.js'), path.join(REPO, 'data/disposable_email_blocklist.conf')], { env: toolEnv, stdio: 'pipe' });

  const apiPort = Number(process.env['E2E_PORT'] ?? 3100);
  // La web compilada (con el CAPTCHA «fake») la sirve la propia API: UN solo origen, como en producción (ADR-36), con su CSP
  const vite = path.join(WEB, 'node_modules/vite/bin/vite.js');
  execFileSync(node, [vite, 'build', '--outDir', 'dist-e2e', '--emptyOutDir'], { cwd: WEB, env: { ...process.env, VITE_CAPTCHA_PROVIDER: 'fake' }, stdio: 'pipe' });
  const apiEnv = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    HTTP_PORT: String(apiPort),
    DATABASE_URL_APP: urlFor(adminUrl, 'app_rw', pw.rw, name),
    DATABASE_URL_PLATFORM: urlFor(adminUrl, 'app_platform', pw.platform, name),
    DATABASE_URL_IDENTITY: urlFor(adminUrl, 'app_identity', pw.identity, name),
    AUTH_THROTTLE_KEY: rnd(40),
    // Bóveda de credenciales de proveedores (ADR-42): 32 bytes aleatorios por ejecución
    PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64'),
    // Solo E2E: el código de verificación se imprime en el log (la prueba lo lee) y el CAPTCHA acepta «fake-pass»
    MAIL_PROVIDER: 'console',
    CAPTCHA_PROVIDER: 'fake',
    FRONTEND_BASE_URL: `http://127.0.0.1:${apiPort}`,
    WEB_DIST_DIR: path.join(WEB, 'dist-e2e'),
    // Todas las pruebas salen de la misma IP: límites holgados (los límites en sí los cubre la suite de la API)
    SIGNUP_IP_MAX_PER_HOUR: '200',
    SIGNUP_VERIFY_IP_MAX_PER_HOUR: '500',
    RESET_IP_MAX_PER_HOUR: '200',
    RESET_ATTEMPT_IP_MAX_PER_HOUR: '500',
    AUTH_IP_LOCK_THRESHOLD: '500',
  };

  // 2) super_admin para las pruebas que aprueban extensiones
  const rootEmail = 'root-e2e@plataforma.test';
  const boot = execFileSync(node, [path.join(API_DIST, 'modules/auth/bootstrap-super-admin.cli.js')], { env: { ...apiEnv, BOOTSTRAP_SUPER_ADMIN_EMAIL: rootEmail }, encoding: 'utf8' });
  const rootPassword = boot.trim().split('\n').pop()?.trim();
  if (!rootPassword) throw new Error('el bootstrap del super_admin no devolvió contraseña');

  // 3) API compilada (su salida se guarda: el código de verificación llega por el log)
  const log = createWriteStream(API_LOG);
  const api = spawn(node, [path.join(API_DIST, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout?.pipe(log, { end: false });
  api.stderr?.pipe(log, { end: false });
  await waitFor(`http://127.0.0.1:${apiPort}/health`, api, 'la API');

  const state: E2EState = { adminDbUrl, rootEmail, rootPassword, apiBase: `http://127.0.0.1:${apiPort}` };
  writeFileSync(STATE_FILE, JSON.stringify(state));

  return async () => {
    if (api.exitCode === null) api.kill('SIGKILL');
    log.end();
    await sleep(300);
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await c.end();
    }
    rmSync(path.join(WEB, 'dist-e2e'), { recursive: true, force: true });
  };
}
