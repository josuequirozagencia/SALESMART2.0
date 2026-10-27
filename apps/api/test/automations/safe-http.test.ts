import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type https from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOUND_MAX_RESPONSE_BYTES, OutboundError, SafeHttpClient, type OutboundRequest } from '../../src/modules/automations/outbound-http';

/** Un servidor local SIN TLS: el transporte de prueba cambia el puerto y el protocolo, y el cliente lo usa como si fuera https. */
let server: http.Server;
let port = 0;
const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let behaviour: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.writeHead(200).end('ok');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      behaviour(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const localTransport = { request: ((opts: https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.request({ ...opts, port, protocol: 'http:' }, cb)) as unknown as typeof https.request };
const req = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({ url: new URL('https://hooks.ejemplo.com/hook/abc?x=1'), method: 'POST', body: '{"nombre":"Ana"}', idempotencyKey: 'run-1:2', ...over });
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

describe('salida segura: se rechaza ANTES de conectar lo que no es público', () => {
  const blockedFor = (addrs: Array<{ address: string; family: number }>) => new SafeHttpClient({ resolve: async () => addrs, transport: localTransport }).send(req());

  it('una dirección privada, de loopback, de metadatos o IPv6 local → «blocked», sin tocar el servidor', async () => {
    seen.length = 0;
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      await expect(blockedFor([{ address, family: address.includes(':') ? 6 : 4 }]), address).rejects.toMatchObject({ reason: 'blocked' });
    }
    expect(seen).toHaveLength(0);
  });

  it('una respuesta DNS mixta (una pública y una privada) también se rechaza', async () => {
    await expect(blockedFor([...PUBLIC, { address: '10.0.0.1', family: 4 }])).rejects.toMatchObject({ reason: 'blocked' });
  });

  it('un nombre que no se resuelve o resuelve a nada → «dns»', async () => {
    await expect(new SafeHttpClient({ resolve: async () => { throw new Error('ENOTFOUND'); } }).send(req())).rejects.toMatchObject({ reason: 'dns' });
    await expect(blockedFor([])).rejects.toMatchObject({ reason: 'dns' });
  });

  it('el mensaje de error no incluye la dirección ni el cuerpo', async () => {
    const e = (await blockedFor([{ address: '10.0.0.1', family: 4 }]).catch((x: unknown) => x)) as OutboundError;
    expect(String(e.message)).not.toMatch(/ejemplo\.com|abc|Ana|10\.0\.0\.1/);
  });

  it('con el resolvedor real, «localhost» y las IP literales no salen', async () => {
    const real = new SafeHttpClient();
    for (const url of ['https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x']) await expect(real.send(req({ url: new URL(url) })), url).rejects.toMatchObject({ reason: expect.stringMatching(/blocked|dns/) });
  });
});

describe('salida segura: la conexión va a la IP YA validada', () => {
  it('conecta a la dirección fijada aunque el nombre apunte a otra, y manda las cabeceras y el cuerpo esperados', async () => {
    seen.length = 0;
    const client = new SafeHttpClient({ resolve: async () => PUBLIC, transport: localTransport });
    const res = await client.pinned(req(), { address: '127.0.0.1', family: 4 }); // el nombre es hooks.ejemplo.com, pero se conecta a la IP fijada
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/hook/abc?x=1', body: '{"nombre":"Ana"}' });
    expect(seen[0]!.headers).toMatchObject({ host: 'hooks.ejemplo.com', 'idempotency-key': 'run-1:2', 'content-type': 'application/json', 'user-agent': 'SalesSmart-Automations/1' });
    expect(seen[0]!.headers['cookie']).toBeUndefined();
    expect(seen[0]!.headers['authorization']).toBeUndefined();
  });

  it('GET no lleva cuerpo ni tipo de contenido', async () => {
    seen.length = 0;
    await new SafeHttpClient({ transport: localTransport }).pinned(req({ method: 'GET', body: null }), { address: '127.0.0.1', family: 4 });
    expect(seen[0]).toMatchObject({ method: 'GET', body: '' });
    expect(seen[0]!.headers['content-type']).toBeUndefined();
  });

  it('NO sigue redirecciones: devuelve el 3xx y nunca pide la otra dirección', async () => {
    seen.length = 0;
    behaviour = (_r, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    const res = await new SafeHttpClient({ transport: localTransport }).pinned(req(), { address: '127.0.0.1', family: 4 });
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
    behaviour = (_r, res2) => res2.writeHead(200).end('ok');
  });

  it('devuelve el código de error del servidor y descarta una respuesta enorme sin leerla toda', async () => {
    behaviour = (_r, res) => res.writeHead(500).end('x'.repeat(OUTBOUND_MAX_RESPONSE_BYTES * 3));
    expect((await new SafeHttpClient({ transport: localTransport }).pinned(req(), { address: '127.0.0.1', family: 4 })).status).toBe(500);
    behaviour = (_r, res) => res.writeHead(200).end('ok');
  });

  it('un servidor que no contesta a tiempo → «timeout»', async () => {
    behaviour = () => undefined; // nunca responde
    const t0 = Date.now();
    await expect(new SafeHttpClient({ transport: localTransport, timeoutMs: 150 }).pinned(req(), { address: '127.0.0.1', family: 4 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
    behaviour = (_r, res) => res.writeHead(200).end('ok');
  });

  it('un servidor al que no se puede conectar → «connect», sin la dirección en el mensaje', async () => {
    const closed = { request: ((opts: https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.request({ ...opts, port: 1, protocol: 'http:' }, cb)) as unknown as typeof https.request };
    const e = (await new SafeHttpClient({ transport: closed }).pinned(req(), { address: '127.0.0.1', family: 4 }).catch((x: unknown) => x)) as OutboundError;
    expect(e).toBeInstanceOf(OutboundError);
    expect(e.reason).toBe('connect');
    expect(e.message).not.toMatch(/127\.0\.0\.1|ejemplo/);
  });
});
