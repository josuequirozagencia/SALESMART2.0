import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, mockApi, pickMore, renderApp, resetWorld, type Handler } from './helpers';

// M5.10 — Acciones de la conversación en la cabecera. Hasta M5.10 era el menú «⋯ Más»; desde v13 S2.2 son iconos con su nombre (y el «⋮» solo aparece si no caben: ver `inbox-v13-s2.test.tsx`).
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const later = (ms: number): string => new Date(Date.now() + ms).toISOString();

const FULL = { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true };
const NONE = { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false };
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: later(23 * HOUR) }, can: FULL, sla: null, ...over,
});
const msg = (): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null,
});
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };

describe('Inbox · acciones de la cabecera (iconos)', () => {
  const serverFor = (c: Conversation): Record<string, Handler> => ({
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [], time_zone: 'America/Guayaquil' } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
  });

  it('las acciones son iconos con nombre y ayuda, las frecuentes primero; Aceptar y Asignarme siguen a la vista y no hay botón «Más»', async () => {
    mockApi(serverFor(conv({ status: 'pending', can: { ...FULL, accept: true } })));
    renderApp('/inbox/c1');
    expect(await screen.findByRole('button', { name: 'Aceptar' })).toBeInTheDocument();
    const bar = within(await screen.findByRole('group', { name: 'Acciones de la conversación' }));
    const buttons = bar.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Registrar venta', 'Agendar', 'Transferir o compartir', 'Finalizar']);
    for (const b of buttons) {
      expect(b).toHaveAttribute('title', b.getAttribute('aria-label'));
      expect(b).toHaveTextContent(''); // solo icono
      expect(b.className).toMatch(/size-11/); // área táctil de 44 px
    }
    expect(screen.queryByRole('button', { name: 'Más acciones' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('«Transferir o compartir» abre el selector y «Finalizar» pide confirmación', async () => {
    mockApi({
      ...serverFor(conv()),
      'GET /conversations/c1/transfer-options': () => ({ body: { items: [], participants: [], can_transfer: true, can_share: true } }),
    });
    renderApp('/inbox/c1');
    await pickMore('Transferir');
    expect(await screen.findByRole('dialog', { name: 'Transferir o compartir' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    cleanup();
    mockApi(serverFor(conv()));
    renderApp('/inbox/c1');
    await pickMore('Finalizar');
    expect(await screen.findByText(/Si el cliente escribe de nuevo se abrirá otra conversación/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sí, finalizar' })).toBeInTheDocument();
  });

  it('el teclado recorre los iconos con Tab y los activa con Enter', async () => {
    mockApi({
      ...serverFor(conv()),
      'GET /conversations/c1/transfer-options': () => ({ body: { items: [], participants: [], can_transfer: true, can_share: true } }),
    });
    renderApp('/inbox/c1');
    const sale = await screen.findByRole('button', { name: 'Registrar venta' });
    sale.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Agendar' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Transferir o compartir' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Transferir o compartir' })).toBeInTheDocument();
  });

  it('un colaborador solo ve «Dejar de participar»; quien no atiende ni puede nada no ve acciones', async () => {
    mockApi(serverFor(conv({ my_access: 'collaborator_view', can: NONE })));
    renderApp('/inbox/c1');
    const bar = within(await screen.findByRole('group', { name: 'Acciones de la conversación' }));
    expect(bar.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Dejar de participar']);
    cleanup();
    // sin ninguna acción posible (p. ej. una conversación ajena de solo lectura) la cabecera no deja ni el grupo vacío
    mockApi(serverFor(conv({ owner: null, status: 'closed', can: NONE })));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    expect(screen.queryByRole('group', { name: 'Acciones de la conversación' })).not.toBeInTheDocument();
  });
});
