// ADR-36 — la API sirve la web compilada bajo el MISMO origen (sin CORS). No necesita base de datos.
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { configureApp, Public, HttpModule } from '../../src/http';
import { buildCsp, CSP } from '../../src/http/web-static';
import { TEST_AUTH_KEY } from '../support/constants';

@Controller()
class HealthProbe {
  @Public()
  @Get('health')
  health() { return { status: 'ok' }; }
}
@Module({ imports: [CoreModule, HttpModule.forRoot()], controllers: [HealthProbe] })
class TestAppModule {}

let dist = '';
const saved = { ...process.env };

async function boot(env: Record<string, string>): Promise<{ app: INestApplication; base: string }> {
  Object.assign(process.env, {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_THROTTLE_KEY: TEST_AUTH_KEY,
    DATABASE_URL_APP: 'postgresql://app_rw:x@127.0.0.1:1/x', DATABASE_URL_PLATFORM: 'postgresql://app_platform:x@127.0.0.1:1/x', DATABASE_URL_IDENTITY: 'postgresql://app_identity:x@127.0.0.1:1/x',
    ...env,
  });
  delete process.env['DATABASE_URL_OWNER'];
  if (!('WEB_DIST_DIR' in env)) delete process.env['WEB_DIST_DIR']; // cada arranque parte sin web salvo que se pida
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}

beforeAll(() => {
  dist = mkdtempSync(path.join(os.tmpdir(), 'ss-web-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body><div id="root">APP</div></body></html>');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(path.join(dist, '.secreto'), 'no se sirve');
  writeFileSync(path.join(path.dirname(dist), 'ss-web-fuera.txt'), 'fuera de la carpeta');
});
afterAll(() => { rmSync(dist, { recursive: true, force: true }); rmSync(path.join(path.dirname(dist), 'ss-web-fuera.txt'), { force: true }); process.env = saved; });

describe('web servida por la API', () => {
  let app: INestApplication;
  let base = '';
  beforeAll(async () => { ({ app, base } = await boot({ WEB_DIST_DIR: dist })); });
  afterAll(async () => { await app.close(); });

  it('la raíz y las rutas de la SPA devuelven index.html sin caché y con las cabeceras de seguridad', async () => {
    for (const p of ['/', '/login', '/signup', '/reset-password', '/verify']) {
      const r = await fetch(`${base}${p}`, { headers: { accept: 'text/html' } });
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type'), p).toMatch(/text\/html/);
      expect(await r.text(), p).toContain('APP');
      expect(r.headers.get('cache-control'), p).toBe('no-store');
      expect(r.headers.get('content-security-policy'), p).toBe(CSP);
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), p).toBe('no-referrer');
      expect(r.headers.get('x-frame-options'), p).toBe('DENY');
      expect(r.headers.get('strict-transport-security'), p).toBeNull(); // solo en producción
    }
  });

  it('los archivos con hash llevan caché larga e inmutable y el tipo correcto; index.html directo no se cachea', async () => {
    const js = await fetch(`${base}/assets/index-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${base}/assets/index-abc123.css`)).headers.get('content-type')).toMatch(/text\/css/);
    expect((await fetch(`${base}/index.html`)).headers.get('cache-control')).toBe('no-cache');
  });

  it('un archivo inexistente, una ruta con extensión o un cliente que no acepta HTML reciben el 404 JSON estándar (no index.html)', async () => {
    for (const [p, accept] of [['/assets/no-existe.js', '*/*'], ['/favicon.ico', '*/*'], ['/login', 'application/json'], ['/algo.map', 'text/html']] as const) {
      const r = await fetch(`${base}${p}`, { headers: { accept } });
      expect(r.status, p).toBe(404);
      expect(await r.json(), p).toMatchObject({ error: { code: 'NOT_FOUND', request_id: expect.any(String) } });
    }
  });

  it('/v1 y /health NO los toca la web: una ruta /v1 inexistente es 404 JSON y /health sigue siendo la API', async () => {
    const miss = await fetch(`${base}/v1/lo-que-sea`, { headers: { accept: 'text/html' } });
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('solo GET/HEAD: un POST a una ruta de la web es 404 JSON; HEAD funciona', async () => {
    expect((await fetch(`${base}/login`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(404);
    const head = await fetch(`${base}/`, { method: 'HEAD', headers: { accept: 'text/html' } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('no sirve dotfiles ni sale de la carpeta (../, %2e%2e, rutas absolutas, barras invertidas)', async () => {
    const attempts = ['/.secreto', '/assets/../.secreto', '/%2e%2e/ss-web-fuera.txt', '/..%2fss-web-fuera.txt', '/assets/..%2f..%2fss-web-fuera.txt', '/%2e%2e%2f%2e%2e%2fwindows/win.ini', '/..\\ss-web-fuera.txt', '/etc/passwd%00.js'];
    for (const p of attempts) {
      const r = await fetch(`${base}${p}`, { headers: { accept: 'text/html' } });
      const body = await r.text();
      expect(body, p).not.toContain('no se sirve');
      expect(body, p).not.toContain('fuera de la carpeta');
      expect([200, 400, 403, 404], p).toContain(r.status); // 200 solo si cayó en index.html (ruta de la SPA), nunca con el contenido ajeno
    }
  });

  it('cada respuesta lleva request_id y la API no revela su tecnología', async () => {
    const r = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    expect(r.headers.get('x-request-id')).toBeTruthy();
    expect(r.headers.get('x-powered-by')).toBeNull();
  });
});

describe('web servida por la API — producción y errores de configuración', () => {
  it('en producción añade HSTS', async () => {
    const { app, base } = await boot({ NODE_ENV: 'production', WEB_DIST_DIR: dist });
    try {
      const r = await fetch(`${base}/login`, { headers: { accept: 'text/html' } });
      expect(r.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
      expect((await fetch(`${base}/assets/index-abc123.js`)).headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    } finally {
      await app.close();
    }
  });

  it('sin WEB_DIST_DIR no hay web: la raíz es el 404 JSON de siempre', async () => {
    const { app, base } = await boot({});
    try {
      const r = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await app.close();
    }
  });

  it('con WEB_DIST_DIR sin index.html la API NO arranca (falla clara, no sirve una web vacía)', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ss-web-vacia-'));
    try {
      await expect(boot({ WEB_DIST_DIR: empty })).rejects.toThrow(/index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('la CSP solo permite lo necesario: nada de unsafe-inline/eval en scripts, solo Turnstile como tercero de scripts e iframes', () => {
    expect(CSP).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(CSP).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("default-src 'self'");
  });

  it('buildCsp añade el origen del almacenamiento solo a img-src y media-src; descarta lo que no sea un origen limpio', () => {
    const csp = buildCsp(['https://files.example.com', 'https://x.com; script-src *', '*', 'javascript:alert(1)', 'https://files.example.com']);
    expect(csp).toContain("img-src 'self' data: https://files.example.com;");
    expect(csp).toContain("media-src 'self' https://files.example.com;");
    expect(csp).not.toContain('script-src *');
    expect(csp).not.toContain('javascript:');
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(csp).toContain("connect-src 'self';");
    expect(buildCsp([])).toBe(CSP);
  });
});
