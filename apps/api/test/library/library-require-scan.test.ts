// V21 — Biblioteca con REQUIRE_VIRUS_SCAN=true y sin antivirus (ADR-75 #5): el archivo se guarda («sin revisar») pero no se puede compartir con los asesores ni con la IA.
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { LibraryModule } from '../../src/modules/library';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QuickRepliesModule } from '../../src/modules/quick-replies';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, LibraryModule, QuickRepliesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = { platformOrg: '00000000-0000-4000-8000-0000000000f0', alice: 'a0000000-0000-4000-8000-00000000000a', carol: 'c0000000-0000-4000-8000-0000000000c3' };

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE quick_reply_assets, quick_replies, media_assets, media_folders, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte']] as const) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, r] of [[IDS.alice, 'client_admin'], [IDS.carol, 'advisor']] as const) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, ORG_A, r]);
}
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 5)]);
const up = (token: string) => fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-filename': 'a.jpg', authorization: `Bearer ${token}` }, body: JPEG });

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'none', REQUIRE_VIRUS_SCAN: 'true' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test') };
});

describe('antivirus obligatorio y sin antivirus', () => {
  it('el archivo se guarda «sin revisar» pero queda fuera del alcance de los asesores; marcarlo para asesores o para la IA da 409 hasta que haya antivirus', async () => {
    const r = await up(T.alice);
    expect(r.status).toBe(201);
    const a = (await r.json()) as { id: string; scan_status: string; usable_by_advisors: boolean; usable_by_ai: boolean };
    expect(a).toMatchObject({ scan_status: 'skipped', usable_by_advisors: false, usable_by_ai: false });
    expect(((await (await call('GET', '/library', T.carol)).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.carol)).status).toBe(404);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.alice)).status).toBe(200); // el administrador sí lo ve
    for (const body of [{ usable_by_advisors: true }, { usable_by_ai: true }]) {
      const p = await call('PATCH', `/library/assets/${a.id}`, T.alice, body);
      expect(p.status, JSON.stringify(body)).toBe(409);
      expect(((await p.json()) as { error: { code: string } }).error.code).toBe('VIRUS_SCAN_REQUIRED');
    }
    expect((await call('PATCH', `/library/assets/${a.id}`, T.alice, { name: 'Renombrado', usable_by_advisors: false })).status).toBe(200); // lo demás sigue permitido
    expect((await admin.query(`SELECT usable_by_advisors FROM media_assets`)).rows).toEqual([{ usable_by_advisors: false }]);
  });

  it('una respuesta rápida no puede enlazar un archivo sin revisar', async () => {
    const a = (await (await up(T.alice)).json()) as { id: string };
    const r = await call('POST', '/quick-replies', T.alice, { shortcut: 'foto', body: 'Mira', asset_ids: [a.id] });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('VIRUS_SCAN_REQUIRED');
    expect((await admin.query('SELECT count(*)::int n FROM quick_replies')).rows[0].n).toBe(0);
  });
});
