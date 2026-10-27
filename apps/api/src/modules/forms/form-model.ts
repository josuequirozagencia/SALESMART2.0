import type { ErrorDetail } from '../../errors';
import { toE164 } from '../contacts';

/**
 * Modelo PURO de los formularios (M9.1, ADR-09/54): estructura válida de un formulario, validación de un envío contra sus campos y comprobación del dominio de origen. Sin base de datos ni red:
 * el servidor lo usa para validar lo que el constructor guarda y lo que manda un visitante (la interfaz es solo ayuda).
 */
export const FIELD_KINDS = ['text', 'long_text', 'email', 'phone', 'number', 'select'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const MAX_FIELDS = 30;
export const MAX_OPTIONS = 30;
export const MAX_DOMAINS = 20;

/** Un campo tal como lo guarda el constructor. */
export interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly label: string;
  /** `name`, `phone`, `email`, `note` o `custom:<variable>`. */
  readonly mapsTo: string;
  readonly required: boolean;
  readonly options: readonly string[] | null;
  readonly placeholder: string | null;
}

const issue = (path: string, code: string, message: string): ErrorDetail => ({ path, code, message });
const CONTROL = /\p{Cc}/gu;

/** Una línea de texto del visitante: sin caracteres de control, en un renglón y acotada. */
export const oneLine = (v: string, max: number): string => v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Texto largo: conserva los saltos de línea, quita los demás caracteres de control. */
const multiLine = (v: string, max: number): string => v.replace(/[^\S\n]+/g, ' ').replace(/\r/g, '').replace(CONTROL, (c) => (c === '\n' ? c : ' ')).trim().slice(0, max);

/** La variable de un campo que va a un campo personalizado del contacto, o null si no es de ese tipo. */
export const customKeyOf = (mapsTo: string): string | null => (mapsTo.startsWith('custom:') ? mapsTo.slice('custom:'.length) : null);

/** El nombre estable de un campo a partir de su etiqueta («Correo electrónico» → `correo_electronico`), único dentro del formulario. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[0-9_]+/, '')
      .slice(0, 30) || 'campo';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 36)}_${i}`;
  return key;
}

/**
 * ¿Es válida la estructura de este formulario? Reglas: entre 1 y 30 campos; claves únicas y bien formadas; exactamente UN campo `name` y UNO `phone` y ambos obligatorios (un lead sin nombre o
 * sin WhatsApp no se puede atender); a lo sumo un `email`; cada destino (`maps_to`) es coherente con el tipo (el teléfono es de tipo teléfono, el correo de tipo correo); los de selección traen
 * opciones y los demás no; un mismo campo personalizado no se llena desde dos campos.
 */
export function validateStructure(fields: readonly FieldSpec[]): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  if (fields.length < 1 || fields.length > MAX_FIELDS) out.push(issue('fields', 'invalid_count', `El formulario debe tener entre 1 y ${MAX_FIELDS} campos`));
  const keys = new Set<string>();
  const targets = new Map<string, number>();
  fields.forEach((f, i) => {
    const at = `fields.${i}`;
    if (keys.has(f.key)) out.push(issue(`${at}.key`, 'duplicate', 'Hay dos campos con la misma clave'));
    keys.add(f.key);
    if (f.mapsTo !== 'note') targets.set(f.mapsTo, (targets.get(f.mapsTo) ?? 0) + 1);
    if (f.mapsTo === 'phone' && f.kind !== 'phone') out.push(issue(`${at}.kind`, 'kind_mismatch', 'El campo del teléfono debe ser de tipo teléfono'));
    if (f.mapsTo === 'email' && f.kind !== 'email') out.push(issue(`${at}.kind`, 'kind_mismatch', 'El campo del correo debe ser de tipo correo'));
    if (f.mapsTo === 'name' && f.kind !== 'text') out.push(issue(`${at}.kind`, 'kind_mismatch', 'El campo del nombre debe ser de texto corto'));
    if (f.kind === 'phone' && f.mapsTo !== 'phone') out.push(issue(`${at}.maps_to`, 'kind_mismatch', 'Un campo de teléfono solo puede guardarse como el teléfono del contacto'));
    if (f.kind === 'select' && (f.options === null || f.options.length < 1 || f.options.length > MAX_OPTIONS)) out.push(issue(`${at}.options`, 'invalid_options', `Un campo de selección necesita entre 1 y ${MAX_OPTIONS} opciones`));
    if (f.kind === 'select' && f.options && new Set(f.options.map((o) => o.toLowerCase())).size !== f.options.length) out.push(issue(`${at}.options`, 'duplicate', 'Las opciones no se pueden repetir'));
    if (f.kind !== 'select' && f.options !== null) out.push(issue(`${at}.options`, 'invalid_options', 'Solo los campos de selección llevan opciones'));
    if ((f.mapsTo === 'name' || f.mapsTo === 'phone') && !f.required) out.push(issue(`${at}.required`, 'required_field', 'El nombre y el teléfono son obligatorios'));
  });
  for (const t of ['name', 'phone']) if ((targets.get(t) ?? 0) !== 1) out.push(issue('fields', `needs_${t}`, t === 'name' ? 'Falta el campo del nombre (o hay más de uno)' : 'Falta el campo del teléfono (o hay más de uno)'));
  if ((targets.get('email') ?? 0) > 1) out.push(issue('fields', 'duplicate_email', 'Solo puede haber un campo de correo'));
  for (const [t, n] of targets) if (t.startsWith('custom:') && n > 1) out.push(issue('fields', 'duplicate_target', `Dos campos llenan el mismo campo personalizado (${t.slice(7)})`));
  return out;
}

