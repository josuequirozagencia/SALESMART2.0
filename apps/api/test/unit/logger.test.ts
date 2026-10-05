import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactPii, redactString, REDACTED } from '../../src/logger';
import { TenantContext } from '../../src/tenant';
import { ORG_A, USER_1 } from '../support/constants';

function capture() {
  const lines: string[] = [];
  const dest = new Writable({ write(chunk: Buffer, _e, cb) { lines.push(chunk.toString()); cb(); } });
  const log = createLogger({ level: 'trace', destination: dest });
  return { log, out: () => lines.join(''), json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('redactPii — claves', () => {
  it.each([
    ['password', 'hunter2'], ['accessToken', 'abc'], ['Authorization', 'Bearer abcdefghij'], ['cookie', 'sid=1'],
    ['api_key', 'k'], ['clientSecret', 's'], ['email', 'a@b.co'], ['phone', '+593 99 123 4567'], ['whatsapp', 'x'],
    ['messageBody', 'hola'], ['body', 'hola'], ['transcript', 'hola'], ['fullName', 'Ana Pérez'], ['direccion', 'Av 1'], ['cedula', '0912345678'],
  ])('redacta la clave %s', (k, v) => {
    expect(redactPii({ [k]: v })).toEqual({ [k]: REDACTED });
  });
  it('conserva claves seguras y métricas numéricas (tokensUsed, contentType...)', () => {
    expect(redactPii({ tokensUsed: 123, contentType: 'application/json', org_id: ORG_A, status: 200, token: 5 })).toEqual({
      tokensUsed: 123, contentType: 'application/json', org_id: ORG_A, status: 200, token: 5,
    });
  });
  it('anida: objetos, arrays y claves en mayúsculas/guiones', () => {
    expect(redactPii({ req: { headers: { 'X-Api-Key': 'k', accept: 'x' }, items: [{ Password: 'p' }] } })).toEqual({
      req: { headers: { 'X-Api-Key': REDACTED, accept: 'x' }, items: [{ Password: REDACTED }] },
    });
  });
});

describe('redactPii — valores', () => {
  it.each([
    ['correo', 'contacto: ana.perez+x@empresa.com.ec ok', 'contacto: [REDACTED] ok'],
    ['JWT', 'tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fw ok', 'tok [REDACTED] ok'],
    ['Bearer', 'Authorization: Bearer abcDEF1234567890', 'Authorization: Bearer [REDACTED]'],
    ['credenciales en URL', 'postgres://user:pa55w0rd@host:5432/db', 'postgres://[REDACTED]@host:5432/db'],
    ['parámetro secreto', 'GET /cb?code=XYZ123&state=ok&access_token=abc.def', 'GET /cb?code=[REDACTED]&state=ok&access_token=[REDACTED]'],
    ['tarjeta (Luhn)', 'pago 4111 1111 1111 1111 ok', 'pago [REDACTED] ok'],
    ['teléfono internacional', 'llamar al +593 99 123 4567 hoy', 'llamar al [REDACTED] hoy'],
    ['teléfono local', 'cel 0991234567', 'cel [REDACTED]'],
  ])('redacta %s en cadenas', (_n, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
  it('NO destruye UUID, fechas ni números cortos', () => {
    const s = `org ${ORG_A} user ${USER_1} at 2026-10-04T12:30:45.123Z rows 12345 total 3.5`;
    expect(redactString(s)).toBe(s);
  });
  it('trunca cadenas enormes y limita profundidad/ciclos sin lanzar', () => {
    expect(redactString('x'.repeat(5000)).length).toBeLessThan(2100);
    const a: Record<string, unknown> = { n: 1 };
    a['self'] = a;
    expect(redactPii(a)).toEqual({ n: 1, self: '[Circular]' });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(redactPii(deep))).toContain('Truncated depth');
  });
  it('nunca lanza con valores raros (BigInt, símbolos, getters que fallan)', () => {
    const evil = { get boom(): string { throw new Error('x'); }, big: 10n, s: Symbol('s'), f: () => 1 };
    expect(() => redactPii(evil)).not.toThrow();
  });
});

describe('Error: sin params ni propiedades arbitrarias', () => {
  it('quita el bloque "params:" que Drizzle añade al mensaje y no copia `params`/`query`', () => {
    const err = Object.assign(new Error('Failed query: insert into contacts (name) values ($1)\nparams: Ana Pérez,ana@correo.com,0991234567'), {
      params: ['Ana Pérez', 'ana@correo.com'], query: 'insert ...', code: '23505', detail: 'Key (email)=(ana@correo.com) already exists.',
    });
    const out = JSON.stringify(redactPii(err));
    expect(out).not.toMatch(/ana@correo|Ana Pérez|0991234567/);
    expect(out).toContain('params: [omitted]');
    expect(out).toContain('23505');
    expect(out).not.toContain('"params":[');
  });
  it('conserva la causa (recursivamente redactada)', () => {
    const e = new Error('outer', { cause: new Error('inner juan@x.com') });
    expect(JSON.stringify(redactPii(e))).not.toContain('juan@x.com');
    expect(JSON.stringify(redactPii(e))).toContain('inner');
  });
});

describe('logger (pino)', () => {
  it('emite JSON estructurado con nivel y sin pid/hostname', () => {
    const { log, json } = capture();
    log.info({ evento: 'x' }, 'hola');
    const [l] = json();
    expect(l).toMatchObject({ level: 'info', msg: 'hola', evento: 'x' });
    expect(l).not.toHaveProperty('pid');
    expect(l).not.toHaveProperty('hostname');
  });
  it('redacta el objeto, el mensaje, los args de formato y los bindings de child()', () => {
    const { log, out } = capture();
    log.info({ email: 'a@b.com', password: 'p', nested: { token: 't' } }, 'cliente a@b.com pidió %s', 'llamar al 0991234567');
    log.child({ phone: '0991234567', contactName: 'ok', apiKey: 'sk-1' }).warn('con child');
    log.error({ err: Object.assign(new Error('fallo ana@x.com\nparams: secreto'), { code: 'X' }) }, 'falló');
    const text = out();
    expect(text).not.toMatch(/a@b\.com|ana@x\.com|0991234567|"p"|sk-1|secreto/);
    expect(text).toContain(REDACTED);
  });
  it('child().child() también redacta (los hijos heredan la redacción)', () => {
    const { log, out } = capture();
    log.child({ a: 1 }).child({ email: 'zz@zz.com', secret: 's3' }).info('x');
    expect(out()).not.toMatch(/zz@zz|s3/);
  });
  it('añade org_id, request_id y user_id desde el TenantContext (y nada fuera de él)', () => {
    const { log, json } = capture();
    log.info('sin contexto');
    TenantContext.run({ organizationId: ORG_A, userId: USER_1, requestId: 'r-1' }, () => log.info('con contexto'));
    const [a, b] = json();
    expect(a).not.toHaveProperty('org_id');
    expect(b).toMatchObject({ org_id: ORG_A, user_id: USER_1, request_id: 'r-1' });
  });
  it('respeta el nivel configurado', () => {
    const { log, json } = capture();
    const quiet = createLogger({ level: 'error' });
    expect(quiet.isLevelEnabled('info')).toBe(false);
    log.debug('d');
    expect(json()).toHaveLength(1);
  });
});
