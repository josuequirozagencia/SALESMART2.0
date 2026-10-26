// M8.2 — Puerto AIProvider (ADR-53): contract test común del fake y del adaptador de OpenAI, y el adaptador contra un servidor SIMULADO (no hay red real): cabeceras, direcciones, errores y que la clave no se filtre.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProviderError, FakeAiProvider, fakeVector, MAX_EMBED_INPUTS, OpenAiProvider, type AIProvider } from '../../src/modules/ai';

const KEY = 'sk-proj-ABCDEF1234567890abcdef1234567890';
const creds = { apiKey: KEY };
interface Seen { method: string; url: string; auth: string | undefined; contentType: string | undefined; body: Record<string, unknown> | null }

let server: Server;
let origin = '';
const seen: Seen[] = [];
let reply: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const vec = (n: number, seed: number): number[] => Array.from({ length: n }, (_, i) => Math.sin(seed + i));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'], contentType: req.headers['content-type'], body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      reply(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  reply = (_q, res) => json(res, 200, {});
});

/** Responde como OpenAI: embeddings con un vector por texto (fuera de orden, para probar que se reordenan) y chat con su uso. */
const happy = (req: IncomingMessage, res: ServerResponse): void => {
  const body = seen.at(-1)!.body!;
  if (req.url === '/v1/embeddings') {
    const inputs = body['input'] as string[];
    const dims = body['dimensions'] as number;
    const data = inputs.map((_, index) => ({ object: 'embedding', index, embedding: vec(dims, index) })).reverse();
    return json(res, 200, { object: 'list', data, usage: { prompt_tokens: inputs.length * 5, total_tokens: inputs.length * 5 } });
  }
  return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' } }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
};

const provider = (timeoutMs?: number) => new OpenAiProvider({ baseUrl: origin, ...(timeoutMs ? { timeoutMs } : {}) });
const fail = async (p: Promise<unknown>): Promise<AiProviderError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(AiProviderError);
  return e as AiProviderError;
};

/** Contract test del puerto: lo cumplen el fake y el adaptador real. `failNext` deja al proveedor listo para fallar la próxima vez. */
async function aiProviderContract(make: () => { provider: AIProvider; failNext: (e: AiProviderError) => void }): Promise<void> {
  const { provider: p, failNext } = make();
  // 1) embeddings: un vector por texto, en orden, de las dimensiones pedidas, con el consumo
  const e = await p.embed(creds, { model: 'text-embedding-3-small', inputs: ['uno', 'dos', 'tres'], dimensions: 64 });
  expect(e.vectors).toHaveLength(3);
  for (const v of e.vectors) {
    expect(v).toHaveLength(64);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  }
  expect(e.tokens).toBeGreaterThan(0);
  expect(Number.isInteger(e.tokens)).toBe(true);
  // 2) chat: texto y consumo
  const c = await p.chat(creds, { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres amable' }, { role: 'user', content: 'Hola' }], temperature: 0.2, maxTokens: 100 });
  expect(typeof c.text).toBe('string');
  expect(c.text.length).toBeGreaterThan(0);
  expect(c.tokensIn).toBeGreaterThanOrEqual(0);
  expect(c.tokensOut).toBeGreaterThanOrEqual(0);
  // 3) fallos: llegan como AiProviderError con sus banderas y sin perder el motivo; después todo vuelve a funcionar
  failNext(new AiProviderError('clave rechazada', false, true));
  expect(await fail(p.embed(creds, { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 64 }))).toMatchObject({ retryable: false, credentials: true });
  failNext(new AiProviderError('límite de uso', true));
  expect(await fail(p.chat(creds, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], temperature: 0, maxTokens: 10 }))).toMatchObject({ retryable: true, credentials: false });
  await expect(p.embed(creds, { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 64 })).resolves.toHaveProperty('vectors');
  // 4) sin textos no hay nada que vectorizar
  expect(await fail(p.embed(creds, { model: 'text-embedding-3-small', inputs: [], dimensions: 64 }))).toMatchObject({ retryable: false });
}

