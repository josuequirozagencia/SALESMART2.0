// ADR-37 — el cableado de los proveedores REALES (Resend y Turnstile) dentro de la API, con la red externa simulada.
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { CAPTCHA_VERIFIER, MAIL_PROVIDER } from '../../src/modules/auth/signup';
import { ResendMailProvider } from '../../src/mail/resend.provider';
import { TurnstileVerifier } from '../../src/modules/auth/signup/turnstile.verifier';
import { Argon2idHasher } from '../../src/security';
import { TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
let admin: Client;
let app: INestApplication;
let base = '';
const saved = { ...process.env };
const realFetch = globalThis.fetch;

interface External { url: string; init: RequestInit }
const external: External[] = [];
const behaviour = { turnstile: 'ok' as 'ok' | 'down', resend: 'ok' as 'ok' | 'down' };

/** Las llamadas a la propia API pasan; las externas (Resend, Turnstile) se registran y se responden según `behaviour`. */
const stub = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
  external.push({ url, init: init ?? {} });
  if (url.includes('challenges.cloudflare.com')) {
    if (behaviour.turnstile === 'down') return new Response('{}', { status: 500 });
    const token = new URLSearchParams(String(init?.body)).get('response');
    return new Response(JSON.stringify({ success: token === 'token-valido' }), { status: 200 });
  }
  if (url.includes('api.resend.com')) return behaviour.resend === 'down' ? new Response(JSON.stringify({ name: 'application_error', message: 'boom' }), { status: 500 }) : new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  throw new Error(`llamada externa inesperada: ${url}`);
}) as typeof fetch;

const sent = () => external.filter((e) => e.url.includes('api.resend.com'));
const bodyOf = (e: External) => JSON.parse(String(e.init.body)) as { from: string; to: string[]; subject: string; html: string; text: string };
const post = (path: string, body: unknown) => fetch(`${base}/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const reg = (email: string, captcha = 'token-valido') => ({ email, password: PW, full_name: 'Ana Pérez', phone: '+593987654321', organization_name: 'Mi Empresa SA', captcha_token: captcha });

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  Object.assign(process.env, {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY,
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_1234567890abcdef', MAIL_FROM: 'Sales Smart <no-reply@growthconsulting.digital>', FRONTEND_BASE_URL: 'https://app.growthconsulting.digital',
    CAPTCHA_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', SIGNUP_IP_MAX_PER_HOUR: '200', SIGNUP_VERIFY_IP_MAX_PER_HOUR: '500', RESET_IP_MAX_PER_HOUR: '200',
  });
  delete process.env['DATABASE_URL_OWNER'];
  vi.stubGlobal('fetch', stub); // antes de arrancar: los adaptadores toman `fetch` al construirse
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app.close(); await admin.end(); vi.unstubAllGlobals(); process.env = saved; });
beforeEach(async () => {
  external.length = 0;
  behaviour.turnstile = 'ok';
  behaviour.resend = 'ok';
  await admin.query('TRUNCATE sessions, auth_throttle, email_verifications, signup_attempts, password_resets, trials, organization_members, organizations, users CASCADE');
});

describe('proveedores reales cableados', () => {
  it('MAIL_PROVIDER=resend y CAPTCHA_PROVIDER=turnstile instancian los adaptadores reales (no los fakes)', () => {
    expect(app.get(MAIL_PROVIDER, { strict: false })).toBeInstanceOf(ResendMailProvider);
    expect(app.get(CAPTCHA_VERIFIER, { strict: false })).toBeInstanceOf(TurnstileVerifier);
  });

  it('flujo completo: signup (Turnstile verifica el token y la IP) → correo por Resend → el código del correo verifica → login', async () => {
    expect((await post('/auth/signup', reg('ana@empresa.test'))).status).toBe(202);
    const ts = external.find((e) => e.url.includes('challenges.cloudflare.com'))!;
    const form = new URLSearchParams(String(ts.init.body));
    expect(form.get('secret')).toBe('1x0000000000000000000000000000000AA');
    expect(form.get('response')).toBe('token-valido');
    expect(sent()).toHaveLength(1);
    const mail = bodyOf(sent()[0]!);
    expect(mail.to).toEqual(['ana@empresa.test']);
    expect(mail.from).toBe('Sales Smart <no-reply@growthconsulting.digital>');
    const code = />(\d{6})</.exec(mail.html)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect((sent()[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer re_test_1234567890abcdef');
    expect((await post('/auth/verify', { email: 'ana@empresa.test', code })).status).toBe(200);
    expect((await post('/auth/login', { email: 'ana@empresa.test', password: PW, token_transport: 'body' })).status).toBe(200);
  });

  it('un token rechazado por Turnstile → 400 CAPTCHA_FAILED, no se crea nada y NO se envía correo', async () => {
    const r = await post('/auth/signup', reg('bot@empresa.test', 'token-falso'));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('CAPTCHA_FAILED');
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    expect(sent()).toHaveLength(0);
  });

  it('caída de Turnstile: FALLA CERRADO (400 CAPTCHA_FAILED), jamás deja pasar; sin correo ni cuenta', async () => {
    behaviour.turnstile = 'down';
    const r = await post('/auth/signup', reg('x@empresa.test'));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('CAPTCHA_FAILED');
    expect(sent()).toHaveLength(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });

  it('caída de Resend: el registro responde igual (202, sin revelar nada) y el usuario puede reenviar cuando se recupere', async () => {
    behaviour.resend = 'down';
    expect((await post('/auth/signup', reg('r@empresa.test'))).status).toBe(202);
    expect(sent()).toHaveLength(1); // se intentó
    expect((await admin.query(`SELECT count(*)::int AS n FROM email_verifications`)).rows[0].n).toBe(1); // el código quedó guardado
    behaviour.resend = 'ok';
    await admin.query(`UPDATE email_verifications SET last_sent_at = now() - interval '1 hour'`); // sin esperar el enfriamiento
    expect((await post('/auth/resend', { email: 'r@empresa.test', captcha_token: 'token-valido' })).status).toBe(202);
    expect(sent()).toHaveLength(2);
    const code = />(\d{6})</.exec(bodyOf(sent()[1]!).html)?.[1];
    expect((await post('/auth/verify', { email: 'r@empresa.test', code })).status).toBe(200);
  });

  it('recuperar contraseña: el correo lleva el enlace con FRONTEND_BASE_URL y el token en el fragmento', async () => {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ('0e2e0000-0000-4000-8000-0000000000a1','client','E','UTC')`);
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ('0e2e0000-0000-4000-8000-0000000000b1','u@empresa.test',$1,'active',now())`, [await new Argon2idHasher().hash(PW)]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),'0e2e0000-0000-4000-8000-0000000000b1','0e2e0000-0000-4000-8000-0000000000a1','client_admin')`);
    expect((await post('/auth/forgot', { email: 'u@empresa.test', captcha_token: 'token-valido' })).status).toBe(202);
    expect(sent()).toHaveLength(1);
    const { html, text, to } = bodyOf(sent()[0]!);
    expect(to).toEqual(['u@empresa.test']);
    const link = /https:\/\/app\.growthconsulting\.digital\/reset-password#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.exec(text)?.[0];
    expect(link).toBeTruthy();
    expect(html).toContain(link!);
  });

  it('una cuenta inexistente en «olvidé mi contraseña» responde igual y NO envía correo', async () => {
    expect((await post('/auth/forgot', { email: 'nadie@empresa.test', captcha_token: 'token-valido' })).status).toBe(202);
    expect(sent()).toHaveLength(0);
  });
});
