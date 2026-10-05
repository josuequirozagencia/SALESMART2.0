// Suite A↔B generada para los endpoints de fixture. Los módulos reales harán lo mismo con sus rutas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTACT_B1, ORG_A, ORG_B, USER_1 } from '../../support/constants';
import { principalHeader, startFixtureApp } from '../../support/fixture-app';
import { requireDb } from '../../support/harness';
import { assertNoLeak, call, describeTenantEndpointIsolation } from '../../support/isolation-suite';

let base = '';
let stop: () => Promise<void> = async () => undefined;
beforeAll(async () => {
  const s = await startFixtureApp(requireDb());
  base = s.base;
  stop = async () => { await s.app.close(); s.restore(); };
});
afterAll(() => stop());

const A = { headers: principalHeader(ORG_A, USER_1) };
const B = { headers: principalHeader(ORG_B, USER_1) };

describeTenantEndpointIsolation({
  title: 'contacts (fixture)',
  base: () => base,
  actorA: A,
  actorB: B,
  foreign: { id: CONTACT_B1, name: 'Beto (B)', orgId: ORG_B },
  cases: [
    { route: 'GET /contacts/:id', request: (f) => ({ method: 'GET', path: `/contacts/${f.id}` }), expect: 'not-found' },
    { route: 'PATCH /contacts/:id', request: (f) => ({ method: 'PATCH', path: `/contacts/${f.id}`, body: { name: 'HACKEADO' } }), expect: 'not-found' },
    { route: 'DELETE /contacts/:id', request: (f) => ({ method: 'DELETE', path: `/contacts/${f.id}` }), expect: 'not-found' },
    { route: 'GET /contacts?search=', request: (f) => ({ method: 'GET', path: `/contacts?search=${encodeURIComponent(f.name.slice(0, 4))}` }), expect: 'no-leak' },
    { route: 'GET /contacts', request: () => ({ method: 'GET', path: '/contacts' }), expect: 'no-leak' },
  ],
  verifyBIntact: async () => {
    const res = await call(base, 'GET', `/contacts/${CONTACT_B1}`, B.headers);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ id: CONTACT_B1, name: 'Beto (B)', organizationId: ORG_B });
  },
});

describe('control del generador', () => {
  it('B SÍ ve su propio recurso (la suite puede ver datos cuando debe)', async () => {
    const res = await call(base, 'GET', `/contacts/${CONTACT_B1}`, B.headers);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Beto (B)');
  });
  it('assertNoLeak tiene dientes: lanza si la respuesta contiene un identificador ajeno', () => {
    expect(() => assertNoLeak(`{"id":"${CONTACT_B1}"}`, [CONTACT_B1])).toThrow();
    expect(() => assertNoLeak('{"ok":true}', [CONTACT_B1])).not.toThrow();
  });
});
