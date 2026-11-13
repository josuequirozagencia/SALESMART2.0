import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// v13 S3.1 — La burbuja de lo que escribe una persona usa `var(--grad)` con `var(--on-grad)`: el texto debe cumplir AA (4,5:1) contra AMBOS extremos del degradado, en cada tema (claro y oscuro).
const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8');

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const themes = [...css.matchAll(/--grad:\s*linear-gradient\(135deg,\s*(#[0-9a-fA-F]{6})\s+0%,\s*(#[0-9a-fA-F]{6})\s+100%\);\s*--on-grad:\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => ({ from: m[1]!, to: m[2]!, on: m[3]!.length === 4 ? `#${m[3]![1]}${m[3]![1]}${m[3]![2]}${m[3]![2]}${m[3]![3]}${m[3]![3]}` : m[3]! }));

describe('contraste de la burbuja con el color del tema', () => {
  it('se encontraron los temas (índigo, verde, rojo, WhatsApp claro y oscuro, y el oscuro por sistema)', () => {
    expect(themes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(themes.map((t) => [`${t.from}→${t.to} con ${t.on}`, t] as const))('%s: texto AA en los dos extremos del degradado', (_n, t) => {
    expect(ratio(t.on, t.from)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t.on, t.to)).toBeGreaterThanOrEqual(4.5);
  });
});
