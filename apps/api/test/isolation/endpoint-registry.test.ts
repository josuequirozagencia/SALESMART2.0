import { TEST_AUTH_KEY } from '../support/constants';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { PERMISSIONS } from '../../src/rbac';
import { discoverRoutes } from '../support/discover-routes';
import { ENDPOINTS } from '../support/endpoint-registry';
import { FixtureAppModule } from '../support/fixture-app';
import { requireDb } from '../support/harness';

let app: INestApplication;
let fixtureApp: INestApplication;
const saved = { ...process.env };
beforeAll(async () => {
  const info = requireDb();
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.init();
  fixtureApp = await NestFactory.create(FixtureAppModule, { logger: false, abortOnError: false });
  await fixtureApp.init();
});
afterAll(async () => {
  await app.close();
  await fixtureApp.close();
  process.env = saved;
});

describe('registro de endpoints y aislamiento A↔B', () => {
  it('toda ruta REAL de la aplicación está registrada con la clasificación correcta (y no hay huérfanas)', () => {
    const real = discoverRoutes(app).map((r) => `${r.route} [${r.access}]`);
    const registered = ENDPOINTS.map((e) => `${e.route} [${e.kind}]`).sort();
    expect(real).toEqual(registered);
  });

  it('RBAC: toda ruta autenticada de negocio o de plataforma declara @RequirePermission con claves del catálogo (las "self" y públicas no)', () => {
    for (const r of discoverRoutes(app)) {
      if (r.access === 'tenant' || r.access === 'platform') {
        expect(r.permissions.length, `${r.route} no declara @RequirePermission`).toBeGreaterThan(0);
        for (const k of r.permissions) expect(Object.hasOwn(PERMISSIONS, k), `${r.route}: permiso desconocido ${k}`).toBe(true);
      }
      if (r.access === 'public') expect(r.permissions, `${r.route}: una ruta pública no puede exigir permisos`).toEqual([]);
    }
  });

  it('control negativo: el descubrimiento ve las rutas sin permiso de la aplicación de fixtures', () => {
    const sinPermiso = discoverRoutes(fixtureApp).filter((r) => (r.access === 'tenant' || r.access === 'platform') && r.permissions.length === 0);
    expect(sinPermiso.length).toBeGreaterThan(3);
  });

  it('toda ruta sin decorador es de tenant (denegar por defecto): ninguna ruta pública sin @Public()', () => {
    const routes = discoverRoutes(fixtureApp);
    expect(routes.find((r) => r.route === 'GET /v1/probe/implicit-tenant')?.access).toBe('tenant');
    expect(routes.find((r) => r.route === 'GET /v1/probe/public')?.access).toBe('public');
    expect(routes.find((r) => r.route === 'GET /v1/probe/platform')?.access).toBe('platform');
  });

  it('todo endpoint de negocio ("tenant") tiene su suite A↔B y la suite menciona la ruta', () => {
    for (const e of ENDPOINTS) {
      if (e.kind === 'public') continue;
      const rel = e.kind === 'tenant' ? e.isolationTest : e.test;
      const file = path.resolve(__dirname, 'endpoints', rel);
      expect(existsSync(file), `${e.route}: falta test/isolation/endpoints/${rel}`).toBe(true);
      expect(readFileSync(file, 'utf8'), e.route).toContain(e.route);
    }
  });

  it('control negativo: el descubrimiento detecta rutas de tenant que el registro no conoce', () => {
    const fixtureRoutes = discoverRoutes(fixtureApp).map((r) => r.route);
    const registered = new Set(ENDPOINTS.map((e) => e.route));
    expect(fixtureRoutes.filter((r) => !registered.has(r)).length).toBeGreaterThan(5);
  });
});