describe('contract test del puerto AIProvider', () => {
  it('lo cumple el fake', async () => {
    await aiProviderContract(() => {
      const fake = new FakeAiProvider();
      return { provider: fake, failNext: (e) => fake.failNext(e) };
    });
  });

  it('lo cumple el adaptador de OpenAI contra el servidor simulado', async () => {
    let next: AiProviderError | null = null;
    await aiProviderContract(() => {
      reply = (req, res) => {
        const e = next;
        next = null;
        if (e) return e.credentials ? json(res, 401, { error: { message: e.message } }) : e.retryable ? json(res, 429, { error: { message: e.message } }) : json(res, 400, { error: { message: e.message } });
        happy(req, res);
      };
      return { provider: provider(), failNext: (e) => { next = e; } };
    });
  });
});

describe('el fake', () => {
  it('guarda lo que se le pidió (sin la clave en las llamadas), cuenta tokens y permite fijar el consumo', async () => {
    const fake = new FakeAiProvider();
    const r = await fake.embed(creds, { model: 'm', inputs: ['abcdefgh', 'abcd'], dimensions: 16 });
    expect(r.tokens).toBe(3);
    expect(JSON.stringify(fake.calls)).not.toContain(KEY);
    fake.tokensPerInput = 100;
    expect((await fake.embed(creds, { model: 'm', inputs: ['a', 'b'], dimensions: 16 })).tokens).toBe(200);
  });

  it('los vectores falsos son deterministas y textos con las mismas palabras quedan cerca (sin acentos ni mayúsculas)', () => {
    const dot = (a: number[], b: number[]) => a.reduce((n, x, i) => n + x * b[i]!, 0);
    const norm = (a: number[]) => Math.sqrt(dot(a, a));
    const cos = (a: number[], b: number[]) => dot(a, b) / (norm(a) * norm(b));
    const a = fakeVector('Horario de ATENCIÓN de lunes a viernes', 256);
    expect(fakeVector('horario de atencion de lunes a viernes', 256)).toEqual(a);
    expect(cos(a, fakeVector('¿Cuál es el horario de atención?', 256))).toBeGreaterThan(0.3);
    expect(cos(a, fakeVector('precio del tinte rubio ceniza', 256))).toBeLessThan(0.15);
  });
});

