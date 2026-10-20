import type { NormalizedTemplate, TemplateButton, TemplateButtonType, TemplateCategory, TemplateHeaderFormat, TemplateStatus } from './whatsapp.port';

/** Nombre de una plantilla en Meta: minúsculas, dígitos y guion bajo. */
const NAME_RE = /^[a-z0-9_]{1,512}$/;
/** Idioma: `es`, `es_MX`, `pt_BR`… */
const LANG_RE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;
const MAX_TEXT = 2000;

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);

const STATUS: Readonly<Record<string, TemplateStatus>> = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled' };
const CATEGORY: Readonly<Record<string, TemplateCategory>> = { MARKETING: 'marketing', UTILITY: 'utility', AUTHENTICATION: 'authentication' };
const HEADER: Readonly<Record<string, TemplateHeaderFormat>> = { TEXT: 'text', IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document', LOCATION: 'location' };
const BUTTON: Readonly<Record<string, TemplateButtonType>> = { QUICK_REPLY: 'quick_reply', PHONE_NUMBER: 'phone', URL: 'url' };

/**
 * Ejemplos que Meta exige al crear la plantilla, uno por variable. Posicionales: `body_text: [["Ana", "mañana"]]` o `header_text: ["Ana"]` (la variable `{{n}}` toma el
 * n-ésimo); con nombre: `*_named_params: [{ param_name, example }]`.
 */
function examplesOf(example: unknown, kind: 'body' | 'header'): Record<string, string> {
  const ex = obj(example);
  const out: Record<string, string> = {};
  if (!ex) return out;
  const named = ex[`${kind}_text_named_params`];
  if (Array.isArray(named)) {
    for (const p of named) {
      const o = obj(p);
      const k = str(o?.['param_name'], 100);
      const v = str(o?.['example'], 200);
      if (k && v) out[k] = v;
    }
    return out;
  }
  const positional = ex[`${kind}_text`];
  const list = kind === 'body' ? (Array.isArray(positional) && Array.isArray(positional[0]) ? (positional[0] as unknown[]) : []) : Array.isArray(positional) ? (positional as unknown[]) : [];
  list.forEach((v, i) => {
    const s = str(v, 200);
    if (s) out[String(i + 1)] = s;
  });
  return out;
}

/**
 * Traduce una plantilla tal como la devuelve la Graph API a la forma normalizada del núcleo. Una entrada sin identificador, nombre o idioma válidos se descarta
 * (`null`): no se puede enviar ni identificar. Lo que no se entiende queda anotado en `unsupported` en vez de perderse.
 */
export function normalizeMetaTemplate(raw: unknown): NormalizedTemplate | null {
  const t = obj(raw);
  if (!t) return null;
  const externalId = typeof t['id'] === 'number' ? String(t['id']) : str(t['id'], 100);
  const name = str(t['name'], 512);
  const language = str(t['language'], 20);
  if (!externalId || !name || !language || !NAME_RE.test(name) || !LANG_RE.test(language)) return null;

  let header: NormalizedTemplate['header'] = null;
  let body: NormalizedTemplate['body'] = null;
  let footer: string | null = null;
  const buttons: TemplateButton[] = [];
  const unsupported: string[] = [];
  for (const c of Array.isArray(t['components']) ? t['components'] : []) {
    const comp = obj(c);
    const type = str(comp?.['type'], 50)?.toUpperCase();
    if (!comp || !type) continue;
    if (type === 'HEADER') {
      const format = HEADER[str(comp['format'], 20)?.toUpperCase() ?? ''] ?? 'other';
      header = { format, text: format === 'text' ? str(comp['text']) : null, examples: examplesOf(comp['example'], 'header') };
    } else if (type === 'BODY') {
      body = { text: str(comp['text']) ?? '', examples: examplesOf(comp['example'], 'body') };
    } else if (type === 'FOOTER') {
      footer = str(comp['text']);
    } else if (type === 'BUTTONS') {
      for (const b of Array.isArray(comp['buttons']) ? comp['buttons'] : []) {
        const btn = obj(b);
        if (!btn) continue;
        buttons.push({ type: BUTTON[str(btn['type'], 30)?.toUpperCase() ?? ''] ?? 'other', text: str(btn['text'], 100) ?? '', url: str(btn['url'], 2000), phone: str(btn['phone_number'], 30) });
      }
    } else {
      unsupported.push(type.toLowerCase());
    }
  }
  return {
    externalId,
    name,
    language,
    category: CATEGORY[str(t['category'], 30)?.toUpperCase() ?? ''] ?? 'other',
    status: STATUS[str(t['status'], 30)?.toUpperCase() ?? ''] ?? 'other',
    parameterFormat: str(t['parameter_format'], 20)?.toUpperCase() === 'NAMED' ? 'named' : 'positional',
    header,
    body,
    footer,
    buttons,
    unsupported,
    rejectedReason: str(t['rejected_reason'], 300),
  };
}
