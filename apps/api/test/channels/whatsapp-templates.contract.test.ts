// Contract test de las plantillas del puerto WhatsAppProvider (M5.6a, ADR-50 #9): el fake y el adaptador de Meta (contra un servidor simulado de la Graph API con las formas de
// su documentación) deben comportarse igual al listar y al enviar plantillas. Meta REAL se valida aparte, con la cuenta de pruebas.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetaCloudProvider } from '../../src/modules/channels/meta-cloud.provider';
import { normalizeMetaTemplate } from '../../src/modules/channels/meta-templates';
import { FAKE_UNAVAILABLE_ID, FAKE_UNKNOWN_PREFIX, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider } from '../../src/modules/channels/whatsapp.fake';
import { isRetryableError, WhatsAppProviderError, type SendTemplateInput, type WhatsAppErrorCode, type WhatsAppProvider } from '../../src/modules/channels/whatsapp.port';

interface Subject {
  provider: WhatsAppProvider;
  validToken: string;
  badToken: string;
  wabaId: string;
  unknownWaba: string;
  unavailableWaba: string;
  phoneId: string;
  unknownPhone: string;
  /** Cómo provocar cada resultado de enviar una plantilla con este proveedor. */
  send: { ok: SendTemplateInput; gone: SendTemplateInput; params: SendTemplateInput; recipient: SendTemplateInput; limit: SendTemplateInput; down: SendTemplateInput; rejected: SendTemplateInput };
}

const TO = '593984217730';
const body3 = (...texts: string[]): SendTemplateInput['components'] => [{ type: 'body', subType: null, index: null, parameters: texts.map((text) => ({ name: null, text })) }];

function contract(name: string, make: () => Subject): void {
  describe(`contrato de plantillas · ${name}`, () => {
    const code = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof WhatsAppProviderError) return e.code;
        throw e;
      }
      return 'ok';
    };

    it('listTemplates devuelve las plantillas normalizadas: identificador, nombre, idioma, categoría, estado, cuerpo, botones y motivo de rechazo', async () => {
      const s = make();
      const list = await s.provider.listTemplates({ accessToken: s.validToken }, s.wabaId);
      expect(list.length).toBeGreaterThan(3);
      for (const t of list) {
        expect(typeof t.externalId).toBe('string');
        expect(t.name).toMatch(/^[a-z0-9_]+$/);
        expect(t.language).toMatch(/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/);
        expect(['marketing', 'utility', 'authentication', 'other']).toContain(t.category);
        expect(['approved', 'pending', 'rejected', 'paused', 'disabled', 'other']).toContain(t.status);
        expect(['positional', 'named']).toContain(t.parameterFormat);
        expect(Array.isArray(t.buttons)).toBe(true);
        expect(Array.isArray(t.unsupported)).toBe(true);
        expect(t.rejectedReason === null || typeof t.rejectedReason === 'string').toBe(true);
      }
      const cita = list.find((t) => t.name === 'recordatorio_cita' && t.language === 'es')!;
      expect(cita).toMatchObject({ category: 'utility', status: 'approved', parameterFormat: 'positional' });
      expect(cita.body!.text).toContain('{{1}}');
      expect(cita.body!.examples['1']).toBe('Ana');
      expect(cita.buttons.map((b) => [b.type, b.text])).toEqual([['quick_reply', 'Confirmar'], ['quick_reply', 'Reprogramar']]);
      const rechazada = list.find((t) => t.status === 'rejected')!;
      expect(rechazada.rejectedReason).toBeTruthy();
      expect(list.some((t) => t.status === 'pending')).toBe(true);
      expect(list.some((t) => t.header?.format === 'image')).toBe(true); // lo que no se envía igual se lista
    });

    it('listTemplates traduce token rechazado, cuenta inexistente y caída del proveedor a códigos propios', async () => {
      const s = make();
      expect(await code(s.provider.listTemplates({ accessToken: s.badToken }, s.wabaId))).toBe('invalid_token');
      expect(await code(s.provider.listTemplates({ accessToken: s.validToken }, s.unknownWaba))).toBe('number_not_found');
      expect(await code(s.provider.listTemplates({ accessToken: s.validToken }, s.unavailableWaba))).toBe('unavailable');
    });

    it('sendTemplate devuelve el identificador del mensaje', async () => {
      const s = make();
      const sent = await s.provider.sendTemplate({ accessToken: s.validToken }, s.phoneId, s.send.ok);
      expect(typeof sent.externalId).toBe('string');
      expect(sent.externalId.length).toBeGreaterThan(3);
    });

    it('sendTemplate traduce cada fallo a un código propio; plantilla borrada o datos que no coinciden no se reintentan', async () => {
      const s = make();
      const run = (token: string, input: SendTemplateInput, phone = s.phoneId) => code(s.provider.sendTemplate({ accessToken: token }, phone, input));
      const cases: Array<[string, string, WhatsAppErrorCode]> = [
        ['token rechazado', await run(s.badToken, s.send.ok), 'invalid_token'],
        ['la plantilla ya no existe o está en pausa', await run(s.validToken, s.send.gone), 'template_unavailable'],
        ['datos que no coinciden con la plantilla', await run(s.validToken, s.send.params), 'template_params'],
        ['destinatario que no puede recibir', await run(s.validToken, s.send.recipient), 'recipient_invalid'],
        ['límite de envíos', await run(s.validToken, s.send.limit), 'rate_limited'],
        ['proveedor caído', await run(s.validToken, s.send.down), 'unavailable'],
        ['rechazo sin más', await run(s.validToken, s.send.rejected), 'rejected'],
        ['número de la conexión que no existe', await run(s.validToken, s.send.ok, s.unknownPhone), 'number_not_found'],
      ];
      for (const [label, got, expected] of cases) expect(got, label).toBe(expected);
      expect(isRetryableError('template_unavailable')).toBe(false);
      expect(isRetryableError('template_params')).toBe(false);
    });

    it('un error nunca contiene el token, los datos de la plantilla ni el teléfono', async () => {
      const s = make();
      const failing = [[s.badToken, s.send.ok], [s.validToken, s.send.gone], [s.validToken, s.send.params], [s.validToken, s.send.recipient], [s.validToken, s.send.limit], [s.validToken, s.send.rejected]] as const;
      for (const [token, input] of failing) {
        const err = await s.provider.sendTemplate({ accessToken: token }, s.phoneId, input).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WhatsAppProviderError);
        const shown = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
        for (const secret of [token, input.to, ...input.components.flatMap((c) => c.parameters.map((p) => p.text))]) expect(shown).not.toContain(secret);
      }
      const err = await s.provider.listTemplates({ accessToken: s.badToken }, s.wabaId).catch((e: unknown) => e);
      expect(`${(err as Error).message} ${(err as Error).stack ?? ''}`).not.toContain(s.badToken);
    });
  });
}

