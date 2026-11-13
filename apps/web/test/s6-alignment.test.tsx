import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { previewParts, sampleValues, splitVariables } from '../src/features/quick-replies/preview';
import { PageHeader, PAGE_TITLE } from '../src/ui/PageHeader';
import type { Queue, QueueList } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// v13 · S6 — Alineación visual con el prototipo (solo presentación): encabezado común, barra lateral compacta, vista previa de las respuestas rápidas y la tarjeta «nuevo» de Departamentos.
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

describe('PageHeader', () => {
  it('es el h1 de la pantalla con su descripción debajo y las acciones a la derecha', () => {
    render(<MemoryRouter><PageHeader title="Contactos" description="Las personas con las que hablas" actions={<button type="button">Nuevo</button>} /></MemoryRouter>);
    const h = screen.getByRole('heading', { level: 1, name: 'Contactos' });
    expect(h.className).toBe(PAGE_TITLE);
    expect(h.className).toContain('text-[21px]');
    expect(screen.getByText('Las personas con las que hablas')).toHaveClass('text-muted');
    expect(screen.getByRole('button', { name: 'Nuevo' })).toBeInTheDocument();
  });

  it('sin descripción ni acciones solo pinta el título', () => {
    const { container } = render(<PageHeader title="Solo título" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('vista previa de variables (pura)', () => {
  const values = sampleValues({ firstName: 'Luis', organization: 'Barbería Norte' });
  it('reemplaza las conocidas y deja marcadas las que no se pueden resolver', () => {
    expect(previewParts('Hola {{primer_nombre}} de {{ empresa }}, soy {{mi_nombre}}. {{contact.ciudad}}', values)).toEqual([
      { kind: 'text', text: 'Hola ' }, { kind: 'value', text: 'Juan', key: 'primer_nombre' }, { kind: 'text', text: ' de ' }, { kind: 'value', text: 'Barbería Norte', key: 'empresa' },
      { kind: 'text', text: ', soy ' }, { kind: 'value', text: 'Luis', key: 'mi_nombre' }, { kind: 'text', text: '. ' }, { kind: 'missing', text: '{{contact.ciudad}}', key: 'contact.ciudad' },
    ]);
  });
  it('sin variables es un solo trozo de texto; vacío no tiene trozos', () => {
    expect(previewParts('Sin variables', values)).toEqual([{ kind: 'text', text: 'Sin variables' }]);
    expect(previewParts('', values)).toEqual([]);
  });
  it('splitVariables separa el texto de las variables para resaltarlas', () => {
    expect(splitVariables('a {{x}} b')).toEqual([{ variable: false, text: 'a ' }, { variable: true, text: '{{x}}' }, { variable: false, text: ' b' }]);
    expect(splitVariables('')).toEqual([]);
  });
});

describe('barra lateral compacta', () => {
  it('los enlaces usan el botón de 6 × 10 px y el texto de 12,5 px en escritorio y el icono de 16 px; el activo va en negrita', async () => {
    mockApi({ ...authed(ME_ADMIN) });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: /Secciones/ });
    const links = within(nav).getAllByRole('link');
    expect(links.length).toBeGreaterThan(3);
    for (const l of links) {
      expect(l.className).toContain('md:py-1.5');
      expect(l.className).toContain('md:text-[12.5px]');
      expect(l.className).toContain('md:px-2.5');
      expect(l.querySelector('svg')!.getAttribute('class')).toContain('md:size-4');
    }
    const active = links.find((l) => l.getAttribute('aria-current') === 'page');
    expect(active?.className).toContain('font-semibold');
    expect(links.find((l) => l !== active)!.className).toContain('font-medium');
  });
});

describe('Departamentos', () => {
  const queue = (over: Partial<Queue> = {}): Queue => ({ id: 'q1', name: 'Ventas', color: '#7c5cfa', distribution_on: true, mode: 'rotation', members: [], channels: [], open_now: true, unassigned_count: 0, is_sample: false, ...over }) as unknown as Queue;
  const server = (items: Queue[], max = 10): Record<string, Handler> => ({
    ...authed(ME_ADMIN),
    'GET /queues': () => ({ body: { items, limits: { max_queues: max } } as unknown as QueueList }),
  });

  it('el encabezado trae título, descripción y el botón en un mismo bloque, y la última tarjeta punteada crea otro departamento', async () => {
    mockApi(server([queue()]));
    renderApp('/departments');
    expect(await screen.findByRole('heading', { level: 1, name: 'Departamentos' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Nuevo departamento' })).toBeInTheDocument(); // el del encabezado
    const card = await screen.findByRole('button', { name: /^Nuevo departamento: nombre, color/ });
    expect(card.className).toContain('border-dashed');
    await userEvent.click(card);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('con el máximo de departamentos no hay tarjeta de «nuevo»', async () => {
    mockApi(server([queue({ id: 'a' }), queue({ id: 'b', name: 'Soporte' })], 2));
    renderApp('/departments');
    await screen.findByRole('list', { name: 'Departamentos' });
    expect(screen.queryByRole('button', { name: /^Nuevo departamento: nombre, color/ })).not.toBeInTheDocument();
  });
});