/** Lo que se saca de un envío válido, ya normalizado. */
export interface Submission {
  /** Valores limpios por clave de campo (lo que se guarda en el envío). */
  readonly clean: Record<string, string | number>;
  readonly name: string;
  /** Teléfono en E.164. */
  readonly phone: string;
  readonly email: string | null;
  /** Valores para los campos personalizados del contacto, por variable. */
  readonly custom: Record<string, string | number>;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Valida los valores que mandó el visitante contra los campos del formulario. Devuelve los errores por clave de campo (`values.<clave>`), o el envío ya normalizado. Los obligatorios deben traer
 * valor; los opcionales vacíos se omiten; lo que no es un campo del formulario se ignora. El teléfono sin código de país usa `phonePrefix` del formulario.
 */
export function validateSubmission(fields: readonly FieldSpec[], values: Readonly<Record<string, unknown>>, phonePrefix: string): { ok: true; submission: Submission } | { ok: false; errors: ErrorDetail[] } {
  const errors: ErrorDetail[] = [];
  const clean: Record<string, string | number> = {};
  const custom: Record<string, string | number> = {};
  let name = '';
  let phone = '';
  let email: string | null = null;
  for (const f of fields) {
    const path = `values.${f.key}`;
    const raw = values[f.key];
    const text = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
    if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      errors.push(issue(path, 'invalid', `${f.label}: el valor no es válido`));
      continue;
    }
    if (text.trim() === '') {
      if (f.required) errors.push(issue(path, 'required', `${f.label} es obligatorio`));
      continue;
    }
    let value: string | number;
    switch (f.kind) {
      case 'text': {
        value = oneLine(text, 200);
        break;
      }
      case 'long_text': {
        value = multiLine(text, 2000);
        break;
      }
      case 'email': {
        const e = oneLine(text, 254).toLowerCase();
        if (!EMAIL.test(e)) {
          errors.push(issue(path, 'invalid_email', `${f.label}: escribe un correo válido`));
          continue;
        }
        value = e;
        break;
      }
      case 'phone': {
        const e164 = toE164(text, phonePrefix);
        if (!e164) {
          errors.push(issue(path, 'invalid_phone', `${f.label}: escribe un teléfono válido (con código de país si no es de ${phonePrefix})`));
          continue;
        }
        value = e164;
        break;
      }
      case 'number': {
        const n = Number(text.replace(',', '.'));
        if (!Number.isFinite(n) || Math.abs(n) > 1e12) {
          errors.push(issue(path, 'invalid_number', `${f.label}: escribe un número`));
          continue;
        }
        value = n;
        break;
      }
      case 'select': {
        const s = oneLine(text, 200);
        const match = f.options?.find((o) => o === s) ?? f.options?.find((o) => o.toLowerCase() === s.toLowerCase());
        if (!match) {
          errors.push(issue(path, 'invalid_option', `${f.label}: elige una de las opciones`));
          continue;
        }
        value = match;
        break;
      }
    }
    if (typeof value === 'string' && value === '') {
      if (f.required) errors.push(issue(path, 'required', `${f.label} es obligatorio`));
      continue;
    }
    clean[f.key] = value;
    if (f.mapsTo === 'name') name = String(value);
    else if (f.mapsTo === 'phone') phone = String(value);
    else if (f.mapsTo === 'email') email = String(value);
    else {
      const k = customKeyOf(f.mapsTo);
      if (k) custom[k] = value;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, submission: { clean, name, phone, email, custom } };
}

// ---------------------------------------------------------------------------------------------- dominios

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;

/** Un dominio escrito por la persona («https://www.Mi-Sitio.com/pagina» → `www.mi-sitio.com`); null si no es un dominio válido. `*.` al inicio permite sus subdominios. */
export function normalizeDomain(input: string): string | null {
  const t = input.trim().toLowerCase();
  if (t === '') return null;
  const wild = t.startsWith('*.');
  let host = wild ? t.slice(2) : t;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0] ?? '';
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  const full = wild ? `*.${host}` : host;
  return HOST.test(full) ? full : null;
}

/** Dominios normalizados, sin repetir y sin los que no valen. */
export function normalizeDomains(input: readonly string[]): { ok: string[]; bad: string[] } {
  const ok = new Set<string>();
  const bad: string[] = [];
  for (const d of input) {
    const n = normalizeDomain(d);
    if (n) ok.add(n);
    else bad.push(d.slice(0, 80));
  }
  return { ok: [...ok], bad };
}

/** El dominio (sin puerto) de un `Origin`; null si no es un origen http(s) válido. */
export function hostOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** ¿El `Origin` es uno de los dominios autorizados? Coincide el dominio exacto; con `*.` también sus subdominios (no el dominio base). */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  const host = hostOfOrigin(origin);
  if (!host) return false;
  return allowed.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d));
}