describe('OpenAiProvider · embeddings', () => {
  it('POST /v1/embeddings con el modelo, los textos y las dimensiones; la clave va en la cabecera; reordena por índice y suma tokens', async () => {
    reply = happy;
    const out = await provider().embed(creds, { model: 'text-embedding-3-small', inputs: ['uno', 'dos', 'tres'], dimensions: 32 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/embeddings', auth: `Bearer ${KEY}`, contentType: 'application/json', body: { model: 'text-embedding-3-small', input: ['uno', 'dos', 'tres'], dimensions: 32, encoding_format: 'float' } });
    expect(seen[0]!.url).not.toContain(KEY);
    expect(out.vectors).toEqual([vec(32, 0), vec(32, 1), vec(32, 2)]); // el servidor los mandó al revés
    expect(out.tokens).toBe(15);
  });

  it('valida antes de llamar: modelo, cantidad de textos, textos vacíos y dimensiones', async () => {
    reply = happy;
    const base = { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 32 };
    for (const bad of [{ ...base, model: '../x' }, { ...base, model: '' }, { ...base, inputs: [] }, { ...base, inputs: Array.from({ length: MAX_EMBED_INPUTS + 1 }, () => 'x') }, { ...base, inputs: ['x', '   '] }, { ...base, dimensions: 4 }, { ...base, dimensions: 5000 }, { ...base, dimensions: 32.5 }]) {
      expect(await fail(provider().embed(creds, bad)), JSON.stringify(bad).slice(0, 60)).toMatchObject({ retryable: false });
    }
    expect(seen).toHaveLength(0);
  });

  it('una respuesta incompleta o con vectores que no cuadran falla como «no se entiende» (reintentable), no como un vector corrupto', async () => {
    const base = { model: 'text-embedding-3-small', inputs: ['a', 'b'], dimensions: 16 };
    const bodies: unknown[] = [
      { data: [{ index: 0, embedding: vec(16, 0) }], usage: { total_tokens: 3 } }, // falta uno
      { data: [{ index: 0, embedding: vec(16, 0) }, { index: 1, embedding: vec(8, 1) }], usage: { total_tokens: 3 } }, // dimensión distinta
      { data: [{ index: 0, embedding: vec(16, 0) }, { index: 1, embedding: [...vec(15, 1), 'x'] }], usage: { total_tokens: 3 } }, // un valor que no es número
      { data: [{ index: 0, embedding: vec(16, 0) }, { index: 1, embedding: vec(16, 1) }] }, // sin consumo
      { data: 'nada' },
      {},
    ];
    for (const b of bodies) {
      reply = (_q, res) => json(res, 200, b);
      expect(await fail(provider().embed(creds, base)), JSON.stringify(b).slice(0, 60)).toMatchObject({ retryable: true });
    }
    reply = (_q, res) => { res.writeHead(200); res.end('no es json'); };
    expect(await fail(provider().embed(creds, base))).toMatchObject({ retryable: true });
  });
});

describe('OpenAiProvider · chat', () => {
  it('POST /v1/chat/completions con los mensajes, la temperatura acotada y el tope de tokens; devuelve el texto y el uso', async () => {
    reply = happy;
    const out = await provider().chat(creds, { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres amable' }, { role: 'user', content: 'Hola' }], temperature: 5, maxTokens: 999_999 });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/chat/completions', auth: `Bearer ${KEY}`, body: { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres amable' }, { role: 'user', content: 'Hola' }], temperature: 2, max_completion_tokens: 16_000 } });
    expect(out).toEqual({ text: 'Hola, ¿en qué te ayudo?', tokensIn: 12, tokensOut: 7 });
  });

  it('valida modelo y mensajes; una respuesta sin texto o sin uso falla como «no se entiende»', async () => {
    reply = happy;
    expect(await fail(provider().chat(creds, { model: 'a b', messages: [{ role: 'user', content: 'x' }], temperature: 0, maxTokens: 10 }))).toMatchObject({ retryable: false });
    expect(await fail(provider().chat(creds, { model: 'gpt-4o-mini', messages: [], temperature: 0, maxTokens: 10 }))).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
    for (const b of [{ choices: [] }, { choices: [{ message: { content: 7 } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, { choices: [{ message: { content: 'ok' } }] }]) {
      reply = (_q, res) => json(res, 200, b);
      expect(await fail(provider().chat(creds, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], temperature: 0, maxTokens: 10 }))).toMatchObject({ retryable: true });
    }
  });
});

describe('OpenAiProvider · chat con herramientas (M8.5b)', () => {
  const tools = [{ name: 'create_task', description: 'Crea una tarea', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }];
  const ask = (messages: Parameters<OpenAiProvider['chat']>[1]['messages']) => provider().chat(creds, { model: 'gpt-4o-mini', messages, temperature: 0.3, maxTokens: 200, tools });

  it('envía las herramientas como funciones y los turnos con tool_calls y resultados en el formato de OpenAI', async () => {
    reply = happy;
    await ask([
      { role: 'system', content: 'Eres amable' },
      { role: 'user', content: 'Llámenme' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'create_task', arguments: '{"title":"Llamar"}' }] },
      { role: 'tool', toolCallId: 'call_1', content: 'done: tarea creada' },
    ]);
    const body = seen[0]!.body!;
    expect(body['tools']).toEqual([{ type: 'function', function: { name: 'create_task', description: 'Crea una tarea', parameters: tools[0]!.parameters } }]);
    expect(body['tool_choice']).toBe('auto');
    expect(body['messages']).toEqual([
      { role: 'system', content: 'Eres amable' },
      { role: 'user', content: 'Llámenme' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_task', arguments: '{"title":"Llamar"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done: tarea creada' },
    ]);
  });

  it('sin herramientas no manda ni «tools» ni «tool_choice»', async () => {
    reply = happy;
    await provider().chat(creds, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hola' }], temperature: 0, maxTokens: 10 });
    expect(seen[0]!.body).not.toHaveProperty('tools');
    expect(seen[0]!.body).not.toHaveProperty('tool_choice');
  });

  it('lee las herramientas que el modelo pidió (con el texto nulo) y rechaza las mal formadas', async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 9 };
    reply = (_q, res) => json(res, 200, { choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'create_task', arguments: '{"title":"X"}' } }] } }], usage });
    expect(await ask([{ role: 'user', content: 'x' }])).toEqual({ text: '', tokensIn: 20, tokensOut: 9, toolCalls: [{ id: 'call_9', name: 'create_task', arguments: '{"title":"X"}' }] });
    reply = (_q, res) => json(res, 200, { choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'create_task' } }] } }], usage });
    expect(await fail(ask([{ role: 'user', content: 'x' }]))).toMatchObject({ retryable: true });
    // texto nulo SIN herramientas sigue siendo una respuesta que no se entiende
    reply = (_q, res) => json(res, 200, { choices: [{ message: { content: null } }], usage });
    expect(await fail(ask([{ role: 'user', content: 'x' }]))).toMatchObject({ retryable: true });
  });

  it('el fake pide herramientas como se le programe y las expone igual que el adaptador real', async () => {
    const fake = new FakeAiProvider();
    fake.chatResult = () => ({ toolCalls: [{ id: 'c1', name: 'create_task', arguments: '{"title":"Y"}' }] });
    const out = await fake.chat({ apiKey: '' }, { model: 'm', messages: [{ role: 'user', content: 'hola' }], temperature: 0, maxTokens: 10, tools });
    expect(out.toolCalls).toEqual([{ id: 'c1', name: 'create_task', arguments: '{"title":"Y"}' }]);
    expect(out.text).toBe('');
  });
});

