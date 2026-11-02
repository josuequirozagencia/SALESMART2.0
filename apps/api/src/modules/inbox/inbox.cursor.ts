import { ValidationError } from '../../errors';

export const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor de las listas del Inbox: la hora de orden con microsegundos (un `Date` de JavaScript solo llega a milisegundos) y el id para desempatar. */
export interface Cursor {
  k: string;
  id: string;
}

export const encode = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decode(raw: string): Cursor {
  let c: Partial<Cursor>;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch {
    c = {};
  }
  if (typeof c.k !== 'string' || !KEY_RE.test(c.k) || typeof c.id !== 'string' || !UUID_RE.test(c.id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  return { k: c.k, id: c.id };
}
