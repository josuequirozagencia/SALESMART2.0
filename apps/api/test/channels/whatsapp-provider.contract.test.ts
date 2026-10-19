// Contract test del puerto WhatsAppProvider (ADR-50 #9): el fake y el adaptador de Meta (contra un servidor simulado de la Graph API) deben comportarse igual.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_UNAVAILABLE_ID, FAKE_UNKNOWN_PREFIX, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider } from '../../src/modules/channels/whatsapp.fake';
import { MetaCloudProvider } from '../../src/modules/channels/meta-cloud.provider';
import { isRetryableError, WhatsAppProviderError, type SendTextInput, type WhatsAppErrorCode, type WhatsAppProvider } from '../../src/modules/channels/whatsapp.port';

interface Subject {
  provider: WhatsAppProvider;
  validToken: string;
  badToken: string;
  knownId: string;
  unknownId: string;
  unavailableId: string;
  /** Cómo provocar cada resultado de un envío con este proveedor. */
  send: { ok: SendTextInput; window: SendTextInput; recipient: SendTextInput; limit: SendTextInput; down: SendTextInput; rejected: SendTextInput };
}

const APP_SECRET = 'secreto-de-la-app-de-prueba-0123456789';
const sign = (raw: Buffer | string, secret = APP_SECRET): string => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
/** Aviso de Meta con un mensaje de texto, uno con imagen, una reacción del cliente y el estado de un mensaje nuestro. */
const WEBHOOK = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1234567890123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550006789', phone_number_id: '1090123456789' },
            contacts: [{ profile: { name: 'Ana Torres' }, wa_id: '593984217730' }],
            messages: [
              { from: '593984217730', id: 'wamid.TXT1', timestamp: '1760000000', type: 'text', text: { body: 'Hola, quiero una cita' } },
              { from: '593984217730', id: 'wamid.IMG1', timestamp: '1760000010', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'mi corte' } },
              { from: '593984217730', id: 'wamid.RXN1', timestamp: '1760000020', type: 'reaction', reaction: { message_id: 'wamid.OUT1', emoji: '\u{1F44D}' } },
            ],
            statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1760000030', recipient_id: '593984217730' }],
          },
        },
      ],
    },
  ],
};
const entryValue = (value: unknown): unknown => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });

