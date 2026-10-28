import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvolutionProvider } from '../../src/modules/qr/evolution.provider';
import { FAKE_QR_KEY, FakeQrSession } from '../../src/modules/qr/qr-session.fake';
import { isRetryableQr, QrSessionError, type QrCredentials, type QrSessionProvider } from '../../src/modules/qr/qr-session.port';

/**
 * Contract test común del puerto de sesión por QR (M9.6): lo cumplen el fake y el adaptador de Evolution (este contra un servidor HTTP simulado con las rutas y las formas del spike del 2026-10-27).
 * Cada implementación se prepara con `harness`; lo que ocurre «en WhatsApp» (la sesión se abre, se cae) lo decide la prueba con `openSession` y `dropSession`.
 */
interface Harness {
  readonly provider: QrSessionProvider;
  readonly creds: QrCredentials;
  readonly badCreds: QrCredentials;
  openSession(instance: string): void;
  dropSession(instance: string): void;
}

// ---- servidor de Evolution simulado --------------------------------------------------------------------------------------------------------
const KEY = 'evo-global-key-for-tests';
const states = new Map<string, 'open' | 'connecting' | 'close'>();
let seq = 0;
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['apikey'] !== KEY) return send(401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
      const url = new URL(req.url ?? '/', 'http://x');
      const [, a, b, name] = url.pathname.split('/');
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      if (a === 'instance' && b === 'create') {
        states.set(String(body['instanceName']), 'connecting');
        return send(201, { instance: { instanceName: body['instanceName'], status: 'created' } });
      }
      const inst = name ? decodeURIComponent(name) : '';
      const known = states.has(inst);
      if (!known) return send(404, { status: 404, error: 'Not Found', response: { message: [`The "${inst}" instance does not exist`] } });
      if (a === 'instance' && b === 'connect') return send(200, states.get(inst) === 'open' ? { instance: { instanceName: inst, state: 'open' } } : { pairingCode: null, code: '2@x', base64: 'data:image/png;base64,QRQR', count: 1 });
      if (a === 'instance' && b === 'connectionState') return send(200, { instance: { instanceName: inst, state: states.get(inst) } });
      if (a === 'instance' && b === 'logout') return states.set(inst, 'close'), send(200, { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } });
      if (a === 'instance' && b === 'delete') return states.delete(inst), send(200, { status: 'SUCCESS' });
      if (a === 'message') {
        if (states.get(inst) !== 'open') return send(400, { status: 400, error: 'Bad Request', response: { message: ['Connection Closed'] } });
        seq += 1;
        return send(201, { key: { remoteJid: `${String(body['number'])}@s.whatsapp.net`, fromMe: true, id: `3EB0SIM${String(seq).padStart(12, '0')}` }, status: 'PENDING', messageType: 'conversation' });
      }
      return send(404, { status: 404, error: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const harnesses: Array<[string, () => Harness]> = [
  [
    'fake',
    () => {
      const provider = new FakeQrSession();
      return { provider, creds: { baseUrl: 'http://fake', apiKey: FAKE_QR_KEY }, badCreds: { baseUrl: 'http://fake', apiKey: 'otra' }, openSession: (i) => provider.setState(i, 'open'), dropSession: (i) => provider.setState(i, 'closed') };
    },
  ],
  [
    'evolution (servidor simulado)',
    () => ({ provider: new EvolutionProvider(), creds: { baseUrl: base, apiKey: KEY }, badCreds: { baseUrl: base, apiKey: 'otra' }, openSession: (i) => void states.set(i, 'open'), dropSession: (i) => void states.set(i, 'close') }),
  ],
];

describe.each(harnesses)('puerto de sesión por QR: %s', (_name, make) => {
  const hook = 'https://app.ejemplo.com/v1/integrations/qr/webhook/RUTA?token=SECRETO-DEL-WEBHOOK';
  let n = 0;
  const fresh = async (h: Harness): Promise<string> => {
    n += 1;
    const instance = `ss-contract-${_name.length}-${n}-${Date.now()}`;
    await h.provider.createInstance(h.creds, { instance, webhookUrl: hook });
    return instance;
  };

  it('crear la instancia deja la sesión «connecting» y pide un QR con imagen; con la sesión abierta no hay QR', async () => {
    const h = make();
    const i = await fresh(h);
    expect(await h.provider.state(h.creds, i)).toBe('connecting');
    const qr = await h.provider.requestQr(h.creds, i);
    expect(qr.state).toBe('connecting');
    expect(qr.base64).toMatch(/^data:image\/png;base64,.+/);
    h.openSession(i);
    expect(await h.provider.state(h.creds, i)).toBe('open');
    expect(await h.provider.requestQr(h.creds, i)).toMatchObject({ base64: null, state: 'open' });
  });

  it('con la sesión abierta se envía texto y un archivo, y cada mensaje recibe su propio identificador', async () => {
    const h = make();
    const i = await fresh(h);
    h.openSession(i);
    const a = await h.provider.sendText(h.creds, i, { to: '593990000002', text: 'Hola' });
    const b = await h.provider.sendText(h.creds, i, { to: '593990000002', text: 'Otra vez' });
    expect(a.externalId).toBeTruthy();
    expect(b.externalId).not.toBe(a.externalId);
    const img = await h.provider.sendMedia(h.creds, i, { to: '593990000002', kind: 'image', bytes: Buffer.from('png'), mimeType: 'image/png', filename: null, caption: 'mira' });
    const doc = await h.provider.sendMedia(h.creds, i, { to: '593990000002', kind: 'document', bytes: Buffer.from('pdf'), mimeType: 'application/pdf', filename: 'a.pdf', caption: null });
    const aud = await h.provider.sendMedia(h.creds, i, { to: '593990000002', kind: 'audio', bytes: Buffer.from('ogg'), mimeType: 'audio/ogg', filename: null, caption: null });
    expect(new Set([a.externalId, b.externalId, img.externalId, doc.externalId, aud.externalId]).size).toBe(5);
  });

  it('un sticker no se puede enviar por QR', async () => {
    const h = make();
    const i = await fresh(h);
    h.openSession(i);
    await expect(h.provider.sendMedia(h.creds, i, { to: '593990000002', kind: 'sticker', bytes: Buffer.from('x'), mimeType: 'image/webp', filename: null, caption: null })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('con la sesión caída el envío falla «session_down» y ESO se puede reintentar (el mensaje espera)', async () => {
    const h = make();
    const i = await fresh(h);
    h.openSession(i);
    h.dropSession(i);
    const e = await h.provider.sendText(h.creds, i, { to: '593990000002', text: 'secreto del cliente' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(QrSessionError);
    expect((e as QrSessionError).code).toBe('session_down');
    expect(isRetryableQr((e as QrSessionError).code)).toBe(true);
    expect(await h.provider.state(h.creds, i)).not.toBe('open');
  });

  it('cerrar la sesión la deja fuera de «open»', async () => {
    const h = make();
    const i = await fresh(h);
    h.openSession(i);
    await h.provider.logout(h.creds, i);
    expect(await h.provider.state(h.creds, i)).not.toBe('open');
  });

  it('una clave equivocada → not_configured; una instancia que no existe → not_found; borrar una que no existe NO falla', async () => {
    const h = make();
    const i = await fresh(h);
    await expect(h.provider.state(h.badCreds, i)).rejects.toMatchObject({ code: 'not_configured' });
    await expect(h.provider.requestQr(h.creds, 'no-existe-0000')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.provider.sendText(h.creds, 'no-existe-0000', { to: '593990000002', text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.provider.deleteInstance(h.creds, 'no-existe-0000')).resolves.toBeUndefined();
    await h.provider.deleteInstance(h.creds, i);
    await expect(h.provider.state(h.creds, i)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('los errores nunca llevan la clave, el teléfono, el texto ni la dirección del webhook', async () => {
    const h = make();
    const i = await fresh(h);
    const errors = await Promise.all([
      h.provider.state(h.badCreds, i).catch((x: unknown) => x),
      h.provider.sendText(h.creds, i, { to: '593990000002', text: 'texto-privado' }).catch((x: unknown) => x), // sesión sin abrir
      h.provider.requestQr(h.creds, 'no-existe-0000').catch((x: unknown) => x),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(QrSessionError);
      expect((e as Error).message).not.toMatch(/593990000002|texto-privado|evo-global-key|fake-qr-key|SECRETO-DEL-WEBHOOK|otra/);
    }
  });
});

describe('adaptador de Evolution: lo que el servidor simulado no puede probar', () => {
  it('un servidor que no responde → unavailable (y se puede reintentar), sin la dirección en el mensaje', async () => {
    const e = (await new EvolutionProvider().state({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, 'x').catch((x: unknown) => x)) as QrSessionError;
    expect(e.code).toBe('unavailable');
    expect(isRetryableQr(e.code)).toBe(true);
    expect(e.message).not.toMatch(/127\.0\.0\.1/);
  });
});
