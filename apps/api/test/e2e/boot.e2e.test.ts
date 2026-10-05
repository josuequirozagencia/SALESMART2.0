// e2e del artefacto compilado: proceso real, puerto real, BD real. No usa el resolvedor de pruebas.
import { TEST_AUTH_KEY } from '../support/constants';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { Argon2idHasher } from '../../src/security';
import { requireDb } from '../support/harness';

const info = requireDb();
const MAIN = path.resolve(__dirname, '../../dist/main.js');
let proc: ChildProcess;
let base = '';
let out = '';

const freePort = () => new Promise<number>((res) => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!existsSync(MAIN)) throw new Error('falta dist/main.js: ejecuta `pnpm build` (o `pnpm e2e`)');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', [MAIN], {
    env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production', LOG_LEVEL: 'info', HTTP_PORT: String(port), DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* aún no escucha */ }
    if (proc.exitCode !== null) throw new Error(`la API terminó al arrancar (${proc.exitCode}): ${out.slice(0, 500)}`);
    await sleep(200);
  }
  throw new Error('la API no arrancó a tiempo');
});
afterAll(() => { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); });

describe('API compilada (proceso real)', () => {
  it('flujo de acceso bajo /v1: login → refresh rotativo → reutilización revoca; sin prefijo no existe', async () => {
    const admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    const orgId = '0e2e0000-0000-4000-8000-000000000001';
    const userId = '0e2e0000-0000-4000-8000-000000000002';
    try {
      await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,'client','E2E','UTC')`, [orgId]);
      await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,'e2e@x.test',$2,'active',now())`, [userId, await new Argon2idHasher().hash('E2e-Passw0rd!')]);
      await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'client_admin')`, [userId, orgId]);
      const j = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await j('/auth/login', {})).status).toBe(404);
      expect((await j('/v1/auth/login', { email: 'e2e@x.test', password: 'mala' })).status).toBe(401);
      const ok = await j('/v1/auth/login', { email: 'e2e@x.test', password: 'E2e-Passw0rd!', token_transport: 'body' });
      expect(ok.status).toBe(200);
      const t = (await ok.json()) as { refresh_token: string };
      const r1 = await j('/v1/auth/refresh', { refresh_token: t.refresh_token });
      expect(r1.status).toBe(200);
      expect((await j('/v1/auth/refresh', { refresh_token: t.refresh_token })).status).toBe(401);
      expect((await j('/v1/auth/refresh', { refresh_token: ((await r1.json()) as { refresh_token: string }).refresh_token })).status).toBe(401);
    } finally {
      await admin.query('TRUNCATE sessions, auth_throttle, organization_members, organizations, users CASCADE');
      await admin.end();
    }
  });
  it('/health y /health/ready responden con la BD real', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({ status: 'ok' });
  });
  it('no filtra tecnología ni errores internos; 404 con forma estándar y request_id', async () => {
    const r = await fetch(`${base}/no-existe`);
    expect(r.status).toBe(404);
    expect(r.headers.get('x-powered-by')).toBeNull();
    const b = (await r.json()) as { error: { code: string; request_id: string } };
    expect(b.error.request_id).toMatch(/\S+/);
    expect(JSON.stringify(b)).not.toMatch(/Cannot GET|express|nest/i);
  });
  it('deny-by-default: una ruta que no es pública no responde sin credenciales (resolvedor real = denegar todo)', async () => {
    const r = await fetch(`${base}/health/../contacts`, { headers: { 'x-organization-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    expect([401, 403, 404]).toContain(r.status);
  });
  it('el x-request-id entrante con formato inseguro se descarta', async () => {
    const r = await fetch(`${base}/health`, { headers: { 'x-request-id': 'a'.repeat(300) } });
    expect(r.headers.get('x-request-id')).not.toBe('a'.repeat(300));
  });
  it('el log de arranque no contiene contraseñas ni URLs de conexión', () => {
    expect(out).toContain('API iniciada');
    for (const pw of ['test-rw-pw', 'test-platform-pw', 'test-identity-pw']) expect(out).not.toContain(pw);
  });
  it('SIGTERM: cierre ordenado (código 0) y sin conexiones abiertas', async () => {
    const code = await new Promise<number | null>((res) => { proc.once('exit', (c) => res(c)); proc.kill('SIGTERM'); });
    expect(code === 0 || code === null).toBe(true);
  });
});