/** Lo que TODO proveedor de WhatsApp debe cumplir. */
function contract(name: string, make: () => Subject): void {
  describe(`contrato WhatsAppProvider · ${name}`, () => {
    const code = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof WhatsAppProviderError) return e.code;
        throw e;
      }
      return 'ok';
    };

    it('describe un número con su teléfono visible y su nombre verificado (o null)', async () => {
      const s = make();
      const info = await s.provider.describeNumber({ accessToken: s.validToken }, s.knownId);
      expect(typeof info.displayPhone).toBe('string');
      expect(info.displayPhone.length).toBeGreaterThan(0);
      expect(info.verifiedName === null || typeof info.verifiedName === 'string').toBe(true);
    });

    it('traduce un token rechazado, un número inexistente y una caída del proveedor a códigos propios', async () => {
      const s = make();
      expect(await code(s.provider.describeNumber({ accessToken: s.badToken }, s.knownId))).toBe('invalid_token');
      expect(await code(s.provider.describeNumber({ accessToken: s.validToken }, s.unknownId))).toBe('number_not_found');
      expect(await code(s.provider.describeNumber({ accessToken: s.validToken }, s.unavailableId))).toBe('unavailable');
    });

    it('verifyWebhook acepta solo la firma HMAC-SHA256 del cuerpo EXACTO y nunca lanza', () => {
      const { provider } = make();
      const raw = Buffer.from(JSON.stringify(WEBHOOK));
      expect(provider.verifyWebhook(raw, sign(raw), APP_SECRET)).toBe(true);
      expect(provider.verifyWebhook(raw, `sha256=${sign(raw).slice(7).toUpperCase()}`, APP_SECRET)).toBe(true); // el hexadecimal no distingue mayúsculas
      expect(provider.verifyWebhook(raw, sign(raw, 'otro-secreto'), APP_SECRET)).toBe(false);
      expect(provider.verifyWebhook(Buffer.from(`${raw.toString()} `), sign(raw), APP_SECRET)).toBe(false); // un solo byte distinto
      expect(provider.verifyWebhook(Buffer.from(JSON.stringify(WEBHOOK, null, 2)), sign(raw), APP_SECRET)).toBe(false); // mismo JSON, otro formato
      for (const bad of [undefined, '', 'sha256=', 'sha256=zz', `sha1=${sign(raw).slice(7)}`, sign(raw).slice(7), `sha256=${'0'.repeat(64)}`, `sha256=${'0'.repeat(63)}`]) expect(provider.verifyWebhook(raw, bad, APP_SECRET), String(bad)).toBe(false);
      expect(provider.verifyWebhook(raw, sign(raw, ''), '')).toBe(false); // sin secreto nada es válido
    });

    it('parseWebhook traduce el aviso a eventos normalizados por número, omite lo que no usa y conserva el aviso original', () => {
      const { provider } = make();
      const now = new Date('2025-10-09T00:00:00Z');
      const { events, ignored } = provider.parseWebhook(WEBHOOK, now);
      expect(ignored).toBe(0);
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.event.phoneNumberId).toBe('1090123456789');
      expect(e.raw).toEqual(WEBHOOK.entry[0]!.changes[0]!.value);
      expect(e.event.messages.map((m) => [m.externalId, m.kind, m.text])).toEqual([['wamid.TXT1', 'text', 'Hola, quiero una cita'], ['wamid.IMG1', 'image', 'mi corte']]);
      expect(e.event.messages[0]).toMatchObject({ from: '+593984217730', fromRaw: '593984217730', profileName: 'Ana Torres', media: null, sentAt: new Date(1760000000 * 1000) });
      expect(e.event.messages[1]!.media).toEqual({ id: 'media-1', mimeType: 'image/jpeg', filename: null });
      expect(e.event.statuses).toEqual([{ externalId: 'wamid.OUT1', state: 'delivered', at: new Date(1760000030 * 1000), error: null }]);
      // la reacción no es un mensaje: viaja aparte, con el mensaje al que reacciona
      expect(e.event.reactions).toEqual([{ targetExternalId: 'wamid.OUT1', emoji: '\u{1F44D}', at: new Date(1760000020 * 1000) }]);
      // lo guardado se vuelve a leer igual
      expect(provider.parseStored(e.raw, now).events[0]!.event).toEqual(e.event);
    });

    it('parseWebhook es tolerante: contenido roto o desconocido se descarta y se cuenta, nunca lanza', () => {
      const { provider } = make();
      const junk: unknown[] = [null, undefined, 42, 'x', [], {}, { object: 'page' }, { object: 'whatsapp_business_account' }, { object: 'whatsapp_business_account', entry: 'no' }, { object: 'whatsapp_business_account', entry: [null, 1, { changes: 'no' }, { changes: [{ field: 'other', value: {} }, { field: 'messages' }, { field: 'messages', value: { metadata: {} } }] }] }];
      for (const j of junk) expect(provider.parseWebhook(j).events, JSON.stringify(j)).toEqual([]);
      const value = {
        metadata: { phone_number_id: '1090123456789' },
        messages: [null, 7, { id: 'a' }, { from: 'abc', id: 'b', type: 'text', text: { body: 'x' } }, { from: '12', id: 'c', type: 'text' }, { from: '593984217730', id: 'wamid.OK', type: 'text', text: { body: 'ok' } }],
        statuses: [null, { id: 'x', status: 'raro' }, { status: 'sent' }],
      };
      const r = provider.parseWebhook(entryValue(value));
      expect(r.events[0]!.event.messages.map((m) => m.externalId)).toEqual(['wamid.OK']);
      expect(r.events[0]!.event.statuses).toEqual([]);
      expect(r.ignored).toBe(8); // 5 mensajes y 3 estados que no se pudieron leer
    });

    it('una reacción trae el emoji; sin emoji es que el cliente quitó la suya; sin mensaje al que reacciona o con un emoji inválido se descarta y se cuenta', () => {
      const { provider } = make();
      const from = '593984217730';
      const rx = (id: string, reaction: unknown, extra: Record<string, unknown> = {}) => ({ from, id, timestamp: '1760000100', type: 'reaction', reaction, ...extra });
      const msgs = [
        rx('r1', { message_id: 'wamid.OUT1', emoji: '\u{2764}\u{FE0F}' }),
        rx('r2', { message_id: 'wamid.OUT2' }), // sin emoji: quitó su reacción
        rx('r3', { message_id: 'wamid.OUT3', emoji: '' }),
        rx('r4', { message_id: 'wamid.OUT4', emoji: '\u{1F44D}\u{1F3FD}' }, { timestamp: undefined }), // sin hora: la del aviso
        rx('r5', { emoji: '\u{1F44D}' }), // sin mensaje al que reacciona
        rx('r6', { message_id: 'wamid.OUT6', emoji: 'a\u0007b' }), // control
        rx('r7', { message_id: 'wamid.OUT7', emoji: 'x'.repeat(33) }), // demasiado largo
        rx('r8', 'no-es-un-objeto'),
      ];
      const now = new Date('2025-10-09T00:00:00Z');
      const r = provider.parseWebhook(entryValue({ metadata: { phone_number_id: '1090123456789' }, messages: msgs }), now);
      expect(r.events[0]!.event.messages).toEqual([]);
      expect(r.events[0]!.event.reactions).toEqual([
        { targetExternalId: 'wamid.OUT1', emoji: '\u{2764}\u{FE0F}', at: new Date(1760000100 * 1000) },
        { targetExternalId: 'wamid.OUT2', emoji: null, at: new Date(1760000100 * 1000) },
        { targetExternalId: 'wamid.OUT3', emoji: null, at: new Date(1760000100 * 1000) },
        { targetExternalId: 'wamid.OUT4', emoji: '\u{1F44D}\u{1F3FD}', at: now },
      ]);
      expect(r.ignored).toBe(4);
    });

    it('parseWebhook entiende los demás tipos: audio, documento, ubicación, contactos, respuestas de botón y lo desconocido', () => {
      const { provider } = make();
      const from = '593984217730';
      const msgs = [
        { from, id: 'm1', type: 'audio', audio: { id: 'au-1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
        { from, id: 'm2', type: 'document', document: { id: 'doc-1', mime_type: 'application/pdf', filename: 'precios.pdf', caption: 'lista' } },
        { from, id: 'm3', type: 'location', location: { latitude: -2.17, longitude: -79.92, name: 'Local', address: 'Av. 9 de Octubre' } },
        { from, id: 'm4', type: 'contacts', contacts: [{ name: { formatted_name: 'A' } }, { name: { formatted_name: 'B' } }] },
        { from, id: 'm5', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sí, confirmo' } } },
        { from, id: 'm6', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Corte de cabello' } } },
        { from, id: 'm7', type: 'button', button: { text: 'Más información', payload: 'x' } },
        { from, id: 'm8', type: 'order', order: {} },
        { from, id: 'm9', type: 'sticker', sticker: { id: 'st-1', mime_type: 'image/webp' } },
        { from, id: 'm10', type: 'system', system: { body: 'cambió de número' } },
      ];
      const r = provider.parseWebhook(entryValue({ metadata: { phone_number_id: '1090123456789' }, messages: msgs }));
      const by = Object.fromEntries(r.events[0]!.event.messages.map((m) => [m.externalId, m]));
      expect(Object.keys(by)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']); // el aviso del sistema se omite
      expect(by['m1']).toMatchObject({ kind: 'audio', text: null, media: { id: 'au-1', mimeType: 'audio/ogg; codecs=opus', filename: null } });
      expect(by['m2']).toMatchObject({ kind: 'document', text: 'lista', media: { id: 'doc-1', filename: 'precios.pdf' } });
      expect(by['m3']).toMatchObject({ kind: 'location', extra: { location: { latitude: -2.17, longitude: -79.92, name: 'Local', address: 'Av. 9 de Octubre' } } });
      expect(by['m4']).toMatchObject({ kind: 'contacts', extra: { contacts_count: 2 } });
      expect(by['m5']).toMatchObject({ kind: 'interactive', text: 'Sí, confirmo' });
      expect(by['m6']).toMatchObject({ kind: 'interactive', text: 'Corte de cabello' });
      expect(by['m7']).toMatchObject({ kind: 'button', text: 'Más información' });
      expect(by['m8']).toMatchObject({ kind: 'unsupported', text: null, media: null });
      expect(by['m9']).toMatchObject({ kind: 'sticker', media: { id: 'st-1' } });
      expect(r.ignored).toBe(0);
    });

    it('un estado fallido trae el código y el título del error; sin error, valores por omisión', () => {
      const { provider } = make();
      const statuses = [{ id: 'a', status: 'failed', timestamp: '1760000000', errors: [{ code: 131047, title: 'Re-engagement message' }] }, { id: 'b', status: 'failed' }, { id: 'c', status: 'read', timestamp: 1760000001 }];
      const r = provider.parseWebhook(entryValue({ metadata: { phone_number_id: '1090123456789' }, statuses }));
      expect(r.events[0]!.event.statuses).toEqual([
        { externalId: 'a', state: 'failed', at: new Date(1760000000 * 1000), error: { code: '131047', title: 'Re-engagement message' } },
        { externalId: 'b', state: 'failed', at: expect.any(Date), error: { code: 'unknown', title: 'Error del proveedor' } },
        { externalId: 'c', state: 'read', at: new Date(1760000001 * 1000), error: null },
      ]);
    });

    it('sendText devuelve el identificador que el proveedor le dio al mensaje', async () => {
      const s = make();
      const sent = await s.provider.sendText({ accessToken: s.validToken }, s.knownId, s.send.ok);
      expect(typeof sent.externalId).toBe('string');
      expect(sent.externalId.length).toBeGreaterThan(3);
    });

    it('sendText traduce cada fallo a un código propio; solo la caída y el límite de envíos son reintentables', async () => {
      const s = make();
      const run = (token: string, input: SendTextInput, id = s.knownId) => code(s.provider.sendText({ accessToken: token }, id, input));
      const cases: Array<[string, string, WhatsAppErrorCode]> = [
        ['token rechazado', await run(s.badToken, s.send.ok), 'invalid_token'],
        ['fuera de las 24 h', await run(s.validToken, s.send.window), 'window_closed'],
        ['destinatario que no puede recibir', await run(s.validToken, s.send.recipient), 'recipient_invalid'],
        ['límite de envíos', await run(s.validToken, s.send.limit), 'rate_limited'],
        ['proveedor caído', await run(s.validToken, s.send.down), 'unavailable'],
        ['rechazo sin más', await run(s.validToken, s.send.rejected), 'rejected'],
        ['número de la conexión que no existe', await run(s.validToken, s.send.ok, s.unknownId), 'number_not_found'],
      ];
      for (const [label, got, expected] of cases) expect(got, label).toBe(expected);
      for (const c of ['invalid_token', 'window_closed', 'recipient_invalid', 'rejected', 'number_not_found'] as const) expect(isRetryableError(c), c).toBe(false);
      expect(isRetryableError('unavailable')).toBe(true);
      expect(isRetryableError('rate_limited')).toBe(true);
    });

    it('un destino o un texto inválidos se rechazan sin llegar al proveedor', async () => {
      const s = make();
      for (const to of ['', '+593984217730', '12345', 'abc', '5939842177301234567']) {
        expect(await code(s.provider.sendText({ accessToken: s.validToken }, s.knownId, { to, text: 'hola' })), to).toBe('recipient_invalid');
      }
      for (const text of ['', 'x'.repeat(4097)]) {
        expect(await code(s.provider.sendText({ accessToken: s.validToken }, s.knownId, { to: '593984217730', text })), `${text.length} caracteres`).toBe('rejected');
      }
    });

    it('un error de envío nunca contiene el token, el texto del cliente ni su teléfono', async () => {
      const s = make();
      const failing = [[s.badToken, s.send.ok], [s.validToken, s.send.window], [s.validToken, s.send.recipient], [s.validToken, s.send.limit], [s.validToken, s.send.down], [s.validToken, s.send.rejected]] as const;
      for (const [token, input] of failing) {
        const err = await s.provider.sendText({ accessToken: token }, s.knownId, input).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WhatsAppProviderError);
        const shown = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
        for (const secret of [token, input.text, input.to]) expect(shown).not.toContain(secret);
      }
    });

    it('un error nunca contiene el token', async () => {
      const s = make();
      for (const [token, id] of [[s.badToken, s.knownId], [s.validToken, s.unknownId], [s.validToken, s.unavailableId]] as const) {
        const err = await s.provider.describeNumber({ accessToken: token }, id).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WhatsAppProviderError);
        expect(String((err as Error).message)).not.toContain(token);
        expect(String((err as Error).stack ?? '')).not.toContain(token);
      }
    });
  });
}

