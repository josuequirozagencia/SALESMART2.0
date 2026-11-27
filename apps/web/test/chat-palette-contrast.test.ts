import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// V23-B — La paleta del hilo (estilo WhatsApp) debe cumplir contraste: texto y hora 4,5:1, ticks 3:1 (gráfico), en claro y en oscuro. Se leen los valores del CSS real.
const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8');
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

function vars(selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error('no se encontró el bloque del hilo');
  return Object.fromEntries([...m[1]!.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1]!, x[2]!]));
}
const light = vars(/\.chat-thread \{([^}]*)\}/);
const dark = vars(/:root\[data-theme="dark"\] \.chat-thread \{([^}]*)\}/);

describe.each([['claro', light], ['oscuro', dark]] as const)('hilo %s', (_n, v) => {
  it.each([['bubble-out'], ['bubble-in']])('texto y hora legibles sobre %s (4,5:1)', (bg) => {
    expect(ratio(v['bubble-text']!, v[bg]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v['bubble-time']!, v[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
  it('el check gris pasa 4,5:1 y el azul de «leído» 3:1 sobre la burbuja que se ve', () => {
    expect(ratio(v['tick-grey']!, v['bubble-out']!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(v['tick-read']!, v['bubble-out']!)).toBeGreaterThanOrEqual(3);
  });
});
