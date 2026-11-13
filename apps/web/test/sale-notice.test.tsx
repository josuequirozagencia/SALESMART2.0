import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// v13 · S4.2 — «Nueva venta: {vendedor} · {monto} · {contacto}» en la campana de la administración.
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const sale = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n1', type: 'sale_created', created_at: new Date().toISOString(), read_at: null, actor: { id: 'u2', name: 'Carolina Vera' }, conversation: null, message_id: null, excerpt: null, task: null,
  sale: { id: 's1', product: 'Corte + barba', amount: '120.00', currency: 'USD', seller: { id: 'u2', name: 'Carolina Vera' }, contact: { id: 'k1', name: 'Ana Torres' } }, ...over,
});
const server = (items: AppNotification[], marked: string[] = []): Record<string, Handler> => ({
  ...authed(ME_ADMIN),
  'GET /notifications': () => ({ body: { items, next_cursor: null, unread: items.filter((i) => i.read_at === null).length } }),
  'POST /notifications/n1/read': () => { marked.push('n1'); return { body: { id: 'n1', read_at: new Date().toISOString() } }; },
  'GET /sales': () => ({ body: { items: [], next_cursor: null } }),
});

describe('campana · aviso de venta nueva', () => {
  it('dice «Nueva venta: vendedor · monto · contacto», cuenta como sin leído y al abrirlo se marca y lleva a Ventas', async () => {
    const marked: string[] = [];
    mockApi(server([sale()], marked));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (1 sin leer)' }));
    const list = within(await screen.findByRole('list', { name: 'Avisos' }));
    const link = list.getByRole('link', { name: /Nueva venta: Carolina Vera · .*120.* · Ana Torres/ });
    expect(link).toHaveAttribute('href', '/sales');
    expect(list.getByRole('img', { name: 'Sin leer' })).toBeInTheDocument();
    await userEvent.click(link);
    expect(marked).toEqual(['n1']);
  });

  it('una venta sin vendedor o un aviso sin el detalle de la venta se dicen igual, sin romper la lista', async () => {
    mockApi(server([sale({ id: 'n2', sale: { id: 's2', product: 'x', amount: '5.50', currency: 'USD', seller: null, contact: { id: 'k2', name: 'Beto Luna' } } }), sale({ id: 'n3', sale: null })]));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: /^Avisos/ }));
    const list = within(await screen.findByRole('list', { name: 'Avisos' }));
    expect(list.getByText(/Nueva venta: Sin vendedor · .*5.*50.* · Beto Luna/)).toBeInTheDocument();
    expect(list.getByText('Nueva venta registrada')).toBeInTheDocument();
  });
});
