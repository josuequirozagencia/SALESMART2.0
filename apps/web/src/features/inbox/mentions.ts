import type { MentionOption } from '../../lib/types';

/** Cuántas sugerencias se muestran a la vez. */
export const MAX_MENTION_SUGGESTIONS = 6;

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** La palabra que se está escribiendo tras una «@» justo antes del cursor, con dónde empieza la «@»; null si no hay. La «@» debe abrir el texto o ir tras un espacio (un correo no la dispara). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1]!.length, query: m[2]! } : null;
}

/** Las personas que encajan con lo escrito (sin tildes ni mayúsculas): por el principio del nombre o de cualquiera de sus palabras. Conserva el orden del servidor (las que ya ven la conversación primero). */
export function suggestMentions(items: readonly MentionOption[], query: string): MentionOption[] {
  const q = norm(query);
  const hit = (o: MentionOption): boolean => q === '' || norm(o.name).split(/\s+/).some((w) => w.startsWith(q));
  return items.filter(hit).slice(0, MAX_MENTION_SUGGESTIONS);
}

export interface Picked {
  id: string;
  name: string;
}

/** De lo elegido, solo lo que sigue en el texto como «@Nombre» (si la persona borró la mención, ya no se avisa). */
export function mentionIdsIn(text: string, picked: readonly Picked[]): string[] {
  return [...new Set(picked.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id))];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parte el texto de una nota en trozos, marcando los «@Nombre» de las personas mencionadas (las más largas primero, para que «Ana María» gane a «Ana»). */
export function splitMentions(text: string, mentions: ReadonlyArray<{ name: string }>): Array<{ text: string; mention: boolean }> {
  const names = [...new Set(mentions.map((m) => m.name))].filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text, mention: false }];
  const re = new RegExp(`(@(?:${names.map(escapeRe).join('|')}))`, 'g');
  return text
    .split(re)
    .filter((t) => t !== '')
    .map((t) => ({ text: t, mention: t.startsWith('@') && names.some((n) => t === `@${n}`) }));
}