describe('OpenAiProvider · errores', () => {
  const embed = () => provider().embed(creds, { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 16 });
  const run = async (status: number, body: unknown) => {
    reply = (_q, res) => json(res, status, body);
    return fail(embed());
  };

  it('401 y 403: la clave de la plataforma no sirve (definitivo); 429 «sin cuota»: la cuenta no tiene saldo (definitivo, de la clave); otro 429 y 5xx: se reintentan; 400: definitivo', async () => {
    expect(await run(401, { error: { message: 'Incorrect API key provided' } })).toMatchObject({ retryable: false, credentials: true });
    expect(await run(403, { error: { message: 'forbidden' } })).toMatchObject({ retryable: false, credentials: true });
    const quota = await run(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota', type: 'insufficient_quota' } });
    expect(quota).toMatchObject({ retryable: false, credentials: true });
    expect(await run(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } })).toMatchObject({ retryable: true, credentials: false });
    for (const status of [500, 502, 503]) expect(await run(status, { error: { message: 'oops' } }), String(status)).toMatchObject({ retryable: true, credentials: false });
    expect(await run(400, { error: { message: 'input too long' } })).toMatchObject({ retryable: false, credentials: false });
    expect(await run(404, {})).toMatchObject({ retryable: false });
  });

  it('el mensaje de un error NUNCA lleva la clave, un correo ni el contenido enviado', async () => {
    const e = await run(401, { error: { message: `Incorrect API key provided: ${KEY}. Contacta a ana@example.com` } });
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toMatch(/sk-proj|ana@example\.com/);
    expect(e.message).toContain('[clave]');
    expect(e.message.length).toBeLessThan(300);
  });

  it('red caída, redirección y tiempo agotado: error pasajero sin dirección ni datos', async () => {
    const down = new OpenAiProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    const e = await fail(down.embed(creds, { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 16 }));
    expect(e).toMatchObject({ retryable: true, credentials: false });
    expect(e.message).not.toContain('127.0.0.1');
    reply = (_q, res) => { res.writeHead(302, { location: 'http://evil.example/steal' }); res.end(); };
    expect(await fail(embed())).toMatchObject({ retryable: true });
    reply = () => undefined; // nunca contesta
    expect(await fail(provider(300).embed(creds, { model: 'text-embedding-3-small', inputs: ['x'], dimensions: 16 }))).toMatchObject({ retryable: true });
  });
});
