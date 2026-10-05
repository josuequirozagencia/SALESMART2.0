// Capa HTTP: errores seguros, validación, deny-by-default y contexto de organización desde el principal verificado.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, mapException, NotFoundError, UnauthorizedError, ValidationError } from '../../src/errors';
import { HttpException } from '@nestjs/common';
import { ORG_A, ORG_B, USER_1 } from '../support/constants';
import { call } from '../support/isolation-suite';
import { platformHeader, principalHeader, startFixtureApp } from '../support/fixture-app';
import { requireDb } from '../support/harness';

let base = '';
let stop: () => Promise<void> = async () => undefined;
const A = principalHeader(ORG_A, USER_1);
const B = principalHeader(ORG_B, USER_1);

beforeAll(async () => {
  const info = requireDb();
  const s = await startFixtureApp(info);
  base = s.base;
  stop = async () => { await s.app.close(); s.restore(); };
});
afterAll(() => stop());

const json = (t: string) => JSON.parse(t) as { error: { code: string; message: string; request_id: string; details: Array<{ path: string; code: string; message: string }> } };

describe('mapException (unitario)', () => {
  it('AppError conserva su mensaje seguro', () => {
    expect(mapException(new NotFoundError())).toMatchObject({ status: 404, code: 'NOT_FOUND', log: false });
    expect(mapException(new UnauthorizedError())).toMatchObject({ status: 401, message: 'No autenticado' });
    expect(mapException(new ConflictError())).toMatchObject({ status: 409 });
    expect(mapException(new ValidationError([{ path: 'a', code: 'x', message: 'm' }])).details).toHaveLength(1);
  });
  it('error de Drizzle/pg: NUNCA expone message (lleva SQL y params); mapea por SQLSTATE', () => {
    const drizzleLike = Object.assign(new Error('Failed query: insert into contacts ... params: ana@x.com,0991234567'), { cause: Object.assign(new Error('duplicate key value (ana@x.com)'), { code: '23505' }) });
    const m = mapException(drizzleLike);
    expect(m).toMatchObject({ status: 409, code: 'CONFLICT', log: false });
    expect(JSON.stringify(m)).not.toMatch(/ana@x|0991234567|insert|params/);
    expect(mapException(Object.assign(new Error('x'), { cause: { code: '22P02' } })).status).toBe(400);
  });
  it('errores desconocidos → 500 genérico y se registran', () => {
    const m = mapException(new Error('secreto ana@x.com'));
    expect(m).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'Error interno', log: true });
    expect(JSON.stringify(m)).not.toContain('ana@x.com');
  });
  it('HttpException de Nest: solo usa el estado, no su mensaje', () => {
    const m = mapException(new HttpException('mensaje con datos ana@x.com', 404));
    expect(m).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(JSON.stringify(m)).not.toContain('ana@x.com');
  });
  it('error de body-parser (JSON inválido) → 400 genérico sin repetir el cuerpo', () => {
    const e = Object.assign(new SyntaxError(`Unexpected token 'a', "ana@x.com" is not valid JSON`), { type: 'entity.parse.failed', statusCode: 400, status: 400 });
    const m = mapException(e);
    expect(m).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    expect(JSON.stringify(m)).not.toContain('ana@x.com');
  });
});

