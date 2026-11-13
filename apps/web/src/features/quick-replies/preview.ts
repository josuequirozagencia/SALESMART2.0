/**
 * Vista previa de una respuesta rápida (v13 S6, como el «Vista previa con Juan Pérez» del prototipo): el texto con cada variable reemplazada por un valor de ejemplo y marcado en color, y lo
 * que no se puede resolver señalado (los campos personalizados dependen de cada contacto). Es solo ayuda al escribir: lo que se envía lo resuelve el servidor con los datos reales.
 */
export type PreviewPart = { kind: 'text'; text: string } | { kind: 'value'; text: string; key: string } | { kind: 'missing'; text: string; key: string };

const VARIABLE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Cómo se llama el contacto de ejemplo en la vista previa. */
export const SAMPLE_CONTACT = 'Juan Pérez';

/** Valores de ejemplo de las variables de la casa; las que no están aquí (los campos personalizados) quedan «sin resolver». */
export function sampleValues(me: { firstName: string; organization: string }): Record<string, string> {
  return { primer_nombre: 'Juan', nombre: SAMPLE_CONTACT, telefono: '+593 99 123 4567', mi_nombre: me.firstName, empresa: me.organization };
}

/** Parte el texto en trozos: texto normal, variable resuelta con su valor y variable sin resolver (se deja tal cual, para marcarla). */
export function previewParts(body: string, values: Readonly<Record<string, string>>): PreviewPart[] {
  const out: PreviewPart[] = [];
  let at = 0;
  for (const m of body.matchAll(VARIABLE)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ kind: 'text', text: body.slice(at, start) });
    const key = m[1]!;
    const value = values[key];
    out.push(value !== undefined && value !== '' ? { kind: 'value', text: value, key } : { kind: 'missing', text: m[0], key });
    at = start + m[0].length;
  }
  if (at < body.length) out.push({ kind: 'text', text: body.slice(at) });
  return out;
}

/** Las variables de un texto, para resaltarlas en la lista (sin valores): texto normal y `{{variable}}`. */
export function splitVariables(body: string): Array<{ variable: boolean; text: string }> {
  const out: Array<{ variable: boolean; text: string }> = [];
  let at = 0;
  for (const m of body.matchAll(VARIABLE)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ variable: false, text: body.slice(at, start) });
    out.push({ variable: true, text: m[0] });
    at = start + m[0].length;
  }
  if (at < body.length) out.push({ variable: false, text: body.slice(at) });
  return out;
}
