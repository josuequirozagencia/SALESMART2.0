import type { NormalizedTemplate, TemplateButton, TemplateSendComponent } from '../channels';

/**
 * Lo que se sabe de una plantilla sin hablar con Meta (M5.6a, ADR-50): qué variables pide, si se puede enviar desde aquí y por qué no, y cómo se arman el texto que ve la
 * persona y los datos que viajan al proveedor. Todo es función pura de la plantilla normalizada: se prueba sin base de datos ni red.
 */

export type VariablePart = 'header' | 'body' | 'button';

export interface TemplateVariable {
  /** Clave que usa la API para el valor: `header:1`, `body:nombre`, `button:0:1`. */
  id: string;
  part: VariablePart;
  /** Número (`1`) o nombre (`nombre`) tal como aparece entre llaves en el texto. */
  key: string;
  /** Posición del botón de URL al que pertenece (solo `button`). */
  buttonIndex: number | null;
  /** Ejemplo que dio quien creó la plantilla en Meta, si lo dio. */
  example: string | null;
}

export interface Analysis {
  variables: TemplateVariable[];
  sendable: boolean;
  /** Por qué no se puede enviar (estado en Meta o parte que no soportamos); null si se puede. */
  unsupportedReason: string | null;
  bodyText: string;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Las variables distintas de un texto, en el orden en que aparecen. */
export const keysIn = (text: string | null | undefined): string[] => [...new Set([...(text ?? '').matchAll(VAR_RE)].map((m) => m[1]!))];

/** Posicionales (`1`, `2`…) de menor a mayor número; con nombre, en el orden en que aparecen. */
const ordered = (keys: string[], named: boolean): string[] => (named ? keys : [...keys].sort((a, b) => Number(a) - Number(b)));

export function variablesOf(t: NormalizedTemplate): TemplateVariable[] {
  const named = t.parameterFormat === 'named';
  const out: TemplateVariable[] = [];
  if (t.header?.format === 'text') for (const key of ordered(keysIn(t.header.text), named)) out.push({ id: `header:${key}`, part: 'header', key, buttonIndex: null, example: t.header.examples[key] ?? null });
  if (t.body) for (const key of ordered(keysIn(t.body.text), named)) out.push({ id: `body:${key}`, part: 'body', key, buttonIndex: null, example: t.body.examples[key] ?? null });
  t.buttons.forEach((b, i) => {
    if (b.type === 'url') for (const key of keysIn(b.url)) out.push({ id: `button:${i}:${key}`, part: 'button', buttonIndex: i, key, example: null });
  });
  return out;
}

const STATUS_REASON: Readonly<Record<string, string>> = {
  pending: 'Meta todavía la está revisando',
  rejected: 'Meta la rechazó',
  paused: 'Meta la pausó (suele ser por baja calidad)',
  disabled: 'Meta la deshabilitó',
  other: 'No está aprobada en Meta',
};
const MEDIA_HEADER: Readonly<Record<string, string>> = { image: 'una imagen', video: 'un video', document: 'un documento', location: 'una ubicación' };

/** Si se puede enviar desde el Inbox y, si no, por qué (en palabras para la persona). */
function reasonNotSendable(t: NormalizedTemplate, variables: TemplateVariable[]): string | null {
  if (t.status !== 'approved') return `${STATUS_REASON[t.status] ?? STATUS_REASON['other']}${t.status === 'rejected' && t.rejectedReason ? `: ${t.rejectedReason}` : ''}`;
  if (t.category === 'authentication') return 'Es de autenticación (código de un solo uso): no se envía desde el Inbox';
  if (t.unsupported.length > 0) return `Tiene partes que aún no se pueden enviar desde aquí (${t.unsupported.join(', ')})`;
  if (t.header && t.header.format !== 'text') {
    const media = MEDIA_HEADER[t.header.format];
    return media ? `Lleva ${media} en el encabezado: se podrá usar cuando estén los adjuntos` : 'Tiene un encabezado que aún no se puede enviar desde aquí';
  }
  if (!t.body || t.body.text.trim() === '') return 'No tiene cuerpo de mensaje';
  if (variables.filter((v) => v.part === 'header').length > 1) return 'El encabezado tiene más de una variable';
  if (t.buttons.some((b) => b.type === 'other')) return 'Tiene un botón que no se puede enviar desde aquí';
  if (t.buttons.some((b, i) => b.type === 'url' && variables.filter((v) => v.part === 'button' && v.buttonIndex === i).length > 1)) return 'Un botón de enlace tiene más de una variable';
  return null;
}

export function analyze(t: NormalizedTemplate): Analysis {
  const variables = variablesOf(t);
  const unsupportedReason = reasonNotSendable(t, variables);
  return { variables, sendable: unsupportedReason === null, unsupportedReason, bodyText: t.body?.text ?? '' };
}

// ── Valores de las variables ───────────────────────────────────────────────

/** Largo máximo del valor según dónde va (Meta limita el encabezado a 60 caracteres y el cuerpo a 1024 en total). */
const MAX_VALUE: Readonly<Record<VariablePart, number>> = { header: 60, body: 1024, button: 500 };

/** Reglas de Meta para un parámetro de texto: no vacío, sin saltos de línea ni tabulaciones, sin más de 3 espacios seguidos y de largo acotado. */
export function checkValue(part: VariablePart, value: string): string | null {
  const v = value.trim();
  if (v === '') return 'Escribe un valor';
  if (/[\n\r\t]/.test(v)) return 'No puede tener saltos de línea ni tabulaciones';
  if (/\p{Cc}/u.test(v)) return 'Tiene caracteres no permitidos';
  if (/ {4,}/.test(v)) return 'No puede tener más de 3 espacios seguidos';
  if (v.length > MAX_VALUE[part]) return `Usa como máximo ${MAX_VALUE[part]} caracteres`;
  return null;
}

const fill = (text: string, values: ReadonlyMap<string, string>): string => text.replace(VAR_RE, (whole, key: string) => values.get(key) ?? whole);

export interface RenderedTemplate {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: Array<{ type: TemplateButton['type']; text: string; url: string | null; phone: string | null }>;
}

export interface Prepared {
  rendered: RenderedTemplate;
  /** Los datos por parte que viajan al proveedor. */
  send: TemplateSendComponent[];
}

export interface ParamError {
  /** `params.<id de la variable>`. */
  path: string;
  message: string;
}

/**
 * Valida los valores recibidos contra las variables de la plantilla (exactamente las que pide, ni más ni menos, cada una válida según las reglas de Meta) y arma el
 * texto que ve la persona y los componentes que se envían. Un valor se recorta antes de usarse.
 */
export function prepare(t: NormalizedTemplate, variables: readonly TemplateVariable[], params: Readonly<Record<string, string>>): { ok: true; value: Prepared } | { ok: false; errors: ParamError[] } {
  const errors: ParamError[] = [];
  const known = new Set(variables.map((v) => v.id));
  for (const id of Object.keys(params)) if (!known.has(id)) errors.push({ path: `params.${id}`, message: 'La plantilla no tiene esta variable' });
  for (const v of variables) {
    const raw = params[v.id];
    const problem = raw === undefined ? 'Falta este dato' : checkValue(v.part, raw);
    if (problem) errors.push({ path: `params.${v.id}`, message: problem });
  }
  if (errors.length > 0) return { ok: false, errors };

  const value = (v: TemplateVariable): string => params[v.id]!.trim();
  const of = (part: VariablePart, buttonIndex: number | null = null) => variables.filter((v) => v.part === part && v.buttonIndex === buttonIndex);
  const map = (vs: TemplateVariable[]): ReadonlyMap<string, string> => new Map(vs.map((v) => [v.key, value(v)]));
  const named = t.parameterFormat === 'named';

  const send: TemplateSendComponent[] = [];
  const header = of('header');
  if (header.length > 0) send.push({ type: 'header', subType: null, index: null, parameters: header.map((v) => ({ name: named ? v.key : null, text: value(v) })) });
  const body = of('body');
  if (body.length > 0) send.push({ type: 'body', subType: null, index: null, parameters: body.map((v) => ({ name: named ? v.key : null, text: value(v) })) });
  t.buttons.forEach((b, i) => {
    const vs = of('button', i);
    if (b.type === 'url' && vs.length > 0) send.push({ type: 'button', subType: 'url', index: i, parameters: vs.map((v) => ({ name: null, text: value(v) })) });
  });

  const rendered: RenderedTemplate = {
    header: t.header?.format === 'text' && t.header.text ? fill(t.header.text, map(header)) : null,
    body: fill(t.body?.text ?? '', map(body)),
    footer: t.footer,
    buttons: t.buttons.map((b, i) => ({ type: b.type, text: b.text, url: b.url ? fill(b.url, map(of('button', i))) : null, phone: b.phone })),
  };
  return { ok: true, value: { rendered, send } };
}

/** El texto de la plantilla ya armado, como queda en el hilo: encabezado, cuerpo y pie. */
export const renderedText = (r: RenderedTemplate): string => [r.header, r.body, r.footer].filter((p): p is string => p !== null && p !== '').join('\n\n');

// ── Fila ⇄ plantilla normalizada ─────────────────────────────────────────

/** Lo que se guarda en `message_templates.components`. */
export function componentsOf(t: NormalizedTemplate): Record<string, unknown> {
  return { header: t.header, body: t.body, footer: t.footer, buttons: t.buttons, unsupported: t.unsupported };
}

interface RowLike {
  externalId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameterFormat: string;
  components: Record<string, unknown>;
  rejectedReason: string | null;
}

export function fromRow(r: RowLike): NormalizedTemplate {
  const c = r.components as Partial<Pick<NormalizedTemplate, 'header' | 'body' | 'footer' | 'buttons' | 'unsupported'>>;
  return {
    externalId: r.externalId,
    name: r.name,
    language: r.language,
    category: r.category as NormalizedTemplate['category'],
    status: r.status as NormalizedTemplate['status'],
    parameterFormat: r.parameterFormat === 'named' ? 'named' : 'positional',
    header: c.header ?? null,
    body: c.body ?? null,
    footer: c.footer ?? null,
    buttons: c.buttons ?? [],
    unsupported: c.unsupported ?? [],
    rejectedReason: r.rejectedReason,
  };
}