describe('formato de error y request_id', () => {
  it('500 inesperado: cuerpo genérico, sin PII, con request_id igual al de la cabecera', async () => {
    const res = await fetch(`${base}/probe/boom`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toMatch(/ana\.perez|0991234567|correo/);
    const body = json(text);
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Error interno', details: [] });
    expect(body.error.request_id).toBe(res.headers.get('x-request-id'));
  });
  it('acepta un x-request-id seguro y reemplaza uno inseguro', async () => {
    const ok = await fetch(`${base}/probe/public`, { headers: { 'x-request-id': 'req-12345678' } });
    expect(ok.headers.get('x-request-id')).toBe('req-12345678');
    const bad = await fetch(`${base}/probe/public`, { headers: { 'x-request-id': 'x<script>' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('ruta inexistente → 404 genérico con request_id, sin autenticación', async () => {
    const res = await call(base, 'GET', '/no/existe', {});
    expect(res.status).toBe(404);
    expect(json(res.text).error).toMatchObject({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
  });
  it('JSON mal formado → 400 sin repetir el cuerpo', async () => {
    const res = await fetch(`${base}/contacts`, { method: 'POST', headers: { ...A, 'content-type': 'application/json' }, body: '{"name": ana@x.com' });
    const t = await res.text();
    expect(res.status).toBe(400);
    expect(t).not.toContain('ana@x.com');
    expect(json(t).error.code).toBe('BAD_REQUEST');
  });
  it('cuerpo demasiado grande → 413', async () => {
    const res = await fetch(`${base}/contacts`, { method: 'POST', headers: { ...A, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(300_000) }) });
    expect(res.status).toBe(413);
  });
  it('error de BD por valor mal formado (uuid inválido) → 400 sin SQL en la respuesta', async () => {
    const res = await call(base, 'GET', '/contacts/no-es-uuid', A);
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/select|from|contacts"|params|invalid input syntax/i);
  });
  it('no anuncia el framework (x-powered-by)', async () => {
    expect((await fetch(`${base}/probe/public`)).headers.get('x-powered-by')).toBeNull();
  });
});

describe('validación (zod)', () => {
  it('cuerpo inválido → 400 VALIDATION_ERROR con ruta y sin eco del valor', async () => {
    const res = await call(base, 'POST', '/contacts', A, { name: 12345 });
    expect(res.status).toBe(400);
    const b = json(res.text);
    expect(b.error.code).toBe('VALIDATION_ERROR');
    expect(b.error.details[0]).toMatchObject({ path: 'name' });
    expect(res.text).not.toContain('12345');
  });
  it('campos desconocidos rechazados (strict): no se puede inyectar organization_id en el cuerpo', async () => {
    const res = await call(base, 'POST', '/contacts', A, { name: 'Intruso', organization_id: ORG_B });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).error.code).toBe('VALIDATION_ERROR');
  });
  it('cuerpo válido → 201 y la fila pertenece a la organización del principal', async () => {
    const res = await call(base, 'POST', '/contacts', A, { name: 'Nuevo (A)' });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.text).organizationId).toBe(ORG_A);
    const id = JSON.parse(res.text).id as string;
    expect((await call(base, 'DELETE', `/contacts/${id}`, A)).status).toBe(204);
  });
});

describe('deny-by-default y contexto', () => {
  it('ruta sin decorador y sin credenciales → 401; con principal → 200', async () => {
    expect((await call(base, 'GET', '/probe/implicit-tenant', {})).status).toBe(401);
    expect((await call(base, 'GET', '/probe/implicit-tenant', A)).status).toBe(200);
  });
  it('@Public() no exige credenciales', async () => {
    expect((await call(base, 'GET', '/probe/public', {})).status).toBe(200);
  });
  it('rutas de plataforma: 401 sin credenciales, 403 con principal de tenant, 200 con super admin', async () => {
    expect((await call(base, 'GET', '/probe/platform', {})).status).toBe(401);
    expect((await call(base, 'GET', '/probe/platform', A)).status).toBe(403);
    const ok = await call(base, 'GET', '/probe/platform', platformHeader(USER_1));
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).actor).toBe(USER_1);
  });
  it('un principal de plataforma no entra a rutas de tenant (403 CONTEXT_REQUIRED)', async () => {
    const res = await call(base, 'GET', '/contacts', platformHeader(USER_1));
    expect(res.status).toBe(403);
    expect(json(res.text).error.code).toBe('CONTEXT_REQUIRED');
  });
  it('la organización sale SOLO del principal: cabeceras, query y cuerpo que digan otra cosa se ignoran', async () => {
    const res = await call(base, 'GET', `/probe/whoami?organizationId=${ORG_B}&org_id=${ORG_B}`, { ...A, 'x-organization-id': ORG_B, 'x-org-id': ORG_B });
    expect(JSON.parse(res.text).org).toBe(ORG_A);
  });
  it('60 peticiones concurrentes alternando A/B: cada una ve su organización y solo sus datos', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const [org, h, marker] = i % 2 ? [ORG_A, A, '(A)'] : [ORG_B, B, '(B)'];
        return Promise.all([call(base, 'GET', '/probe/whoami', h), call(base, 'GET', '/contacts', h)]).then(([w, l]) => ({ org, marker, who: JSON.parse(w.text).org as string, names: (JSON.parse(l.text) as Array<{ name: string }>).map((c) => c.name) }));
      }),
    );
    for (const r of results) {
      expect(r.who).toBe(r.org);
      for (const n of r.names) expect(n).toContain(r.marker);
    }
  });
});
