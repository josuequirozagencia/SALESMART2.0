// M7.1 — Adaptador de GoHighLevel con Private Token, probado contra un servidor SIMULADO (no hay red real): cabeceras, dirección, errores y que el token no se filtre.
// El contract test común (fake y adaptador) está en ghl.contract.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGhlProvider, GHL_API_VERSION, GhlError, PrivateTokenProvider } from '../../src/modules/ghl';
import { CREDS, ghlProviderContract } from './ghl.contract';

const TOKEN = 'pit-11111111-2222-3333-4444-555555555555';
const creds = { ...CREDS, accessToken: TOKEN };
interface Seen { method: string; url: string; auth: string | undefined; version: string | undefined; contentType: string | undefined; body: unknown }

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
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], version: req.headers['version'] as string | undefined, contentType: req.headers['content-type'], body: raw ? (JSON.parse(raw) as unknown) : null });
      reply(req, res);
    });
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
      return { provider: fake, failNext: (e) => fake.failNextVerify(e), failNextCall: (e) => fake.failNextCall(e) };
    });
  });

  it('lo cumple el adaptador real contra el servidor simulado', async () => {
    let next: GhlError | null = null;
    await ghlProviderContract(() => {
      reply = (req, res) => {
        const e = next;
        next = null;
        if (e) return e.credentials ? json(res, 401, { message: e.message }) : e.retryable ? json(res, 429, { message: e.message }) : json(res, 422, { message: e.message });
        if (req.url?.startsWith('/workflows/')) return json(res, 200, { workflows: [{ id: 'wf000000000001', name: 'Bienvenida', status: 'published' }] });
        if (req.url?.startsWith('/contacts/upsert')) return json(res, 200, { new: true, contact: { id: 'ghlContact0001' } });
        if (req.url?.startsWith('/conversations/messages')) return json(res, 200, { conversationId: 'conv00000001', messageId: 'ghlMsg0000001' });
        if (req.url?.startsWith('/locations/') && req.method === 'GET') return json(res, 200, { tags: [{ id: 'tagVip000001', name: 'VIP', locationId: creds.locationId }] });
        if (req.url?.startsWith('/locations/') && req.method === 'DELETE') return json(res, 200, { succeded: true });
        if (req.url?.includes('/tags')) return json(res, 200, { tags: [] });
        return json(res, 200, { contacts: [] });
      };
      return { provider: provider(), failNext: (e) => { next = e; }, failNextCall: (e) => { next = e; } };
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

describe('PrivateTokenProvider · etiquetas y contactos', () => {
  const CONTACT = 'abc123XYZ789';

  it('agregar etiquetas: POST /contacts/{id}/tags con la lista en el cuerpo y el token en la cabecera', async () => {
    reply = (_q, res) => json(res, 201, { tags: ['vip'] });
    await expect(provider().addTags(creds, CONTACT, ['vip', 'nuevo'])).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: `/contacts/${CONTACT}/tags`, auth: `Bearer ${TOKEN}`, version: GHL_API_VERSION, contentType: 'application/json', body: { tags: ['vip', 'nuevo'] } });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('quitar etiquetas: DELETE /contacts/{id}/tags con la lista en el cuerpo', async () => {
    reply = (_q, res) => json(res, 200, { tags: [] });
    await provider().removeTags(creds, CONTACT, ['vip']);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: `/contacts/${CONTACT}/tags`, body: { tags: ['vip'] } });
  });

  it('las etiquetas se limpian: sin repetidas, sin caracteres de control, acotadas a 100 y a 50 por llamada; sin ninguna no hay llamada', async () => {
    await provider().addTags(creds, CONTACT, ['a', 'a', '  b c ', 'x'.repeat(300), ...Array.from({ length: 80 }, (_, i) => `t${i}`)]);
    const tags = (seen[0]!.body as { tags: string[] }).tags;
    expect(tags).toHaveLength(50);
    expect(tags.slice(0, 2)).toEqual(['a', 'b  c']);
    expect(tags[2]).toHaveLength(100);
    seen.length = 0;
    for (const none of [[], [''], ['   ']]) expect(await fail(provider().addTags(creds, CONTACT, none))).toMatchObject({ retryable: false, credentials: false });
    expect(seen).toHaveLength(0);
  });

  it('un identificador de contacto con forma inválida no sale a la red (no se arma una dirección con texto ajeno)', async () => {
    for (const id of ['../../me', 'a/b', 'corto', 'con espacio1234', 'x'.repeat(65), 'a?b=1&c=22222', '']) {
      expect(await fail(provider().addTags(creds, id, ['vip'])), id).toMatchObject({ retryable: false, credentials: false });
      expect(await fail(provider().removeTags(creds, id, ['vip'])), id).toMatchObject({ retryable: false });
    }
    expect(seen).toHaveLength(0);
  });

  it('401 y 403 son credenciales; un 404 sobre un contacto es «el contacto no existe» (definitivo, sin culpar al token); 429 y 5xx se reintentan', async () => {
    for (const status of [401, 403]) {
      reply = (_q, res) => json(res, status, { message: 'Invalid token' });
      expect(await fail(provider().addTags(creds, CONTACT, ['vip'])), String(status)).toMatchObject({ retryable: false, credentials: true });
    }
    reply = (_q, res) => json(res, 404, { message: 'Contact not found' });
    const gone = await fail(provider().removeTags(creds, CONTACT, ['vip']));
    expect(gone).toMatchObject({ retryable: false, credentials: false });
    expect(gone.message).toContain('no encuentra el contacto');
    for (const status of [429, 500, 503]) {
      reply = (_q, res) => json(res, status, { message: 'later' });
      expect(await fail(provider().addTags(creds, CONTACT, ['vip'])), String(status)).toMatchObject({ retryable: true, credentials: false });
    }
  });

  it('crear o actualizar contacto: POST /contacts/upsert con la Location y solo los datos que hay; devuelve el id y si es nuevo', async () => {
    reply = (_q, res) => json(res, 200, { new: true, contact: { id: 'newContact0001', name: 'Ana' }, traceId: 't' });
    expect(await provider().upsertContact(creds, { name: 'Ana Torres', phone: '+593984217730', email: null })).toEqual({ id: 'newContact0001', created: true });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/contacts/upsert', auth: `Bearer ${TOKEN}`, body: { locationId: creds.locationId, name: 'Ana Torres', phone: '+593984217730' } });
    expect(seen[0]!.body).not.toHaveProperty('email');
    reply = (_q, res) => json(res, 200, { new: false, contact: { id: 'oldContact0002' } });
    expect(await provider().upsertContact(creds, { name: null, phone: null, email: 'ana@correo.test' })).toEqual({ id: 'oldContact0002', created: false });
    expect(seen[1]!.body).toEqual({ locationId: creds.locationId, email: 'ana@correo.test' });
  });

  it('sin teléfono ni correo no se llama; una respuesta sin identificador válido es pasajera; los errores son los mismos', async () => {
    expect(await fail(provider().upsertContact(creds, { name: 'Ana', phone: null, email: null }))).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
    for (const body of [{}, { contact: {} }, { contact: { id: 5 } }, { contact: { id: '../x' } }]) {
      reply = (_q, res) => json(res, 200, body);
      expect(await fail(provider().upsertContact(creds, { name: null, phone: '+593984217730', email: null })), JSON.stringify(body)).toMatchObject({ retryable: true });
    }
    reply = (_q, res) => json(res, 401, { message: 'x' });
    expect(await fail(provider().upsertContact(creds, { name: null, phone: '+593984217730', email: null }))).toMatchObject({ credentials: true });
  });

  it('ningún error de estas llamadas filtra el token, un teléfono ni un correo aunque GHL los repita', async () => {
    reply = (_q, res) => json(res, 422, { message: [`phone +593 98 421-7730 invalid for ${TOKEN}`, 'email ana@correo.test duplicado'] });
    const e = await fail(provider().upsertContact(creds, { name: 'Ana', phone: '+593984217730', email: 'ana@correo.test' }));
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toMatch(/593|98 421|ana@correo/);
    expect(e.message).toContain('[token]');
    expect(e.message).toContain('[correo]');
    expect(e.message).toContain('[número]');
  });
});

describe('PrivateTokenProvider · borrar etiquetas de la Location', () => {
  const LIST = { tags: [{ id: 'tagAbc000001', name: 'Nuevo', locationId: 'x' }, { id: 'tagVip000002', name: ' VIP ', locationId: 'x' }] };

  it('busca la etiqueta por nombre (sin distinguir mayúsculas ni espacios de los bordes) y la borra por su identificador', async () => {
    reply = (req, res) => (req.method === 'GET' ? json(res, 200, LIST) : json(res, 200, { succeded: true }));
    expect(await provider().deleteTag(creds, 'vip')).toEqual({ deleted: true });
    expect(seen.map((s) => [s.method, s.url])).toEqual([['GET', `/locations/${creds.locationId}/tags`], ['DELETE', `/locations/${creds.locationId}/tags/tagVip000002`]]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}` && s.version === GHL_API_VERSION)).toBe(true);
    expect(seen.every((s) => !s.url.includes(TOKEN))).toBe(true);
  });

  it('si GoHighLevel no tiene la etiqueta, no hay nada que borrar y no se llama a DELETE', async () => {
    reply = (_q, res) => json(res, 200, LIST);
    expect(await provider().deleteTag(creds, 'Otra')).toEqual({ deleted: false });
    expect(seen.map((s) => s.method)).toEqual(['GET']);
    reply = (_q, res) => json(res, 200, {});
    expect(await provider().deleteTag(creds, 'VIP')).toEqual({ deleted: false });
  });

  it('si otro la borró entre la búsqueda y el borrado (404) cuenta como ya borrada', async () => {
    reply = (req, res) => (req.method === 'GET' ? json(res, 200, LIST) : json(res, 404, { message: 'Tag not found' }));
    expect(await provider().deleteTag(creds, 'VIP')).toEqual({ deleted: false });
  });

  it('un 403 es «falta el permiso de etiquetas» (definitivo, SIN culpar al token); un 401 sí es de credenciales; 429 y 5xx se reintentan', async () => {
    reply = (_q, res) => json(res, 403, { message: 'Forbidden' });
    const noScope = await fail(provider().deleteTag(creds, 'VIP'));
    expect(noScope).toMatchObject({ retryable: false, credentials: false });
    expect(noScope.message).toContain('permiso');
    reply = (_q, res) => json(res, 401, { message: 'Invalid token' });
    expect(await fail(provider().deleteTag(creds, 'VIP'))).toMatchObject({ retryable: false, credentials: true });
    for (const status of [429, 500, 503]) {
      reply = (_q, res) => json(res, status, { message: 'later' });
      expect(await fail(provider().deleteTag(creds, 'VIP')), String(status)).toMatchObject({ retryable: true, credentials: false });
    }
    // un 403 al BORRAR (permiso de escritura que falta) también es de permiso
    reply = (req, res) => (req.method === 'GET' ? json(res, 200, LIST) : json(res, 403, { message: 'Forbidden' }));
    expect(await fail(provider().deleteTag(creds, 'VIP'))).toMatchObject({ retryable: false, credentials: false });
  });

  it('una lista rota o un identificador raro es pasajero y nunca arma una dirección con texto ajeno', async () => {
    reply = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('no es json');
    };
    expect(await fail(provider().deleteTag(creds, 'VIP'))).toMatchObject({ retryable: true });
    seen.length = 0;
    reply = (_q, res) => json(res, 200, { tags: [{ id: '../../me', name: 'VIP' }] });
    expect(await fail(provider().deleteTag(creds, 'VIP'))).toMatchObject({ retryable: true });
    expect(seen.map((s) => s.method)).toEqual(['GET']); // no llegó a DELETE
  });

  it('un nombre vacío no sale a la red; una Location inválida tampoco', async () => {
    for (const name of ['', '   ']) expect(await fail(provider().deleteTag(creds, name))).toMatchObject({ retryable: false });
    expect(await fail(provider().deleteTag({ ...creds, locationId: '../x' }, 'VIP'))).toMatchObject({ retryable: false, credentials: true });
    expect(seen).toHaveLength(0);
  });
});

describe('PrivateTokenProvider · escribir al cliente (M7.4)', () => {
  const CONTACT = 'abc123XYZ789';

  it('POST /conversations/messages con el canal, el contacto y el texto; el token va en la cabecera; devuelve el id del mensaje', async () => {
    reply = (_q, res) => json(res, 200, { conversationId: 'conv00000001', messageId: 'ghlMsg0000001' });
    expect(await provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'Live_Chat', text: '  Hola, ¿en qué te ayudo?  ' })).toEqual({ id: 'ghlMsg0000001' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/conversations/messages', auth: `Bearer ${TOKEN}`, version: GHL_API_VERSION, contentType: 'application/json', body: { type: 'Live_Chat', contactId: CONTACT, message: 'Hola, ¿en qué te ayudo?' } });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('acepta los cinco canales de texto y rechaza otros sin llamar a la red', async () => {
    reply = (_q, res) => json(res, 200, { messageId: 'ghlMsg0000001' });
    for (const type of ['SMS', 'WhatsApp', 'IG', 'FB', 'Live_Chat'] as const) await expect(provider().sendMessage(creds, { ghlContactId: CONTACT, type, text: 'x' })).resolves.toEqual({ id: 'ghlMsg0000001' });
    seen.length = 0;
    for (const type of ['Email', 'Custom', 'sms', '']) expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: type as never, text: 'x' }))).toMatchObject({ retryable: false, credentials: false });
    expect(seen).toHaveLength(0);
  });

  it('un texto vacío o demasiado largo, o un contacto con forma inválida, no salen a la red', async () => {
    for (const text of ['', '   ', 'x'.repeat(8001)]) expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text }))).toMatchObject({ retryable: false });
    for (const id of ['../../me', 'a/b', 'corto', 'x'.repeat(65)]) expect(await fail(provider().sendMessage(creds, { ghlContactId: id, type: 'SMS', text: 'x' })), id).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
  });

  it('401 es de credenciales; 403 es «falta el permiso de conversaciones» (sin culpar al token); 404 es «el contacto no existe»; 429 y 5xx se reintentan', async () => {
    reply = (_q, res) => json(res, 401, { message: 'Invalid token' });
    expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'x' }))).toMatchObject({ retryable: false, credentials: true });
    reply = (_q, res) => json(res, 403, { message: 'Forbidden' });
    const noScope = await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'x' }));
    expect(noScope).toMatchObject({ retryable: false, credentials: false });
    expect(noScope.message).toContain('permiso');
    reply = (_q, res) => json(res, 404, { message: 'Contact not found' });
    expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'x' }))).toMatchObject({ retryable: false, credentials: false });
    for (const status of [429, 500, 503]) {
      reply = (_q, res) => json(res, status, { message: 'later' });
      expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'x' })), String(status)).toMatchObject({ retryable: true, credentials: false });
    }
  });

  it('una respuesta sin identificador de mensaje es pasajera (no se da por enviado)', async () => {
    for (const body of [{}, { messageId: 5 }, { messageId: '' }, { messageId: 'x'.repeat(300) }]) {
      reply = (_q, res) => json(res, 200, body);
      expect(await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'x' })), JSON.stringify(body)).toMatchObject({ retryable: true });
    }
  });

  it('ningún error repite el texto del cliente, su teléfono o su correo aunque GHL lo repita', async () => {
    reply = (_q, res) => json(res, 422, { message: ['message "Mi número es +593 98 421-7730 y mi correo ana@correo.test" no es válido'] });
    const e = await fail(provider().sendMessage(creds, { ghlContactId: CONTACT, type: 'SMS', text: 'Mi número es +593 98 421-7730' }));
    expect(e.message).not.toMatch(/593|98 421|ana@correo/);
  });
});

describe('PrivateTokenProvider · flujos (M7.5)', () => {
  const CONTACT = 'abc123XYZ789';
  const WF = 'wf000000000001';

  it('GET /workflows/?locationId= devuelve id, nombre y estado, descarta lo mal formado, limpia y acota; el token va en la cabecera', async () => {
    reply = (_q, res) =>
      json(res, 200, {
        workflows: [
          { id: WF, name: '  Bienvenida  ', status: 'published' },
          { id: 'wf000000000002', name: 'Borrador', status: 'draft' },
          { id: '../x', name: 'Mal id', status: 'published' },
          { id: 'wf000000000003', name: '   ', status: 'published' },
          { id: 'wf000000000004', name: 7, status: 'published' },
          { id: 'wf000000000005', name: 'Sin estado' },
        ],
      });
    expect(await provider().listWorkflows(creds)).toEqual([
      { id: WF, name: 'Bienvenida', status: 'published' },
      { id: 'wf000000000002', name: 'Borrador', status: 'draft' },
      { id: 'wf000000000005', name: 'Sin estado', status: 'unknown' },
    ]);
    expect(seen[0]).toMatchObject({ method: 'GET', url: `/workflows/?locationId=${creds.locationId}`, auth: `Bearer ${TOKEN}`, version: GHL_API_VERSION });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it('sin la lista, o con algo que no se entiende, falla con el motivo adecuado', async () => {
    reply = (_q, res) => json(res, 200, { workflows: 'nada' });
    expect(await provider().listWorkflows(creds)).toEqual([]);
    reply = (_q, res) => { res.writeHead(200); res.end('no es json'); };
    expect(await fail(provider().listWorkflows(creds))).toMatchObject({ retryable: true });
    expect(await fail(provider().listWorkflows({ ...creds, locationId: '../x' }))).toMatchObject({ retryable: false, credentials: true });
    reply = (_q, res) => json(res, 401, { message: 'Invalid token' });
    expect(await fail(provider().listWorkflows(creds))).toMatchObject({ retryable: false, credentials: true });
    reply = (_q, res) => json(res, 403, { message: 'not authorized' });
    const noScope = await fail(provider().listWorkflows(creds));
    expect(noScope).toMatchObject({ retryable: false, credentials: false });
    expect(noScope.message).toContain('permiso');
    for (const status of [429, 500, 503]) {
      reply = (_q, res) => json(res, status, { message: 'x' });
      expect(await fail(provider().listWorkflows(creds)), String(status)).toMatchObject({ retryable: true, credentials: false });
    }
  });

  it('POST /contacts/{id}/workflow/{flujo}: el identificador del contacto y el del flujo se validan antes de armar la dirección', async () => {
    reply = (_q, res) => json(res, 200, { succeded: true });
    await expect(provider().enrollInWorkflow(creds, CONTACT, WF)).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'POST', url: `/contacts/${CONTACT}/workflow/${WF}`, auth: `Bearer ${TOKEN}`, version: GHL_API_VERSION });
    seen.length = 0;
    for (const w of ['../../x', 'a/b', 'corto', '', 'x'.repeat(81)]) expect(await fail(provider().enrollInWorkflow(creds, CONTACT, w)), w).toMatchObject({ retryable: false, credentials: false });
    for (const c of ['../../me', 'a/b', 'corto']) expect(await fail(provider().enrollInWorkflow(creds, c, WF)), c).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
  });

  it('errores al inscribir: 401 credenciales; 403 falta de permiso; 404 contacto o flujo inexistente (definitivo); 429/5xx reintentables; ni el token ni datos del cliente en el mensaje', async () => {
    const run = async (status: number, body: unknown) => {
      reply = (_q, res) => json(res, status, body);
      return fail(provider().enrollInWorkflow(creds, CONTACT, WF));
    };
    expect(await run(401, { message: 'Invalid token' })).toMatchObject({ retryable: false, credentials: true });
    const noScope = await run(403, { message: 'The token is not authorized for this scope' });
    expect(noScope).toMatchObject({ retryable: false, credentials: false });
    expect(noScope.message).toContain('permiso');
    expect(await run(404, { message: 'not found' })).toMatchObject({ retryable: false, credentials: false });
    expect(await run(422, { message: 'Contact is already in workflow' })).toMatchObject({ retryable: false, credentials: false });
    for (const status of [429, 500, 502]) expect(await run(status, { message: 'x' }), String(status)).toMatchObject({ retryable: true, credentials: false });
    const leaky = await run(422, { message: `rechazó +593984217730 ana@x.com ${TOKEN}` });
    expect(leaky.message).not.toMatch(/593984217730|ana@x.com|pit-1111/);
  });
});