contract('fake', () => ({
  provider: new FakeWhatsAppProvider(),
  validToken: FAKE_WHATSAPP_TOKEN,
  badToken: 'token-equivocado-123',
  wabaId: '1234567890123',
  unknownWaba: `${FAKE_UNKNOWN_PREFIX}1`,
  unavailableWaba: FAKE_UNAVAILABLE_ID,
  phoneId: '1090123456789',
  unknownPhone: `${FAKE_UNKNOWN_PREFIX}1`,
  send: {
    ok: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    gone: { to: TO, name: 'ya_no_existe', language: 'es', components: [] },
    params: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero') },
    recipient: { to: '12345', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    limit: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('[fallar:limite] Anabel Quintero', 'viernes 24', '10:00') },
    down: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('[fallar:caida] Anabel Quintero', 'viernes 24', '10:00') },
    rejected: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('[fallar:rechazo] Anabel Quintero', 'viernes 24', '10:00') },
  },
}));

// ── Meta Cloud contra un servidor simulado de la Graph API ───────────────────
const VALID = 'EAAG-token-valido-de-prueba-1234567890';
const BAD = 'EAAG-token-vencido-de-prueba-0987654321';
/** Plantillas como las devuelve la Graph API (formas de su documentación): con ejemplos, botones, encabezados de texto y de imagen, variables con nombre y un rechazo. */
const RAW: unknown[] = [
  { id: '1001', name: 'bienvenida', language: 'es', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hola, gracias por escribirnos.' }, { type: 'FOOTER', text: 'Barbería Norte' }] },
  {
    id: '1002',
    name: 'recordatorio_cita',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}.', example: { body_text: [['Ana', 'viernes 24', '10:00']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar' }, { type: 'QUICK_REPLY', text: 'Reprogramar' }] },
    ],
  },
  {
    id: '1003',
    name: 'promo_corte',
    language: 'es',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Promo para {{1}}', example: { header_text: ['Ana'] } },
      { type: 'BODY', text: 'Reserva con el código {{1}}.', example: { body_text: [['CORTE20']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Reservar', url: 'https://barberia.example/reservar/{{1}}', example: ['https://barberia.example/reservar/abc'] }, { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+593984217730' }] },
    ],
  },
  { id: '1004', name: 'seguimiento_nombrado', language: 'es', status: 'APPROVED', category: 'UTILITY', parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hola {{nombre}}, ¿viste {{servicio}}?', example: { body_text_named_params: [{ param_name: 'nombre', example: 'Ana' }, { param_name: 'servicio', example: 'el corte' }] } }] },
  { id: '1005', name: 'catalogo_imagen', language: 'es', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.example/x.jpg'] } }, { type: 'BODY', text: 'Mira el catálogo.' }] },
  { id: '1006', name: 'en_revision', language: 'es', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Tu pedido {{1}} va en camino.', example: { body_text: [['#123']] } }] },
  { id: '1007', name: 'rechazada_ejemplo', language: 'es', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Compra ahora.' }] },
];
const PAGE_SIZE = 4;
let server: Server;
let origin = '';
const seen: string[] = [];
const sentBodies: Array<Record<string, unknown>> = [];
/** Resultado simulado según el destino: [estado HTTP, código de error de Meta]. */
const FAIL_BY_TO: Record<string, [number, number]> = { '593000000011': [400, 132001], '593000000012': [400, 132000], '593000000002': [400, 131026], '593000000003': [400, 130429], '593000000004': [503, 2], '593000000005': [400, 131000] };

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  seen.push(`${req.method} ${url}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization ?? '';
  const list = /^\/v21\.0\/(\d+)\/message_templates\?(.*)$/.exec(url);
  if (list && req.method === 'GET') {
    const waba = list[1]!;
    if (waba === '99999999') return send(503, { error: { code: 2, message: 'servicio no disponible' } });
    if (auth === `Bearer ${BAD}`) return send(400, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
    if (auth !== `Bearer ${VALID}`) return send(401, { error: { message: 'sin credencial' } });
    if (waba.startsWith('00000')) return send(400, { error: { code: 100, message: 'Object with ID does not exist' } });
    const after = new URLSearchParams(list[2]).get('after');
    const start = after === 'cursor-2' ? PAGE_SIZE : 0;
    const data = RAW.slice(start, start + PAGE_SIZE);
    const more = start + PAGE_SIZE < RAW.length;
    // `next` trae una URL de Meta: el adaptador NO debe seguirla (solo reenvía el cursor)
    return send(200, { data, paging: { cursors: { before: 'b', after: more ? 'cursor-2' : 'cursor-end' }, ...(more ? { next: 'https://evil.example/steal?token=1' } : {}) } });
  }
  const target = /^\/v21\.0\/(\d+)\/messages$/.exec(url)?.[1];
  if (target && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      sentBodies.push(body);
      if (target === '99999999') return send(503, { error: { code: 2, message: 'servicio no disponible' } });
      if (auth === `Bearer ${BAD}`) return send(400, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
      if (auth !== `Bearer ${VALID}`) return send(401, { error: { message: 'sin credencial' } });
      if (target.startsWith('00000')) return send(400, { error: { code: 100, message: 'Object with ID does not exist' } });
      const to = typeof body['to'] === 'string' ? body['to'] : '';
      const fail = FAIL_BY_TO[to];
      if (fail) return send(fail[0], { error: { code: fail[1], message: `fallo simulado para ${to}`, error_data: { details: JSON.stringify(body['template']) } } });
      return send(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: 'wamid.TEMPLATE.1234' }] });
    });
    return;
  }
  send(404, { error: { code: 100, message: 'ruta desconocida' } });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });

contract('Meta Cloud (servidor simulado)', () => ({
  provider: new MetaCloudProvider({ baseUrl: origin }),
  validToken: VALID,
  badToken: BAD,
  wabaId: '1234567890123',
  unknownWaba: '000001234',
  unavailableWaba: '99999999',
  phoneId: '1090123456789',
  unknownPhone: '000001234',
  send: {
    ok: { to: TO, name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    gone: { to: '593000000011', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    params: { to: '593000000012', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero') },
    recipient: { to: '593000000002', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    limit: { to: '593000000003', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    down: { to: '593000000004', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
    rejected: { to: '593000000005', name: 'recordatorio_cita', language: 'es', components: body3('Anabel Quintero', 'viernes 24', '10:00') },
  },
}));

describe('MetaCloudProvider · plantillas · detalles de la Graph API', () => {
  it('pide GET /v21.0/<waba>/message_templates con los campos y el token como Bearer, y sigue la paginación con el cursor (nunca con la URL que trae la respuesta)', async () => {
    seen.length = 0;
    const list = await new MetaCloudProvider({ baseUrl: `${origin}/` }).listTemplates({ accessToken: VALID }, '1234567890123');
    expect(list.map((t) => t.name)).toEqual(['bienvenida', 'recordatorio_cita', 'promo_corte', 'seguimiento_nombrado', 'catalogo_imagen', 'en_revision', 'rechazada_ejemplo']);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^GET \/v21\.0\/1234567890123\/message_templates\?fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Cparameter_format%2Ccomponents%2Crejected_reason&limit=100$/);
    expect(seen[1]).toMatch(/&after=cursor-2$/);
    expect(seen.some((s) => s.includes('evil.example'))).toBe(false);
  });

  it('normaliza cada tipo de plantilla: variables posicionales y con nombre, encabezado de texto, botones, medios y rechazo', async () => {
    const list = await new MetaCloudProvider({ baseUrl: origin }).listTemplates({ accessToken: VALID }, '1234567890123');
    const by = Object.fromEntries(list.map((t) => [t.name, t]));
    expect(by['bienvenida']).toMatchObject({ externalId: '1001', category: 'utility', status: 'approved', footer: 'Barbería Norte', buttons: [], header: null, parameterFormat: 'positional' });
    expect(by['promo_corte']!.header).toEqual({ format: 'text', text: 'Promo para {{1}}', examples: { '1': 'Ana' } });
    expect(by['promo_corte']!.category).toBe('marketing');
    expect(by['promo_corte']!.buttons).toEqual([
      { type: 'url', text: 'Reservar', url: 'https://barberia.example/reservar/{{1}}', phone: null },
      { type: 'phone', text: 'Llamar', url: null, phone: '+593984217730' },
    ]);
    expect(by['seguimiento_nombrado']).toMatchObject({ parameterFormat: 'named', body: { examples: { nombre: 'Ana', servicio: 'el corte' } } });
    expect(by['catalogo_imagen']!.header).toEqual({ format: 'image', text: null, examples: {} });
    expect(by['en_revision']!.status).toBe('pending');
    expect(by['rechazada_ejemplo']).toMatchObject({ status: 'rejected', rejectedReason: 'INVALID_FORMAT' });
  });

  it('envía POST /v21.0/<id>/messages con type template, el idioma y los datos por parte (botón de URL con sub_type e index; variables con nombre)', async () => {
    sentBodies.length = 0;
    const p = new MetaCloudProvider({ baseUrl: origin });
    await p.sendTemplate({ accessToken: VALID }, '1090123456789', {
      to: TO,
      name: 'promo_corte',
      language: 'es',
      components: [
        { type: 'header', subType: null, index: null, parameters: [{ name: null, text: 'Ana' }] },
        { type: 'body', subType: null, index: null, parameters: [{ name: null, text: 'CORTE20' }] },
        { type: 'button', subType: 'url', index: 0, parameters: [{ name: null, text: 'abc' }] },
      ],
    });
    await p.sendTemplate({ accessToken: VALID }, '1090123456789', { to: TO, name: 'seguimiento_nombrado', language: 'es', components: [{ type: 'body', subType: null, index: null, parameters: [{ name: 'nombre', text: 'Ana' }, { name: 'servicio', text: 'el corte' }] }] });
    await p.sendTemplate({ accessToken: VALID }, '1090123456789', { to: TO, name: 'bienvenida', language: 'es', components: [] });
    expect(sentBodies).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TO,
        type: 'template',
        template: {
          name: 'promo_corte',
          language: { code: 'es' },
          components: [
            { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
            { type: 'body', parameters: [{ type: 'text', text: 'CORTE20' }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] },
          ],
        },
      },
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type: 'template', template: { name: 'seguimiento_nombrado', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana', parameter_name: 'nombre' }, { type: 'text', text: 'el corte', parameter_name: 'servicio' }] }] } },
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type: 'template', template: { name: 'bienvenida', language: { code: 'es' } } }, // sin variables, sin componentes
    ]);
  });

  it('un id, un destino, un nombre o un idioma inválidos no salen a la red', async () => {
    seen.length = 0;
    const p = new MetaCloudProvider({ baseUrl: origin });
    await expect(p.listTemplates({ accessToken: VALID }, '123/../4')).rejects.toMatchObject({ code: 'number_not_found' });
    await expect(p.sendTemplate({ accessToken: VALID }, 'abc', { to: TO, name: 'bienvenida', language: 'es', components: [] })).rejects.toMatchObject({ code: 'number_not_found' });
    await expect(p.sendTemplate({ accessToken: VALID }, '1090123456789', { to: '+593984217730', name: 'bienvenida', language: 'es', components: [] })).rejects.toMatchObject({ code: 'recipient_invalid' });
    for (const bad of [{ name: 'Bienvenida', language: 'es' }, { name: 'bien venida', language: 'es' }, { name: '../x', language: 'es' }, { name: 'bienvenida', language: 'español' }, { name: 'bienvenida', language: '' }]) {
      await expect(p.sendTemplate({ accessToken: VALID }, '1090123456789', { to: TO, ...bad, components: [] }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'template_unavailable' });
    }
    expect(seen).toEqual([]);
  });

  it('una respuesta que no es una lista, o sin identificador de mensaje, es unavailable; el servidor caído también', async () => {
    const json = (b: unknown, status = 200) => (() => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
    await expect(new MetaCloudProvider({ fetchFn: json({ nada: 1 }) }).listTemplates({ accessToken: VALID }, '1234567890123')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(new MetaCloudProvider({ fetchFn: json({ messages: [{}] }) }).sendTemplate({ accessToken: VALID }, '1090123456789', { to: TO, name: 'bienvenida', language: 'es', components: [] })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(new MetaCloudProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 }).listTemplates({ accessToken: VALID }, '1234567890123')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(new MetaCloudProvider({ fetchFn: json({ error: { code: 4 } }, 429) }).listTemplates({ accessToken: VALID }, '1234567890123')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('los demás códigos de Meta de una plantilla se traducen: pausada o deshabilitada = no disponible; texto largo o formato = datos que no coinciden', async () => {
    const fail = (code: number) => (() => Promise.resolve(new Response(JSON.stringify({ error: { code } }), { status: 400, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
    for (const [c, expected] of [[132015, 'template_unavailable'], [132016, 'template_unavailable'], [132005, 'template_params'], [132007, 'template_params'], [132012, 'template_params']] as const) {
      await expect(new MetaCloudProvider({ fetchFn: fail(c) }).sendTemplate({ accessToken: VALID }, '1090123456789', { to: TO, name: 'bienvenida', language: 'es', components: [] }), String(c)).rejects.toMatchObject({ code: expected });
    }
  });
});

describe('normalizeMetaTemplate', () => {
  it('descarta lo que no se puede identificar o enviar: sin id, nombre o idioma válidos, o que no es un objeto', () => {
    for (const bad of [null, 7, 'x', [], {}, { id: '1' }, { id: '1', name: 'Mayúsculas', language: 'es' }, { id: '1', name: 'ok', language: 'español' }, { name: 'ok', language: 'es' }]) expect(normalizeMetaTemplate(bad), JSON.stringify(bad)).toBeNull();
  });

  it('lo que no entiende no se pierde: estado y categoría desconocidos = other; componentes extra quedan en `unsupported`; un botón raro es `other`', () => {
    const t = normalizeMetaTemplate({
      id: 77,
      name: 'rara',
      language: 'pt_BR',
      status: 'ARCHIVED',
      category: 'SERVICE',
      components: [{ type: 'BODY', text: 'Olá' }, { type: 'CAROUSEL', cards: [] }, { type: 'LIMITED_TIME_OFFER' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Copiar' }, { type: 'FLOW', text: 'Abrir' }] }],
    })!;
    expect(t).toMatchObject({ externalId: '77', status: 'other', category: 'other', language: 'pt_BR', unsupported: ['carousel', 'limited_time_offer'] });
    expect(t.buttons.map((b) => b.type)).toEqual(['other', 'other']);
  });
});
