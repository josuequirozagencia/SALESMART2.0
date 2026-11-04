/** Luminancia relativa (WCAG) de un color `#rrggbb` o `#rgb`; `null` si no es un color válido. */
export function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1] ?? '';
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

/**
 * Color de texto legible sobre un fondo elegido por la persona (las etiquetas llevan el color que se les pone): oscuro o blanco, el que dé más contraste.
 * Un color no válido se trata como oscuro (texto blanco).
 */
export function inkFor(background: string): '#ffffff' | '#14153a' {
  const l = luminance(background);
  if (l === null) return '#ffffff';
  const withWhite = 1.05 / (l + 0.05);
  const withDark = (l + 0.05) / (0.0099 + 0.05);
  return withDark > withWhite ? '#14153a' : '#ffffff';
}
