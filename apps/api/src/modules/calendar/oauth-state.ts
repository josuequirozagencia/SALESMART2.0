import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CalendarMode } from './calendar.ports';

/**
 * El `state` del flujo OAuth de Google (ADR-67): firmado con HMAC, sin tablas. Lleva la empresa, la persona, el modo, un nonce y el vencimiento (10 min). Quien lo recibe en el callback público lo
 * valida ANTES de hacer nada. El verificador PKCE no viaja: se DERIVA del nonce con una clave secreta del servidor (quien viera la dirección de retorno no podría reconstruirlo). Las claves se derivan
 * con HKDF de la clave maestra de credenciales con etiquetas distintas (claves separadas, Build Spec §11.2).
 */
export const STATE_TTL_MS = 10 * 60_000;

export interface StatePayload {
  /** empresa */
  o: string;
  /** persona que inició */
  u: string;
  m: CalendarMode;
  /** nonce (base64url) */
  n: string;
  /** vencimiento (ms desde 1970) */
  e: number;
}

const b64 = (b: Buffer): string => b.toString('base64url');

/** Subclave de 32 bytes para un uso concreto. */
export function deriveKey(masterBase64: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterBase64, 'base64'), Buffer.alloc(0), Buffer.from(label), 32));
}

export function newNonce(): string {
  return b64(randomBytes(18));
}

export function signState(key: Buffer, p: StatePayload): string {
  const body = b64(Buffer.from(JSON.stringify(p)));
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** El contenido si la firma es válida, no venció y tiene la forma esperada; si no, `null` (sin distinguir por qué). */
export function verifyState(key: Buffer, token: string, now = Date.now()): StatePayload | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<StatePayload>;
    if (typeof p.o !== 'string' || !UUID.test(p.o) || typeof p.u !== 'string' || !UUID.test(p.u)) return null;
    if (p.m !== 'own' && p.m !== 'existing') return null;
    if (typeof p.n !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(p.n)) return null;
    if (typeof p.e !== 'number' || !Number.isFinite(p.e) || p.e <= now) return null;
    return { o: p.o, u: p.u, m: p.m, n: p.n, e: p.e };
  } catch {
    return null;
  }
}

/** El verificador PKCE de este `state` (43 caracteres base64url) y su desafío `S256`. */
export function pkceFor(key: Buffer, nonce: string): { verifier: string; challenge: string } {
  const verifier = b64(createHmac('sha256', key).update(nonce).digest());
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}

/** «j***@gmail.com»: reconocible para quien conectó, inútil para otros. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
