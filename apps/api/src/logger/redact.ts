/**
 * Redacción de PII y secretos para logs. Estrategia de defensa en profundidad:
 *  1. por NOMBRE de clave (password, token, email, phone, body...) → se reemplaza el valor entero;
 *  2. por PATRÓN en cadenas (email, JWT, Bearer, credenciales en URL, parámetros secretos, tarjeta con Luhn, teléfono);
 *  3. Error: lista blanca de propiedades; se elimina el bloque "params:" que Drizzle añade al mensaje.
 * Es un mecanismo de mejor esfuerzo: la regla principal sigue siendo NO registrar contenido de clientes.
 */
export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_STRING = 2000;
const MAX_KEYS = 100;
const MAX_ITEMS = 100;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Claves cuyo valor es secreto (se redactan salvo que el valor sea numérico/booleano: p. ej. `tokensUsed`). */
const SECRET_KEY_PARTS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'cookie', 'apikey', 'credential',
  'privatekey', 'cvv', 'cardnumber', 'signature', 'sessionid',
];
/** Claves de PII/contenido de cliente: se redactan siempre, sea cual sea el tipo. */
const PII_KEY_PARTS = [
  'email', 'phone', 'mobile', 'telefono', 'celular', 'whatsapp', 'address', 'direccion', 'cedula', 'dni',
  'ssn', 'iban', 'messagebody', 'body', 'transcript', 'fullname', 'firstname', 'lastname', 'nombre', 'apellido',
  'content', 'text',
];
/** Claves que contienen una subcadena sensible pero no lo son. */
const SAFE_KEYS = new Set(['tokensused', 'tokencount', 'tokenlimit', 'texttype', 'contenttype', 'contentlength', 'emailid', 'bodysize', 'bodylength', 'phoneid', 'phonenumberid']);

export function isSensitiveKey(key: string): 'secret' | 'pii' | null {
  const k = norm(key);
  if (SAFE_KEYS.has(k)) return null;
  if (SECRET_KEY_PARTS.some((p) => k.includes(p))) return 'secret';
  if (PII_KEY_PARTS.some((p) => k.includes(p))) return 'pii';
  return null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const SECRET_PARAM = /([?&;\s](?:access_token|refresh_token|token|api[_-]?key|key|secret|password|pwd|signature|sig|code)=)[^&\s"']+/gi;
const PG_PARAMS_BLOCK = /\r?\nparams:[\s\S]*$/;
// Candidatos: UUID | fecha/hora ISO (se conservan) | secuencia numérica larga (tarjeta/teléfono).
const NUMERIC_OR_PROTECTED =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\+?\d(?:[\d\s().-]{6,}\d)/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function scrubNumeric(m: string): string {
  if (/^[0-9a-f]{8}-/i.test(m) && m.length === 36) return m; // UUID
  if (/^\d{4}-\d{2}-\d{2}/.test(m)) return m; // fecha
  const digits = m.replace(/\D/g, '');
  if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return REDACTED;
  if (digits.length >= 9 && digits.length <= 15) return REDACTED; // teléfono
  return m;
}

export function redactString(input: string): string {
  let s = input.length > MAX_STRING ? `${input.slice(0, MAX_STRING)}…[truncated]` : input;
  s = s.replace(URL_CREDS, `$1${REDACTED}@`);
  s = s.replace(BEARER, `$1 ${REDACTED}`);
  s = s.replace(JWT, REDACTED);
  s = s.replace(SECRET_PARAM, `$1${REDACTED}`);
  s = s.replace(EMAIL, REDACTED);
  s = s.replace(NUMERIC_OR_PROTECTED, scrubNumeric);
  return s;
}

function redactError(e: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.name, message: redactString(e.message.replace(PG_PARAMS_BLOCK, '\nparams: [omitted]')) };
  if (e.stack) out['stack'] = redactString(e.stack.replace(PG_PARAMS_BLOCK, '\nparams: [omitted]'));
  const rec = e as unknown as Record<string, unknown>;
  // Lista blanca: NUNCA copiamos `params`, `query` ni propiedades arbitrarias (Drizzle/pg pueden llevar valores).
  for (const k of ['code', 'severity', 'constraint', 'table', 'column', 'schema', 'routine', 'status', 'statusCode']) {
    const v = rec[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = typeof v === 'string' ? redactString(v) : v;
  }
  if (typeof rec['detail'] === 'string') out['detail'] = redactString(rec['detail']);
  if (rec['cause'] !== undefined && depth < MAX_DEPTH) out['cause'] = walk(rec['cause'], depth + 1, seen);
  return out;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string': return redactString(value);
    case 'number': case 'boolean': return value;
    case 'bigint': return value.toString();
    case 'symbol': case 'function': return undefined;
    default: break;
  }
  const obj = value;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated depth]';
  seen.add(obj);
  try {
    if (obj instanceof Error) return redactError(obj, depth, seen);
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (Buffer.isBuffer(obj)) return `[Buffer ${obj.length}b]`;
    if (Array.isArray(obj)) return obj.slice(0, MAX_ITEMS).map((v) => walk(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (++n > MAX_KEYS) { out['…'] = 'truncated'; break; }
      const kind = isSensitiveKey(k);
      if (kind === 'pii' && v !== null && v !== undefined) out[k] = REDACTED;
      else if (kind === 'secret' && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean') out[k] = REDACTED;
      else out[k] = walk(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj); // solo detecta ciclos reales (ancestros), no referencias repetidas
  }
}

/** Copia profunda segura de `value` con PII/secretos redactados. Nunca lanza. */
export function redactPii<T = unknown>(value: T): T {
  try {
    return walk(value, 0, new WeakSet()) as T;
  } catch {
    return REDACTED as unknown as T;
  }
}
