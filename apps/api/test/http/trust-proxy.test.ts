// La IP del cliente detrás de un proxy (Railway): solo se confía en X-Forwarded-For con saltos configurados explícitamente.
import 'reflect-metadata';
import { Controller, Get, Module, Req, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { configureApp, HttpModule, Public } from '../../src/http';
import { TEST_AUTH_KEY } from '../support/constants';

@Controller()
class IpProbe {
  @Public()
  @Get('ip')
  ip(@Req() req: Request) { return { ip: req.ip }; }
}
@Module({ imports: [CoreModule, HttpModule.forRoot()], controllers: [IpProbe] })
class TestAppModule {}

const saved = { ...process.env };
afterAll(() => { process.env = saved; });

async function boot(hops: string | undefined): Promise<{ app: INestApplication; base: string }> {
  Object.assign(process.env, {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_THROTTLE_KEY: TEST_AUTH_KEY,
    DATABASE_URL_APP: 'postgresql://app_rw:x@127.0.0.1:1/x', DATABASE_URL_PLATFORM: 'postgresql://app_platform:x@127.0.0.1:1/x', DATABASE_URL_IDENTITY: 'postgresql://app_identity:x@127.0.0.1:1/x',
  });
  delete process.env['DATABASE_URL_OWNER'];
  delete process.env['WEB_DIST_DIR'];
  if (hops === undefined) delete process.env['TRUST_PROXY_HOPS']; else process.env['TRUST_PROXY_HOPS'] = hops;
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}
const ipOf = async (base: string, xff?: string) => ((await (await fetch(`${base}/v1/ip`, { headers: xff ? { 'x-forwarded-for': xff } : {} })).json()) as { ip: string }).ip;

describe('trust proxy', () => {
  it('por defecto (0 saltos) IGNORA X-Forwarded-For: un cliente no puede fingir su IP', async () => {
    const { app, base } = await boot(undefined);
    try {
      expect(await ipOf(base, '1.2.3.4')).toMatch(/127\.0\.0\.1/);
      expect(await ipOf(base, '1.2.3.4, 5.6.7.8')).toMatch(/127\.0\.0\.1/);
    } finally { await app.close(); }
  });

  it('con 1 salto toma la IP que añadió el proxy (la última); lo que el cliente escriba antes NO cuenta', async () => {
    const { app, base } = await boot('1');
    try {
      expect(await ipOf(base, '203.0.113.9')).toBe('203.0.113.9');
      expect(await ipOf(base, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9'); // intento de suplantación al inicio de la cadena
      expect(await ipOf(base)).toMatch(/127\.0\.0\.1/); // sin cabecera: la de la conexión
    } finally { await app.close(); }
  });

  it('con 2 saltos (proxy → proxy → app) toma la penúltima entrada', async () => {
    const { app, base } = await boot('2');
    try {
      expect(await ipOf(base, '198.51.100.7, 203.0.113.9')).toBe('198.51.100.7');
      expect(await ipOf(base, '6.6.6.6, 198.51.100.7, 203.0.113.9')).toBe('198.51.100.7');
    } finally { await app.close(); }
  });
});
