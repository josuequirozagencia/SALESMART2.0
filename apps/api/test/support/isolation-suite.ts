// Generador de pruebas A↔B por endpoint (ADR-24 / Build Spec §4.3). Los módulos reales lo reutilizan declarando
// sus endpoints de tenant; el registro (endpoint-registry.ts) exige que cada uno tenga su suite.
import { describe, expect, it } from 'vitest';

export interface Actor { headers: Record<string, string> }
export interface ForeignResources {
  /** Cadenas que NUNCA deben aparecer en una respuesta a A: ids, nombres y la organización de B. */
  markers: string[];
}
export interface EndpointCase {
  route: string; // 'GET /contacts/:id'
  /** Petición que A hace apuntando a recursos de B. */
  request: (foreign: { id: string; name: string }) => { method: string; path: string; body?: unknown };
  /** Resultado esperado para A frente a recursos ajenos. */
  expect: 'not-found' | 'no-leak';
}
export interface IsolationSuiteInput {
  title: string;
  base: () => string;
  actorA: Actor;
  actorB: Actor;
  foreign: { id: string; name: string; orgId: string };
  cases: EndpointCase[];
  /** Verifica que los datos de B siguen intactos tras los intentos de A. */
  verifyBIntact: () => Promise<void>;
}

/** Invariante central: ninguna respuesta a A puede contener identificadores/datos de B. */
export function assertNoLeak(text: string, markers: string[]): void {
  for (const m of markers) expect(text, `fuga de "${m}"`).not.toContain(m);
}

export async function call(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

export function describeTenantEndpointIsolation(s: IsolationSuiteInput): void {
  const markers = () => [s.foreign.id, s.foreign.name, s.foreign.orgId];
  describe(`A↔B por endpoint — ${s.title}`, () => {
    for (const c of s.cases) {
      it(`${c.route}: A no obtiene ni modifica datos de B (${c.expect})`, async () => {
        const r = c.request(s.foreign);
        const res = await call(s.base(), r.method, r.path, s.actorA.headers, r.body);
        assertNoLeak(res.text, markers());
        if (c.expect === 'not-found') expect(res.status).toBe(404);
        else expect(res.status).toBeLessThan(500);
        await s.verifyBIntact();
      });
      it(`${c.route}: sin credenciales → 401`, async () => {
        const r = c.request(s.foreign);
        const res = await call(s.base(), r.method, r.path, {}, r.body);
        expect(res.status).toBe(401);
        expect(JSON.parse(res.text).error.code).toBe('UNAUTHORIZED');
      });
    }
  });
}
