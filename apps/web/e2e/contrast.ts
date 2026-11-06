/**
 * Auditoría de contraste (WCAG AA) del texto visible de una página, para ejecutar DENTRO del navegador con `page.evaluate(auditContrast)` (ADR-60, Fase 7). Mide cada texto contra su
 * fondo real (mezclando las capas translúcidas hasta el color de la página) y pide 4,5:1 (3:1 para texto grande). Los fondos con degradado (barra lateral, tarjetas de marca) no se pueden
 * leer como un color y se omiten: sus valores se verificaron aparte contra los tokens del tema. Es autocontenida (no puede usar nada de fuera: se serializa al navegador).
 */
export interface LowContrast {
  text: string;
  ratio: number;
  needed: number;
  color: string;
  classes: string;
}

export function auditContrast(): { low: LowContrast[]; examined: number } {
  const lum = (r: number, g: number, b: number): number => {
    const f = (v: number): number => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c: string): [number, number, number, number] | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) {
      const p = (m[1] ?? '').split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) {
      const p = (m[1] ?? '').split(/[ /]+/).filter(Boolean).map(Number);
      return [(p[0] ?? 0) * 255, (p[1] ?? 0) * 255, (p[2] ?? 0) * 255, p[3] ?? 1];
    }
    return null;
  };
  const page = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
  const backgroundOf = (el: Element): [number, number, number] => {
    const layers: Array<[number, number, number, number]> = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 0.99) break;
      }
    }
    const last = layers[layers.length - 1];
    let base: [number, number, number] = last && last[3] >= 0.99 ? [0, 0, 0] : [page[0], page[1], page[2]];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i] as [number, number, number, number];
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    }
    return base;
  };
  const low: LowContrast[] = [];
  let examined = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || !(node.nodeValue ?? '').trim() || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) continue;
    if (el.closest('[aria-hidden="true"], option, select, script, style, [disabled]')) continue;
    let gradient = false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (getComputedStyle(e).backgroundImage !== 'none') {
        gradient = true;
        break;
      }
    }
    if (gradient) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    examined += 1;
    const bg = backgroundOf(el);
    const a = fg[3];
    const mixed: [number, number, number] = [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
    const l1 = lum(...mixed);
    const l2 = lum(...bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const needed = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < needed) low.push({ text: (node.nodeValue ?? '').trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, needed, color: cs.color, classes: String(el.className).slice(0, 60) });
  }
  return { low, examined };
}
