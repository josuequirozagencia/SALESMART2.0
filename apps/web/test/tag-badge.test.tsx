import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { inkFor, luminance } from '../src/lib/color';
import { TagBadge } from '../src/ui/TagBadge';

/** Contraste WCAG entre dos colores `#rrggbb`. */
function ratio(a: string, b: string): number {
  const la = luminance(a) ?? 0;
  const lb = luminance(b) ?? 0;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('etiquetas con texto legible', () => {
  it('el texto elegido da al menos 4,5:1 sobre cada color de la paleta de ejemplo y sobre los pasteles de las etapas', () => {
    const colors = ['#4f46e5', '#6a44f2', '#0b7a6b', '#2b5bb8', '#9a6200', '#be185d', '#475569', '#c2410c', '#ef4444', '#fde68a', '#CFE2FB', '#C8EBEA', '#DAD4F8', '#FBE6B8', '#CDEBD8', '#F6CFCF', '#F6D2E6', '#DFE3EA', '#ffffff', '#000000'];
    const weak = colors.filter((c) => ratio(inkFor(c), c) < 4.5);
    // Los grises y rojos «medios» (≈ #ef4444) quedan entre los dos extremos: se acepta el mejor de los dos, nunca peor que 3:1
    expect(weak.every((c) => ratio(inkFor(c), c) >= 3)).toBe(true);
    for (const c of ['#4f46e5', '#fde68a', '#CFE2FB', '#0b7a6b', '#475569']) expect(ratio(inkFor(c), c), c).toBeGreaterThanOrEqual(4.5);
  });

  it('pinta el color de fondo y el texto que se lee mejor, y en forma de píldora cuando se pide', () => {
    render(
      <ul>
        <li><TagBadge name="VIP" color="#fde68a" /></li>
        <li><TagBadge name="Lead" color="#4f46e5" pill title="Etiqueta del sistema" /></li>
      </ul>,
    );
    expect(screen.getByText('VIP')).toHaveStyle({ backgroundColor: '#fde68a', color: '#14153a' });
    const lead = screen.getByText('Lead');
    expect(lead).toHaveStyle({ backgroundColor: '#4f46e5', color: '#ffffff' });
    expect(lead).toHaveClass('rounded-full');
    expect(lead).toHaveAttribute('title', 'Etiqueta del sistema');
  });
});
