import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveKey, maskEmail, newNonce, pkceFor, signState, STATE_TTL_MS, verifyState, type StatePayload } from '../../src/modules/calendar/oauth-state';

const MASTER = randomBytes(32).toString('base64');
const stateKey = deriveKey(MASTER, 'gcal-oauth-state/v1');
const pkceKey = deriveKey(MASTER, 'gcal-oauth-pkce/v1');
const ORG = '0198a1b2-0000-7000-8000-000000000001';
const USER = '0198a1b2-0000-7000-8000-000000000002';
const payload = (over: Partial<StatePayload> = {}): StatePayload => ({ o: ORG, u: USER, m: 'own', n: newNonce(), e: Date.now() + STATE_TTL_MS, ...over });

describe('claves derivadas', () => {
  it('cada uso tiene su propia clave (la de la firma no sirve para el verificador PKCE) y son estables', () => {
    expect(stateKey.equals(pkceKey)).toBe(false);
    expect(deriveKey(MASTER, 'gcal-oauth-state/v1').equals(stateKey)).toBe(true);
    expect(deriveKey(randomBytes(32).toString('base64'), 'gcal-oauth-state/v1').equals(stateKey)).toBe(false);
    expect(stateKey.length).toBe(32);
  });
});

describe('state firmado', () => {
  it('ida y vuelta: devuelve lo firmado', () => {
    const p = payload({ m: 'existing' });
    expect(verifyState(stateKey, signState(stateKey, p))).toEqual(p);
  });

  it('se rechaza si se altera el contenido, la firma, o se firma con otra clave', () => {
    const t = signState(stateKey, payload());
    const [body, sig] = t.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), o: '0198a1b2-0000-7000-8000-0000000000ff' })).toString('base64url');
    expect(verifyState(stateKey, `${forged}.${sig}`)).toBeNull();
    expect(verifyState(stateKey, `${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyState(deriveKey(randomBytes(32).toString('base64'), 'gcal-oauth-state/v1'), t)).toBeNull();
    expect(verifyState(pkceKey, t)).toBeNull();
  });

  it('vence: justo después del límite ya no sirve', () => {
    const e = Date.now() + 1000;
    const t = signState(stateKey, payload({ e }));
    expect(verifyState(stateKey, t, e - 1)).not.toBeNull();
    expect(verifyState(stateKey, t, e)).toBeNull();
    expect(verifyState(stateKey, t, e + 1)).toBeNull();
  });

  it('rechaza formas inválidas sin lanzar: modo, ids, nonce, vencimiento, partes y tamaño', () => {
    for (const bad of [payload({ m: 'otro' as never }), payload({ o: 'x' }), payload({ u: '' }), payload({ n: 'corto' }), payload({ e: Number.NaN }), payload({ e: 'mañana' as never })]) {
      expect(verifyState(stateKey, signState(stateKey, bad))).toBeNull();
    }
    for (const t of ['', 'a', 'a.b.c', '.', 'x'.repeat(601), 'ñ.ñ', null as never, 42 as never]) expect(verifyState(stateKey, t)).toBeNull();
  });

  it('los nonces no se repiten', () => {
    expect(new Set(Array.from({ length: 200 }, newNonce)).size).toBe(200);
  });
});

describe('PKCE derivado', () => {
  it('es determinista por nonce, de 43 caracteres, y el desafío es el SHA-256 en base64url', () => {
    const n = newNonce();
    const a = pkceFor(pkceKey, n);
    expect(pkceFor(pkceKey, n)).toEqual(a);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).not.toBe(a.verifier);
    expect(pkceFor(pkceKey, newNonce()).verifier).not.toBe(a.verifier);
  });

  it('sin la clave del servidor no se puede reconstruir el verificador a partir del nonce que viaja en el state', () => {
    const n = newNonce();
    expect(pkceFor(deriveKey(randomBytes(32).toString('base64'), 'gcal-oauth-pkce/v1'), n).verifier).not.toBe(pkceFor(pkceKey, n).verifier);
  });
});

describe('correo enmascarado', () => {
  it('deja la inicial y el dominio; lo raro se oculta entero', () => {
    expect(maskEmail('ana.perez@example.com')).toBe('a***@example.com');
    expect(maskEmail('x@y.co')).toBe('x***@y.co');
    expect(maskEmail('@sin-usuario')).toBe('***');
    expect(maskEmail('sin-arroba')).toBe('***');
  });
});
