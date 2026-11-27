import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import type { SaleOptions } from '../src/features/sales/useSales';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const NOW = new Date().toISOString();
const VENTAS = { id: 'q1', name: 'Ventas', color: '#7c5cfa' };
const conv = (over: Partial<Conversation> = {}, setQueue = true): Conversation =>
  ({
    id: 'c1', status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: setQueue ? 'supervisor' : 'owner',
    queue: null, channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
    last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW }, window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false, set_queue: setQueue }, sla: null, ...over,
  }) as Conversation;

const BLOCKED: SaleOptions = { currency: 'USD', queue: null, products: [], blocked: 'no_queue' };
const READY: SaleOptions = { currency: 'USD', queue: { id: 'q1', name: 'Ventas' }, products: [{ id: 'p1', name: 'Corte de cabello', kind: 'service', price: '12.50' }], blocked: null };

function server(admin: boolean, o: { warning?: boolean; fail?: boolean } = {}) {
  const world = { current: conv({}, admin), options: BLOCKED, puts: [] as unknown[] };
  const handlers: Record<string, Handler> = {
    ...authed(admin ? ME_ADMIN : ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [world.current], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [VENTAS, { id: 'q2', name: 'Soporte', color: '#22aa88' }], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: world.current }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /sales/options': () => ({ body: world.options }),
    'PUT /conversations/c1/queue': (c) => {
      world.puts.push(c.body);
      if (o.fail) return err(404, 'QUEUE_NOT_FOUND', 'Ese departamento no existe o está archivado');
      world.current = conv({ queue: VENTAS }, admin);
      world.options = READY;
      return { body: { ...world.current, warning: o.warning ? 'OWNER_NOT_IN_QUEUE' : null } };
    },
  };
  mockApi(handlers);
  return world;
}
const openSale = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Registrar venta' }));
  return screen.findByRole('dialog', { name: 'Registrar venta' });
};

describe('Departamento de una conversación (V24)', () => {
  it('el administrador lo asigna dentro de «Registrar venta» y vuelve al formulario con el catálogo', async () => {
    const w = server(true);
    renderApp('/inbox/c1');
    const sale = within(await openSale());
    await userEvent.click(await sale.findByRole('button', { name: 'Asignar departamento' }));
    const d = within(await screen.findByRole('dialog', { name: 'Asignar departamento' }));
    await userEvent.selectOptions(await d.findByRole('combobox', { name: 'Departamento' }), 'q1');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    const back = within(await screen.findByRole('dialog', { name: 'Registrar venta' }));
    expect(await back.findByRole('combobox', { name: 'Producto o servicio' })).toBeInTheDocument();
    expect(w.puts).toEqual([{ queue_id: 'q1' }]);
  });

  it('el asesor no puede: el aviso le dice qué pedir y no hay botón', async () => {
    server(false);
    renderApp('/inbox/c1');
    const sale = within(await openSale());
    expect(await sale.findByText(/Pídele a un administrador que le asigne un departamento a esta conversación/)).toBeInTheDocument();
    expect(sale.queryByRole('button', { name: /departamento/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Asignar departamento' })).toBeNull();
  });

  it('desde la cabecera: avisa si quien la tiene no pertenece al departamento', async () => {
    server(true, { warning: true });
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Asignar departamento' }));
    const d = within(await screen.findByRole('dialog', { name: 'Asignar departamento' }));
    await userEvent.selectOptions(await d.findByRole('combobox', { name: 'Departamento' }), 'q1');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText(/no pertenece a ese departamento/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Cambiar departamento' })).toBeInTheDocument();
  });

  it('un rechazo del servidor se muestra y la ventana sigue abierta', async () => {
    server(true, { fail: true });
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Asignar departamento' }));
    const d = within(await screen.findByRole('dialog', { name: 'Asignar departamento' }));
    await userEvent.selectOptions(await d.findByRole('combobox', { name: 'Departamento' }), 'q2');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Ese departamento no existe o está archivado')).toBeInTheDocument();
  });
});
