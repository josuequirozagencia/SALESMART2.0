import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../src/features/inbox/MessageBubble';
import { mapLink, mapTiles, TILE_SIZE, validPlace, worldPixel } from '../src/lib/osm';
import type { ChatMessage } from '../src/lib/types';

// v13 S3.2 — Ubicación como en WhatsApp: mapa con pin, nombre y dirección, enlace y respaldo si el mapa falla.
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'location', text: null, media: null, extra: { location: { latitude: -2.17, longitude: -79.92, name: 'Oficina', address: 'Av. 9 de Octubre' } },
  reaction: null, my_reaction: null, status: 'received', error: null, sent_at: '2026-11-13T12:00:00.000Z', delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over,
});
const show = (m: ChatMessage) => render(<ul><MessageBubble m={m} canRetry={false} retrying={false} onRetry={() => undefined} /></ul>);

describe('osm: proyección y baldosas', () => {
  it('validPlace exige números finitos en rango', () => {
    expect(validPlace({ latitude: -2.17, longitude: -79.92 })).toBe(true);
    for (const v of [null, 5, {}, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: '1', longitude: 2 }, { latitude: Number.NaN, longitude: 0 }]) expect(validPlace(v)).toBe(false);
  });

  it('el centro del mundo cae en el píxel central y la longitud 180 en el borde', () => {
    const c = worldPixel({ latitude: 0, longitude: 0 }, 2);
    expect(c.x).toBeCloseTo(2 * TILE_SIZE, 5); // a zoom 2 el mundo mide 4 baldosas: su centro está en la 2
    expect(c.y).toBeCloseTo(2 * TILE_SIZE, 5);
    expect(worldPixel({ latitude: 0, longitude: 180 }, 2).x).toBeCloseTo(4 * TILE_SIZE, 5);
  });

  it('una baldosa conocida: Quito (−0.18, −78.47) a zoom 10 es la 288/512', () => {
    const t = mapTiles({ latitude: -0.18, longitude: -78.47 }, 10, 1, 1);
    expect(t).toHaveLength(1);
    expect(t[0]!.url).toBe('https://tile.openstreetmap.org/10/288/512.png');
  });

  it('un recuadro de 260 × 150 necesita pocas baldosas (como mucho 4), centra el punto y las posiciona dentro del recuadro', () => {
    const p = { latitude: -2.17, longitude: -79.92 };
    const tiles = mapTiles(p, 16, 260, 150);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
    // el punto, en coordenadas del recuadro, debe quedar en el centro (130, 75): la baldosa que lo contiene lo muestra ahí
    const c = worldPixel(p, 16);
    const hit = tiles.find((t) => {
      const [x, y] = new URL(t.url).pathname.replace('.png', '').split('/').slice(2).map(Number) as [number, number];
      return Math.floor(c.x / TILE_SIZE) === x && Math.floor(c.y / TILE_SIZE) === y;
    })!;
    expect(hit).toBeDefined();
    expect(hit.left + (c.x % TILE_SIZE)).toBeCloseTo(130, 0);
    expect(hit.top + (c.y % TILE_SIZE)).toBeCloseTo(75, 0);
    // todas las baldosas son del servidor de OSM (el único origen que permite la política de contenido)
    for (const t of tiles) expect(t.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/);
  });

  it('cerca de los polos y del antimeridiano no pide baldosas imposibles', () => {
    for (const p of [{ latitude: 89, longitude: 0 }, { latitude: -89.9, longitude: 179.99 }, { latitude: 0, longitude: -180 }]) {
      const tiles = mapTiles(p, 16, 260, 150);
      const n = 2 ** 16;
      for (const t of tiles) {
        const [x, y] = t.url.replace('.png', '').split('/').slice(-2).map(Number) as [number, number];
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(n);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(n);
      }
    }
  });

  it('el enlace abre OpenStreetMap en ese punto', () => {
    expect(mapLink({ latitude: -2.17, longitude: -79.92 })).toBe('https://www.openstreetmap.org/?mlat=-2.17&mlon=-79.92#map=16/-2.17/-79.92');
  });
});

describe('burbuja de ubicación', () => {
  it('muestra el mapa con su pin, el nombre y la dirección, la atribución y un enlace que abre el mapa en otra pestaña', () => {
    const { container } = show(msg());
    const link = screen.getByRole('link', { name: /^Abrir la ubicación en el mapa: Oficina · Av\. 9 de Octubre$/ });
    expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/?mlat=-2.17&mlon=-79.92#map=16/-2.17/-79.92');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const i of Array.from(imgs)) {
      expect(i.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\//);
      expect(i.getAttribute('referrerpolicy')).toBe('origin');
      expect(i).toHaveAttribute('alt', '');
    }
    expect(screen.getByText('Oficina · Av. 9 de Octubre')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '© colaboradores de OpenStreetMap' })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    expect(screen.queryByText('Ubicación')).not.toBeInTheDocument(); // el rótulo sobra: el mapa lo dice todo
  });

  it('si una baldosa no carga, se muestra una tarjeta neutra con el pin y el enlace sigue sirviendo', () => {
    const { container } = show(msg());
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const link = screen.getByRole('link', { name: /Abrir la ubicación en el mapa/ });
    expect(within(link).getByText('Ver en el mapa')).toBeInTheDocument();
    expect(screen.getByText('Oficina · Av. 9 de Octubre')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '© colaboradores de OpenStreetMap' })).not.toBeInTheDocument(); // sin mapa, sin atribución
  });

  it('sin nombre ni dirección: solo el mapa; sin coordenadas válidas: el rótulo «Ubicación» y ningún mapa', () => {
    const only = show(msg({ extra: { location: { latitude: 0, longitude: 0, name: null, address: null } } }));
    expect(screen.getByRole('link', { name: 'Abrir la ubicación en el mapa' })).toBeInTheDocument();
    only.unmount();
    for (const extra of [null, {}, { location: { latitude: 200, longitude: 0 } }, { location: 'x' }]) {
      const v = show(msg({ extra }));
      expect(screen.getByText('Ubicación')).toBeInTheDocument();
      expect(v.container.querySelectorAll('img')).toHaveLength(0);
      expect(screen.queryByRole('link', { name: /Abrir la ubicación/ })).not.toBeInTheDocument();
      v.unmount();
    }
  });

  it('una reacción del cliente sobre la ubicación sigue mostrándose', () => {
    show(msg({ reaction: '👍' }));
    expect(screen.getByRole('img', { name: 'Reacción del cliente: 👍' })).toBeInTheDocument();
  });
});
