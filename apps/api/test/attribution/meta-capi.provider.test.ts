// M6.4 — Adaptador real de la API de Conversiones de Meta, probado contra un servidor SIMULADO (no hay red real): cabeceras, cuerpo, errores y que el token no se filtre.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CapiSendError, GRAPH_VERSION, MetaCapiProvider } from '../../src/modules/attribution';
import { CREDS, sampleEvent } from './capi.contract';

const TOKEN = 'EAAGm0PX4ZCpsBAZDZDsupersecreto0123456789';
const creds = { ...CREDS, accessToken: TOKEN };
interface Seen { method: string; url: string; auth: string | undefined; body: unknown }

let server: Server;
let origin = '';
const seen: Seen[] = [];
/** Cómo contesta el servidor simulado en la próxima petición. */
let reply: (req: IncomingMessage, res: ServerResponse, body: unknown) => void = () => undefined;
const ok = (res: ServerResponse, status: number, json: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as unknown) : null;
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], body });
      reply(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  reply = (_q, res) => ok(res, 200, { events_received: 1, fbtrace_id: 'x' });
});

const provider = (timeoutMs?: number) => new MetaCapiProvider({ baseUrl: origin, ...(timeoutMs ? { timeoutMs } : {}) });
const fail = async (p: Promise<unknown>): Promise<CapiSendError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(CapiSendError);
  return e as CapiSendError;
};

describe('MetaCapiProvider · enviar', () => {
  it('manda el evento a POST /{dataset}/events con el token en la cabecera (nunca en la URL) y el cuerpo tal cual', async () => {
    const event = sampleEvent({ payload: { event_name: 'Purchase', event_id: 'purchase:1', user_data: { ctwa_clid: 'abc' }, custom_data: { value: 100, currency: 'USD' } } });
    await expect(provider().send(event, creds)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: `/${GRAPH_VERSION}/${creds.datasetId}/events`, auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.url).not.toContain(TOKEN);
    expect(seen[0]!.body).toEqual({ data: [event.payload] });
  });

  it('con código de «Eventos de prueba» lo agrega al cuerpo; sin él, no', async () => {
    await provider().send(sampleEvent(), { ...creds, testEventCode: 'TEST12345' });
    expect(seen[0]!.body).toMatchObject({ test_event_code: 'TEST12345' });
    await provider().send(sampleEvent(), { ...creds, testEventCode: null });
    expect(seen[1]!.body).not.toHaveProperty('test_event_code');
  });

  it('un dataset con forma inválida no sale a la red (no se arma una dirección con texto ajeno)', async () => {
    for (const datasetId of ['../../me', '123/456', 'abc', '12', '1 2 3 4 5']) {
      const e = await fail(provider().send(sampleEvent(), { ...creds, datasetId }));
      expect(e).toMatchObject({ retryable: false, credentials: true });
    }
    expect(seen).toEqual([]);
  });

  it('el token rechazado (190), sin permiso o un dataset inexistente son fallos DEFINITIVOS de credenciales, sin filtrar el token aunque Meta lo repita', async () => {
    for (const [status, error] of [[401, { code: 190, message: `Invalid OAuth access token ${TOKEN}.` }], [400, { code: 190, message: 'Error validating access token' }], [403, { code: 200, message: 'Permissions error' }], [400, { code: 100, error_subcode: 33, message: 'Unsupported post request' }]] as const) {
      reply = (_q, res) => ok(res, status, { error });
      const e = await fail(provider().send(sampleEvent(), creds));
      expect(e, JSON.stringify(error)).toMatchObject({ retryable: false, credentials: true });
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).toContain('Meta rechazó las credenciales');
    }
  });

  it('datos que Meta rechaza (400) son definitivos pero NO son de credenciales; límites, 5xx y red caída se reintentan', async () => {
    reply = (_q, res) => ok(res, 400, { error: { code: 100, message: 'Invalid parameter' } });
    expect(await fail(provider().send(sampleEvent(), creds))).toMatchObject({ retryable: false, credentials: false });
    for (const [status, error] of [[429, { code: 4 }], [400, { code: 17, message: 'User request limit reached' }], [500, {}], [503, { code: 2 }], [502, {}]] as const) {
      reply = (_q, res) => ok(res, status, { error });
      expect(await fail(provider().send(sampleEvent(), creds)), `${status}`).toMatchObject({ retryable: true, credentials: false });
    }
    const down = new MetaCapiProvider({ baseUrl: 'http://127.0.0.1:1' });
    expect(await fail(down.send(sampleEvent(), creds))).toMatchObject({ retryable: true });
  });

  it('una respuesta «events_received: 0» es un fallo definitivo; una ilegible se reintenta', async () => {
    reply = (_q, res) => ok(res, 200, { events_received: 0 });
    expect(await fail(provider().send(sampleEvent(), creds))).toMatchObject({ retryable: false });
    reply = (_q, res) => { res.writeHead(200); res.end('<html>'); };
    expect(await fail(provider().send(sampleEvent(), creds))).toMatchObject({ retryable: true });
  });

  it('no sigue redirecciones (el token no viaja a otro lugar) y corta cuando Meta no responde a tiempo', async () => {
    reply = (_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/robado' }); res.end(); };
    expect(await fail(provider().send(sampleEvent(), creds))).toMatchObject({ retryable: true });
    expect(seen).toHaveLength(1);
    reply = () => undefined; // nunca contesta
    expect(await fail(provider(150).send(sampleEvent(), creds))).toMatchObject({ retryable: true, message: 'No se pudo contactar a Meta' });
  });
});

