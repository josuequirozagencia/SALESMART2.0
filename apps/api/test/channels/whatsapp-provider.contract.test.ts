// Contract test del puerto WhatsAppProvider (ADR-50 #9): el fake y el adaptador de Meta (contra un servidor simulado de la Graph API) deben comportarse igual.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_UNAVAILABLE_ID, FAKE_UNKNOWN_PREFIX, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider } from '../../src/modules/channels/whatsapp.fake';
import { MetaCloudProvider } from '../../src/modules/channels/meta-cloud.provider';
import { WhatsAppProviderError, type WhatsAppProvider } from '../../src/modules/channels/whatsapp.port';

interface Subject {
  provider: WhatsAppProvider;
  validToken: string;
  badToken: string;
  knownId: string;
  unknownId: string;
  unavailableId: string;
}

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

contract('fake', () => ({ provider: new FakeWhatsAppProvider(), validToken: FAKE_WHATSAPP_TOKEN, badToken: 'token-equivocado-123', knownId: '1090123456789', unknownId: `${FAKE_UNKNOWN_PREFIX}1`, unavailableId: FAKE_UNAVAILABLE_ID }));

// ── Meta Cloud contra un servidor simulado de la Graph API ───────────────────
const VALID = 'EAAG-token-valido-de-prueba-1234567890';
const BAD = 'EAAG-token-vencido-de-prueba-0987654321';
let server: Server;
let origin = '';
const seen: Array<{ url: string; auth: string | undefined }> = [];
let mode: 'normal' | 'html' | 'hang' | 'empty' | 'rate' = 'normal';

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
  return { provider: new MetaCloudProvider({ baseUrl: origin }), validToken: VALID, badToken: BAD, knownId: '1090123456789', unknownId: '000001234', unavailableId: '99999999' };
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

  it('el verified_name ausente o vacío se informa como null', async () => {
    const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({ display_phone_number: '+1 555 0100', verified_name: '' }), { status: 200, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
    expect(await new MetaCloudProvider({ fetchFn }).describeNumber({ accessToken: VALID }, '1090123456789')).toEqual({ displayPhone: '+1 555 0100', verifiedName: null });
  });
});
