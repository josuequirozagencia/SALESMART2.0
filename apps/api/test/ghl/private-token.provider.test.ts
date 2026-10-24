// M7.1 — Adaptador de GoHighLevel con Private Token, probado contra un servidor SIMULADO (no hay red real): cabeceras, dirección, errores y que el token no se filtre.
// El contract test común (fake y adaptador) está en ghl.contract.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGhlProvider, GHL_API_VERSION, GhlError, PrivateTokenProvider } from '../../src/modules/ghl';
import { CREDS, ghlProviderContract } from './ghl.contract';

const TOKEN = 'pit-11111111-2222-3333-4444-555555555555';
const creds = { ...CREDS, accessToken: TOKEN };
interface Seen { method: string; url: string; auth: string | undefined; version: string | undefined }

let server: Server;
let origin = '';
const seen: Seen[] = [];
/** Cómo contesta el servidor simulado en la próxima petición. */
let reply: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], version: req.headers['version'] as string | undefined });
    reply(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  reply = (_q, res) => json(res, 200, { contacts: [], meta: { total: 0 } });
});

const provider = (timeoutMs?: number) => new PrivateTokenProvider({ baseUrl: origin, ...(timeoutMs ? { timeoutMs } : {}) });
const fail = async (p: Promise<unknown>): Promise<GhlError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GhlError);
  return e as GhlError;
};

describe('contract test del puerto GhlProvider', () => {
  it('lo cumple el fake', async () => {
    await ghlProviderContract(() => {
      const fake = new FakeGhlProvider();
      return { provider: fake, failNext: (e) => fake.failNextVerify(e) };
    });
  });

  it('lo cumple el adaptador real contra el servidor simulado', async () => {
    let next: GhlError | null = null;
    await ghlProviderContract(() => {
      reply = (_q, res) => {
        const e = next;
        next = null;
        if (!e) return json(res, 200, { contacts: [] });
        if (e.credentials) return json(res, 401, { message: e.message });
        return json(res, 429, { message: e.message });
      };
      return { provider: provider(), failNext: (e) => { next = e; } };
    });
  });
});

describe('PrivateTokenProvider · verify', () => {
  it('pide un contacto de la Location con el token en la cabecera (nunca en la dirección) y la versión de la API', async () => {
    await expect(provider().verify(creds)).resolves.toEqual({ name: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: `/contacts/?locationId=${creds.locationId}&limit=1`, auth: `Bearer ${TOKEN}`, version: GHL_API_VERSION });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('una Location con forma inválida no sale a la red (no se arma una dirección con texto ajeno)', async () => {
    for (const locationId of ['../../me', 'abc/def', 'corta', 'con espacio12345', 'x'.repeat(65), 'a?b=1&c=22222']) {
      const e = await fail(provider().verify({ ...creds, locationId }));
      expect(e).toMatchObject({ retryable: false, credentials: true });
    }
    expect(seen).toHaveLength(0);
  });

  it('401, 403 y 404 son fallos de credenciales y definitivos', async () => {
    for (const status of [401, 403, 404]) {
      reply = (_q, res) => json(res, status, { message: 'Invalid token' });
      const e = await fail(provider().verify(creds));
      expect(e, String(status)).toMatchObject({ retryable: false, credentials: true });
    }
  });

  it('429 y 5xx se reintentan y no culpan a las credenciales', async () => {
    for (const status of [429, 500, 502, 503]) {
      reply = (_q, res) => json(res, status, { message: 'Too many requests' });
      const e = await fail(provider().verify(creds));
      expect(e, String(status)).toMatchObject({ retryable: true, credentials: false });
    }
  });

  it('otro rechazo (422) es definitivo y no culpa a las credenciales', async () => {
    reply = (_q, res) => json(res, 422, { message: ['locationId must be a string'] });
    const e = await fail(provider().verify(creds));
    expect(e).toMatchObject({ retryable: false, credentials: false });
    expect(e.message).toContain('locationId must be a string');
  });

  it('el mensaje de error es seguro: sin el token aunque GHL lo repita, una sola línea y acotado', async () => {
    reply = (_q, res) => json(res, 401, { message: `Token ${TOKEN} is invalid\nsecond line ${'x'.repeat(500)}` });
    const e = await fail(provider().verify(creds));
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).toContain('[token]');
    expect(e.message).not.toContain('\n');
    expect(e.message.length).toBeLessThan(320);
  });

  it('una respuesta que no es JSON no rompe el manejo del error', async () => {
    reply = (_q, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    };
    const e = await fail(provider().verify(creds));
    expect(e).toMatchObject({ retryable: true });
  });

  it('red caída, tiempo agotado y redirecciones son pasajeros, sin filtrar la dirección', async () => {
    const down = await fail(new PrivateTokenProvider({ baseUrl: 'http://127.0.0.1:1' }).verify(creds));
    expect(down).toMatchObject({ retryable: true, credentials: false });
    expect(down.message).not.toContain('127.0.0.1');
    reply = () => undefined; // nunca contesta
    const slow = await fail(provider(150).verify(creds));
    expect(slow).toMatchObject({ retryable: true });
    reply = (_q, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/robado' });
      res.end();
    };
    const redirected = await fail(provider().verify(creds));
    expect(redirected).toMatchObject({ retryable: true });
    expect(seen.filter((s) => s.url.includes('robado'))).toHaveLength(0);
  });
});
