import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@sales-smart/shared';

/**
 * Tokens OPACOS `<sessionId>.<secreto>` (ADR-26). El secreto son 32 bytes aleatorios; en BD solo existe su SHA-256
 * (alta entropía → no necesita sal ni KDF lento). El id de sesión permite buscar por clave primaria.
 */
export interface ParsedToken {
  sessionId: string;
  hash: string;
}

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function newToken(sessionId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${sessionId}.${secret}`, hash: hashSecret(secret) };
}

export function parseToken(raw: string | undefined | null): ParsedToken | null {
  if (!raw || raw.length > 200) return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const sessionId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!isUuid(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { sessionId, hash: hashSecret(secret) };
}

/** Comparación de hashes hex en tiempo constante. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