describe('MetaCapiProvider · verificar', () => {
  it('consulta GET /{dataset}?fields=id,name con el token en la cabecera y devuelve el nombre', async () => {
    reply = (_q, res) => ok(res, 200, { id: creds.datasetId, name: 'Pixel de la barbería' });
    await expect(provider().verify(creds)).resolves.toEqual({ name: 'Pixel de la barbería' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: `/${GRAPH_VERSION}/${creds.datasetId}?fields=id,name`, auth: `Bearer ${TOKEN}` });
  });

  it('Meta responde por otro dataset o rechaza el token: error de credenciales; si no informa el nombre, null', async () => {
    reply = (_q, res) => ok(res, 200, { id: '999999999999' });
    expect(await fail(provider().verify(creds))).toMatchObject({ credentials: true, retryable: false });
    reply = (_q, res) => ok(res, 400, { error: { code: 190, message: 'Invalid OAuth access token' } });
    expect(await fail(provider().verify(creds))).toMatchObject({ credentials: true });
    reply = (_q, res) => ok(res, 200, { id: creds.datasetId });
    await expect(provider().verify(creds)).resolves.toEqual({ name: null });
  });
});

describe('MetaCapiProvider · nombres de anuncios (lookupAds)', () => {
  const AD = '120250251830440318';
  it('pide a GET /?ids=…&fields=name,adset{id,name},campaign{id,name} con el token en la cabecera y devuelve los tres nombres; lo que Meta no trae queda null', async () => {
    reply = (_q, res) => ok(res, 200, { [AD]: { name: 'Prefiero sufrir así', adset: { id: '1202', name: 'SERVICIOS PASIEL RMKT' }, campaign: { id: '1201', name: 'SERVICIOS PASIEL - RMKT NOV 2026' } } });
    const out = await provider().lookupAds([AD, '999999'], creds);
    expect(out).toEqual({ [AD]: { adName: 'Prefiero sufrir así', adsetId: '1202', adsetName: 'SERVICIOS PASIEL RMKT', campaignId: '1201', campaignName: 'SERVICIOS PASIEL - RMKT NOV 2026' }, '999999': null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.url).toContain(`ids=${AD},999999`);
    expect(seen[0]!.url).toContain('fields=name,adset{id,name},campaign{id,name}');
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('ignora lo que no parece un id de anuncio (solo dígitos) y sin ids válidos ni siquiera llama a Meta', async () => {
    const out = await provider().lookupAds(['abc', '../x'], creds);
    expect(out).toEqual({ abc: null, '../x': null });
    expect(seen).toHaveLength(0);
  });

  it('un token sin permiso para leer anuncios es un error de credenciales (definitivo); un límite de uso, reintentable; el mensaje no lleva el token', async () => {
    reply = (_q, res) => ok(res, 403, { error: { message: `(#200) Requires ads_read ${TOKEN}`, code: 200 } });
    const denied = await fail(provider().lookupAds([AD], creds));
    expect(denied).toMatchObject({ credentials: true, retryable: false });
    expect(denied.message).not.toContain(TOKEN);
    reply = (_q, res) => ok(res, 429, { error: { message: 'límite', code: 4 } });
    expect(await fail(provider().lookupAds([AD], creds))).toMatchObject({ retryable: true });
  });
});

describe('MetaCapiProvider · el motivo real del rechazo (v20)', () => {
  it('«Invalid parameter» llega con el título, el mensaje para el usuario y el subcódigo que da Meta, sin pasar de 300 caracteres ni filtrar el token', async () => {
    reply = (_q, res) => ok(res, 400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2804132, error_user_title: 'No hay ninguna cuenta de WhatsApp Business vinculada con este conjunto de datos', error_user_msg: `Enviaste "whatsapp_business_account_id" en user_data, pero el conjunto de datos no tiene ninguna cuenta vinculada. ${TOKEN}` } });
    const e = await fail(provider().send(sampleEvent(), creds));
    expect(e).toMatchObject({ retryable: false, credentials: false });
    expect(e.message).toContain('Invalid parameter');
    expect(e.message).toContain('No hay ninguna cuenta de WhatsApp Business vinculada');
    expect(e.message).toContain('(2804132)');
    expect(e.message).not.toContain(TOKEN);
    expect(e.message.length).toBeLessThanOrEqual(300);
  });

  it('sin título ni mensaje del usuario el texto no cambia', async () => {
    reply = (_q, res) => ok(res, 400, { error: { code: 100, message: 'Invalid parameter' } });
    expect((await fail(provider().send(sampleEvent(), creds))).message).toBe('Meta rechazó el evento: Invalid parameter');
  });
});

describe('MetaCapiProvider · dataset de mensajes (ensureMessagingDataset)', () => {
  const WABA = '935383352872554';
  it('pide POST /{cuenta}/dataset con el token en la cabecera y devuelve el dataset', async () => {
    reply = (_q, res) => ok(res, 200, { id: '1030123066792188' });
    await expect(provider().ensureMessagingDataset(WABA, creds)).resolves.toEqual({ datasetId: '1030123066792188' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: `/${GRAPH_VERSION}/${WABA}/dataset`, auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('una cuenta con forma inválida no sale a la red; una respuesta sin id o con un id raro es un fallo definitivo; un permiso que falta, un fallo de credenciales', async () => {
    for (const waba of ['../../me', '12', 'abc', '1 2 3 4 5']) expect(await fail(provider().ensureMessagingDataset(waba, creds))).toMatchObject({ credentials: true, retryable: false });
    expect(seen).toEqual([]);
    reply = (_q, res) => ok(res, 200, {});
    expect(await fail(provider().ensureMessagingDataset(WABA, creds))).toMatchObject({ retryable: false });
    reply = (_q, res) => ok(res, 200, { id: '../x' });
    expect(await fail(provider().ensureMessagingDataset(WABA, creds))).toMatchObject({ retryable: false });
    reply = (_q, res) => ok(res, 403, { error: { code: 200, message: 'Requires whatsapp_business_manage_events permission' } });
    expect(await fail(provider().ensureMessagingDataset(WABA, creds))).toMatchObject({ credentials: true, retryable: false });
    reply = (_q, res) => { res.writeHead(200); res.end('<html>'); };
    expect(await fail(provider().ensureMessagingDataset(WABA, creds))).toMatchObject({ retryable: true });
  });
});
