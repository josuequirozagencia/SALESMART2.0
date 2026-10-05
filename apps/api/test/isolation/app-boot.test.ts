// Arranque real de Nest (decoradores + metadata bajo vitest/swc) con el rol de aplicación y endpoints de salud.
import { TEST_AUTH_KEY } from '../support/constants';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/http';
import { requireDb } from '../support/harness';

let app: INestApplication;
let base: string;
const saved = { ...process.env };

beforeAll(async () => {
  const info = requireDb();
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['DATABASE_URL_APP'] = info.rwUrl;
  process.env['DATABASE_URL_PLATFORM'] = info.platformUrl;
  process.env['DATABASE_URL_IDENTITY'] = info.identityUrl;
  process.env['AUTH_THROTTLE_KEY'] = TEST_AUTH_KEY;
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
  process.env = saved;
});

describe('API Nest', () => {
  it('GET /health → 200 (liveness, sin base de datos)', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });
  it('GET /health/ready → 200 con la base de datos disponible (inyección de Database funcionando)', async () => {
    const r = await fetch(`${base}/health/ready`);
    expect(r.status).toBe(200);
  });
});

describe('versionado /v1', () => {
  it('una ruta inexistente FUERA de /v1 también devuelve el 404 JSON estándar con request_id (no el HTML de Express)', async () => {
    for (const p of ['/lo-que-sea', '/v1/lo-que-sea', '/auth']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/json/);
      const b = (await r.json()) as { error: { code: string; request_id: string } };
      expect(b.error.code).toBe('NOT_FOUND');
      expect(b.error.request_id).not.toBe('unknown');
    }
  });
  it('los sondeos de salud NO llevan versión; /v1/health no existe', async () => {
    expect((await fetch(`${base}/v1/health`)).status).toBe(404);
  });
  it('todas las respuestas llevan x-request-id (incluidos /health y rutas fuera de /v1)', async () => {
    for (const p of ['/health', '/health/ready', '/v1/lo-que-sea', '/lo-que-sea']) expect((await fetch(`${base}${p}`)).headers.get('x-request-id'), p).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('los endpoints de acceso viven bajo /v1/auth y NO existen sin prefijo', async () => {
    const post = (p: string) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (const ep of ['login', 'refresh', 'logout']) {
      expect((await post(`/auth/${ep}`)).status, `/auth/${ep} sin prefijo`).toBe(404);
      expect((await post(`/v1/auth/${ep}`)).status, `/v1/auth/${ep}`).not.toBe(404);
    }
  });
});

describe('arranque con configuración inválida', () => {
  it('rechaza arrancar si el entorno trae la URL del dueño', async () => {
    process.env['DATABASE_URL_OWNER'] = 'postgresql://app_owner:x@h/db';
    await expect(NestFactory.create(AppModule, { logger: false, abortOnError: false })).rejects.toThrow(/DATABASE_URL_OWNER/);
    delete process.env['DATABASE_URL_OWNER'];
  });
});