const TO = '593984217730';
contract('fake', () => ({
  provider: new FakeWhatsAppProvider(),
  validToken: FAKE_WHATSAPP_TOKEN,
  badToken: 'token-equivocado-123',
  knownId: '1090123456789',
  unknownId: `${FAKE_UNKNOWN_PREFIX}1`,
  unavailableId: FAKE_UNAVAILABLE_ID,
  send: {
    ok: { to: TO, text: 'Hola Ana' },
    window: { to: TO, text: '[fallar:ventana] Hola Ana' },
    recipient: { to: TO, text: '[fallar:numero] Hola Ana' },
    limit: { to: TO, text: '[fallar:limite] Hola Ana' },
    down: { to: TO, text: '[fallar:caida] Hola Ana' },
    rejected: { to: TO, text: '[fallar:rechazo] Hola Ana' },
  },
}));

// ── Meta Cloud contra un servidor simulado de la Graph API ───────────────────
const VALID = 'EAAG-token-valido-de-prueba-1234567890';
const BAD = 'EAAG-token-vencido-de-prueba-0987654321';
let server: Server;
let origin = '';
const seen: Array<{ url: string; auth: string | undefined }> = [];
/** Cuerpos recibidos en los envíos (POST /messages). */
const sentBodies: Array<Record<string, unknown>> = [];
let mode: 'normal' | 'html' | 'hang' | 'empty' | 'rate' = 'normal';
/** Resultado simulado según el destino: [estado HTTP, código de error de Meta]. */
const FAIL_BY_TO: Record<string, [number, number]> = { '593000000001': [400, 131047], '593000000002': [400, 131026], '593000000003': [400, 130429], '593000000004': [503, 2], '593000000005': [400, 131000] };

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  seen.push({ url, auth: req.headers.authorization });
  const send = (status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (mode === 'hang') return; // no responde nunca
  if (mode === 'html') return send(200, '<html>no soy json</html>', 'text/html');
  if (mode === 'empty') return send(200, { display_phone_number: '' });
  if (mode === 'rate') return send(429, { error: { code: 4, message: 'rate limit' } });
  const target = /^\/v21\.0\/(\d+)\/messages$/.exec(url)?.[1];
  if (target && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      sentBodies.push(body);
      const auth = req.headers.authorization ?? '';
      if (target === '99999999') return send(503, { error: { code: 2, message: 'servicio no disponible' } });
      if (auth === `Bearer ${BAD}`) return send(400, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
      if (auth !== `Bearer ${VALID}`) return send(401, { error: { message: 'sin credencial' } });
      if (target.startsWith('00000')) return send(400, { error: { code: 100, message: 'Object with ID does not exist' } });
      const to = typeof body['to'] === 'string' ? body['to'] : '';
      const fail = FAIL_BY_TO[to];
      // el mensaje de error de Meta trae el teléfono y el texto: el adaptador no debe repetirlos
      if (fail) return send(fail[0], { error: { code: fail[1], message: `fallo simulado para ${to}`, error_data: { details: JSON.stringify(body['text']) } } });
      return send(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: 'wamid.HBgMNTkzOTg0MjE3NzMwFQIAERgS' }] });
    });
    return;
  }
  const id = /^\/v21\.0\/(\d+)\?/.exec(url)?.[1];
  if (!id) return send(404, { error: { code: 100, message: 'ruta desconocida' } });
  if (id === '99999999') return send(503, { error: { code: 2, message: 'servicio no disponible' } });
  const auth = req.headers.authorization ?? '';
  if (auth === `Bearer ${BAD}`) return send(400, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
  if (auth !== `Bearer ${VALID}`) return send(401, { error: { message: 'sin credencial' } });
  if (id.startsWith('00000')) return send(400, { error: { code: 100, message: 'Unsupported get request. Object with ID does not exist' } });
  return send(200, { id, display_phone_number: '+593 98 421 7730', verified_name: 'Barbería Norte' });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });

