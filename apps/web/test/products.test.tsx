import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue, QueueProduct } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const queue: Queue = {
  id: 'q1', name: 'Ventas', color: '#7c5cfa', distribution_on: false, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3,
  greeting: null, out_of_hours_message: null, auto_close_hours: 0, hours: null, open_now: true, members: [], channels: [], unassigned_count: 0,
  created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z',
};
const product = (over: Partial<QueueProduct> = {}): QueueProduct => ({ id: 'p1', queue_id: 'q1', name: 'Corte de cabello', kind: 'service', price: '12.50', active: true, created_at: '2026-10-23T10:00:00.000Z', updated_at: '2026-10-23T10:00:00.000Z', ...over });

interface World { items: QueueProduct[]; currency: string; posts: unknown[]; patches: Array<{ id: string; body: unknown }>; failCreate?: () => ReturnType<Handler> }
function server(w: World): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /queues': () => ({ body: { items: [queue], limits: { max_queues: 20 } } }),
    'GET /queues/q1/products': () => ({ body: { items: structuredClone(w.items), currency: w.currency, limits: { max_products: 200 } } }),
    'POST /queues/q1/products': ({ body }) => {
      w.posts.push(body);
      if (w.failCreate) return w.failCreate();
      const b = body as { name: string; kind: QueueProduct['kind']; price: string };
      const created = product({ id: `p${w.items.length + 1}`, name: b.name, kind: b.kind, price: Number(b.price).toFixed(2) });
      w.items = [...w.items, created];
      return { status: 201, body: created };
    },
  };
  for (const id of ['p1', 'p2']) {
    routes[`PATCH /queues/q1/products/${id}`] = ({ body }) => {
      w.patches.push({ id, body });
      w.items = w.items.map((p) => (p.id === id ? { ...p, ...(body as Partial<QueueProduct>) } : p));
      return { body: w.items.find((p) => p.id === id) };
    };
  }
  return routes;
}
const world = (over: Partial<World> = {}): World => ({ items: [], currency: 'USD', posts: [], patches: [], ...over });

const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Configurar Ventas' }));
  const dialog = await screen.findByRole('dialog', { name: 'Configurar Ventas' });
  return within(await within(dialog).findByRole('region', { name: 'Catálogo de productos y servicios' }));
};

describe('Configuración › Colas › Catálogo', () => {
  it('una cola sin productos lo explica y deja agregar el primero: tipo, precio con hasta 2 decimales y la moneda de la empresa', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/queues');
    const c = await open();
    expect(await c.findByText(/Todavía no hay productos/)).toBeInTheDocument();
    expect(c.getByText('Precio (USD)')).toBeInTheDocument();
    await userEvent.type(c.getByLabelText('Nombre'), 'Corte de cabello');
    await userEvent.selectOptions(c.getByLabelText('Tipo'), 'service');
    await userEvent.type(c.getByLabelText('Precio (USD)'), '12,5'); // coma decimal
    await userEvent.click(c.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(w.posts).toEqual([{ name: 'Corte de cabello', kind: 'service', price: '12.5' }]));
    const list = await c.findByRole('list', { name: 'Productos de la cola' });
    expect(within(list).getByText('Corte de cabello')).toBeInTheDocument();
    expect(within(list).getByText('Servicio')).toBeInTheDocument();
    expect(within(list).getByText(/12,50/)).toBeInTheDocument();
    expect(c.getByLabelText('Nombre')).toHaveValue(''); // el formulario queda listo para el siguiente
  });

  it('no se envía un nombre vacío ni un precio inválido; el servidor lo vuelve a exigir', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/queues');
    const c = await open();
    await userEvent.click(await c.findByRole('button', { name: 'Agregar' }));
    expect(await c.findByText('Escribe el nombre')).toBeInTheDocument();
    expect(c.getByText(/hasta 2 decimales/)).toBeInTheDocument();
    await userEvent.type(c.getByLabelText('Nombre'), 'Gel');
    await userEvent.type(c.getByLabelText('Precio (USD)'), '3.456');
    await userEvent.click(c.getByRole('button', { name: 'Agregar' }));
    expect(await c.findByText(/hasta 2 decimales/)).toBeInTheDocument();
    expect(w.posts).toEqual([]);
  });

  it('un nombre repetido muestra el aviso del servidor', async () => {
    const w = world({ items: [product()], failCreate: () => err(409, 'PRODUCT_EXISTS', 'Ya hay un producto con ese nombre en esta cola') });
    mockApi(server(w));
    renderApp('/settings/queues');
    const c = await open();
    await userEvent.type(await c.findByLabelText('Nombre'), 'corte de cabello');
    await userEvent.type(c.getByLabelText('Precio (USD)'), '10');
    await userEvent.click(c.getByRole('button', { name: 'Agregar' }));
    expect(await c.findByText('Ya hay un producto con ese nombre en esta cola')).toBeInTheDocument();
  });

  it('editar cambia nombre, tipo y precio; desactivar y activar se guardan al instante y lo desactivado se marca', async () => {
    const w = world({ items: [product(), product({ id: 'p2', name: 'Gel fijador', kind: 'product', price: '8.00' })] });
    mockApi(server(w));
    renderApp('/settings/queues');
    const c = await open();
    await userEvent.click(await c.findByRole('button', { name: 'Editar Corte de cabello' }));
    const name = c.getAllByLabelText('Nombre')[0]!;
    await userEvent.clear(name);
    await userEvent.type(name, 'Corte y barba');
    const price = c.getByLabelText('Precio');
    await userEvent.clear(price);
    await userEvent.type(price, '15');
    await userEvent.click(c.getByRole('button', { name: 'Guardar producto' }));
    await waitFor(() => expect(w.patches).toEqual([{ id: 'p1', body: { name: 'Corte y barba', kind: 'service', price: '15' } }]));
    expect(await c.findByText('Corte y barba')).toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Desactivar Gel fijador' }));
    await waitFor(() => expect(w.patches.at(-1)).toEqual({ id: 'p2', body: { active: false } }));
    expect(await c.findByText('Desactivado')).toBeInTheDocument();
    expect(await c.findByRole('button', { name: 'Activar Gel fijador' })).toBeInTheDocument();
  });

  it('con otra moneda de la empresa los precios se muestran en ella', async () => {
    mockApi(server(world({ items: [product({ price: '1500.00' })], currency: 'EUR' })));
    renderApp('/settings/queues');
    const c = await open();
    expect((await c.findByText(/1\D?500\D00/)).textContent).toMatch(/€|EUR/);
    expect(c.getByText('Precio (EUR)')).toBeInTheDocument();
  });
});