contract('Meta Cloud (servidor simulado)', () => {
  mode = 'normal';
  return {
    provider: new MetaCloudProvider({ baseUrl: origin }),
    validToken: VALID,
    badToken: BAD,
    knownId: '1090123456789',
    unknownId: '000001234',
    unavailableId: '99999999',
    // el servidor simulado decide el resultado por el destino
    send: {
      ok: { to: TO, text: 'Hola Ana' },
      window: { to: '593000000001', text: 'Hola Ana' },
      recipient: { to: '593000000002', text: 'Hola Ana' },
      limit: { to: '593000000003', text: 'Hola Ana' },
      down: { to: '593000000004', text: 'Hola Ana' },
      rejected: { to: '593000000005', text: 'Hola Ana' },
    },
  };
});

describe('MetaCloudProvider · detalles de la Graph API', () => {
  it('consulta GET /v21.0/<id> con los campos pedidos y el token como Bearer', async () => {
    mode = 'normal';
    seen.length = 0;
    const info = await new MetaCloudProvider({ baseUrl: `${origin}/` }).describeNumber({ accessToken: VALID }, '1090123456789');
    expect(info).toEqual({ displayPhone: '+593 98 421 7730', verifiedName: 'Barbería Norte' });
    expect(seen).toEqual([{ url: '/v21.0/1090123456789?fields=display_phone_number,verified_name', auth: `Bearer ${VALID}` }]);
  });

  it('un id que no son solo dígitos no sale a la red (no puede alterar la ruta)', async () => {
    seen.length = 0;
    const p = new MetaCloudProvider({ baseUrl: origin });
    for (const bad of ['1090/../2', '12 34', 'abc', '', '1234', '123456789012345678901234567890']) {
      await expect(p.describeNumber({ accessToken: VALID }, bad)).rejects.toMatchObject({ code: 'number_not_found' });
    }
    expect(seen).toEqual([]);
  });

  it('sin respuesta a tiempo, con HTML, con un cuerpo sin teléfono o con un límite de peticiones: unavailable', async () => {
    const p = (ms = 5_000) => new MetaCloudProvider({ baseUrl: origin, timeoutMs: ms });
    mode = 'hang';
    await expect(p(80).describeNumber({ accessToken: VALID }, '1090123456789')).rejects.toMatchObject({ code: 'unavailable' });
    for (const m of ['html', 'empty', 'rate'] as const) {
      mode = m;
      await expect(p().describeNumber({ accessToken: VALID }, '1090123456789'), m).rejects.toMatchObject({ code: 'unavailable' });
    }
    mode = 'normal';
  });

  it('con el servidor caído (conexión rechazada) es unavailable', async () => {
    await expect(new MetaCloudProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 }).describeNumber({ accessToken: VALID }, '1090123456789')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('envía POST /v21.0/<id>/messages con el cuerpo de un texto de WhatsApp, el token como Bearer y sin vista previa de enlaces', async () => {
    mode = 'normal';
    seen.length = 0;
    sentBodies.length = 0;
    const sent = await new MetaCloudProvider({ baseUrl: `${origin}/` }).sendText({ accessToken: VALID }, '1090123456789', { to: '593984217730', text: 'Hola Ana, ¿te agendo?' });
    expect(sent).toEqual({ externalId: 'wamid.HBgMNTkzOTg0MjE3NzMwFQIAERgS' });
    expect(seen).toEqual([{ url: '/v21.0/1090123456789/messages', auth: `Bearer ${VALID}` }]);
    expect(sentBodies).toEqual([{ messaging_product: 'whatsapp', recipient_type: 'individual', to: '593984217730', type: 'text', text: { preview_url: false, body: 'Hola Ana, ¿te agendo?' } }]);
  });

  it('un id de número que no son solo dígitos, un destino o un texto inválidos no salen a la red', async () => {
    seen.length = 0;
    const p = new MetaCloudProvider({ baseUrl: origin });
    for (const bad of ['1090/../2', '12 34', 'abc', '']) {
      await expect(p.sendText({ accessToken: VALID }, bad, { to: '593984217730', text: 'hola' })).rejects.toMatchObject({ code: 'number_not_found' });
    }
    await expect(p.sendText({ accessToken: VALID }, '1090123456789', { to: '+593984217730', text: 'hola' })).rejects.toMatchObject({ code: 'recipient_invalid' });
    await expect(p.sendText({ accessToken: VALID }, '1090123456789', { to: '593984217730', text: '' })).rejects.toMatchObject({ code: 'rejected' });
    expect(seen).toEqual([]);
  });

  it('el envío sin respuesta a tiempo, con HTML, sin identificador de mensaje o con la conexión rechazada es unavailable', async () => {
    const p = (ms = 5_000) => new MetaCloudProvider({ baseUrl: origin, timeoutMs: ms });
    const input = { to: '593984217730', text: 'hola' };
    mode = 'hang';
    await expect(p(80).sendText({ accessToken: VALID }, '1090123456789', input)).rejects.toMatchObject({ code: 'unavailable' });
    mode = 'html';
    await expect(p().sendText({ accessToken: VALID }, '1090123456789', input)).rejects.toMatchObject({ code: 'unavailable' });
    mode = 'normal';
    const sinId = (() => Promise.resolve(new Response(JSON.stringify({ messages: [{}] }), { status: 200, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
    await expect(new MetaCloudProvider({ fetchFn: sinId }).sendText({ accessToken: VALID }, '1090123456789', input)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(new MetaCloudProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 }).sendText({ accessToken: VALID }, '1090123456789', input)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('un 429 sin código de error también es rate_limited', async () => {
    mode = 'rate';
    await expect(new MetaCloudProvider({ baseUrl: origin }).sendText({ accessToken: VALID }, '1090123456789', { to: '593984217730', text: 'hola' })).rejects.toMatchObject({ code: 'rate_limited' });
    mode = 'normal';
  });

  it('el verified_name ausente o vacío se informa como null', async () => {
    const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({ display_phone_number: '+1 555 0100', verified_name: '' }), { status: 200, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
    expect(await new MetaCloudProvider({ fetchFn }).describeNumber({ accessToken: VALID }, '1090123456789')).toEqual({ displayPhone: '+1 555 0100', verifiedName: null });
  });
});
