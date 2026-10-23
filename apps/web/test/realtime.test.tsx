import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRealtimeStatus, startRealtime } from '../src/lib/realtime';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import { sockets, lastSocket } from './fake-socket';
import { authed, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  sockets.length = 0;
});

const NOW = new Date().toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    status: 'working',
    unread_count: 0,
    last_message_at: NOW,
    last_inbound_at: NOW,
    assigned_at: NOW,
    closed_at: null,
    created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
    owner: { id: 'u2', name: 'Luis Navas' },
    participants: [],
    my_access: 'owner',
    queue: null,
    channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
    tags: [],
    last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW },
    window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
    sla: null,
    ...over,
  }) as Conversation;

function server(): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
  };
}

const live = async () => {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  lastSocket().fire('connect');
  await waitFor(() => expect(getRealtimeStatus()).toBe('live'));
};

describe('Tiempo real · conexión', () => {
  it('al entrar a la empresa abre UNA conexión a /v1/realtime con el token de la sesión; al conectar el estado es «live»', async () => {
    mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    expect(sockets).toHaveLength(1);
    expect(lastSocket().opts.path).toBe('/v1/realtime');
    expect(lastSocket().authToken).toBe('acc-2');
    expect(getRealtimeStatus()).toBe('connecting');
    await live();
  });

  it('un aviso de mensaje vuelve a pedir el listado y el hilo abierto, una sola vez aunque lleguen varios juntos', async () => {
    const api = mockApi(server());
    renderApp('/inbox/c1');
    await screen.findByText('Ana Torres');
    await live();
    const list = api.count('GET /conversations');
    const thread = api.count('GET /conversations/c1/messages');
    const body = { organization_id: 'o1', request_id: 'r', at: NOW, data: { conversation_id: 'c1', message_id: 'm9' } };
    lastSocket().fire('conversation.updated', body);
    lastSocket().fire('message.created', body);
    lastSocket().fire('message.updated', body);
    await waitFor(() => expect(api.count('GET /conversations')).toBe(list + 1));
    await waitFor(() => expect(api.count('GET /conversations/c1/messages')).toBe(thread + 1));
    await new Promise((r) => setTimeout(r, 600));
    expect(api.count('GET /conversations')).toBe(list + 1); // no se repitió
  });

  it('un aviso de otra conversación solo refresca el listado, no el hilo abierto', async () => {
    const api = mockApi(server());
    renderApp('/inbox/c1');
    await screen.findByText('Ana Torres');
    await live();
    const list = api.count('GET /conversations');
    const thread = api.count('GET /conversations/c1/messages');
    lastSocket().fire('conversation.updated', { organization_id: 'o1', request_id: 'r', at: NOW, data: { conversation_id: 'c2' } });
    await waitFor(() => expect(api.count('GET /conversations')).toBe(list + 1));
    expect(api.count('GET /conversations/c1/messages')).toBe(thread);
  });

  it('una caída marca «down» (las pantallas vuelven a consultar solas) y al recuperarla se pide todo lo abierto de nuevo', async () => {
    const api = mockApi(server());
    renderApp('/inbox/c1');
    await screen.findByText('Ana Torres');
    await live();
    lastSocket().fire('disconnect', 'transport close');
    await waitFor(() => expect(getRealtimeStatus()).toBe('down'));
    const list = api.count('GET /conversations');
    const thread = api.count('GET /conversations/c1/messages');
    const scheduled = api.count('GET /conversations/c1/scheduled');
    lastSocket().fire('connect');
    await waitFor(() => expect(getRealtimeStatus()).toBe('live'));
    await waitFor(() => expect(api.count('GET /conversations')).toBe(list + 1));
    await waitFor(() => expect(api.count('GET /conversations/c1/messages')).toBe(thread + 1));
    await waitFor(() => expect(api.count('GET /conversations/c1/scheduled')).toBe(scheduled + 1));
  });

  it('si el servidor rechaza la sesión, se renueva y se vuelve a conectar (con espera); mientras tanto el estado es «down»', async () => {
    const api = mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    await live();
    const refreshes = api.count('POST /auth/refresh');
    const s = lastSocket();
    const connects = s.connects;
    s.fire('disconnect', 'io server disconnect'); // sesión vencida o demasiadas pestañas
    await waitFor(() => expect(getRealtimeStatus()).toBe('down'));
    await waitFor(() => expect(api.count('POST /auth/refresh')).toBe(refreshes + 1), { timeout: 3500 });
    await waitFor(() => expect(s.connects).toBe(connects + 1));
  });

  it('un rechazo del handshake (connect_error) también reintenta con la sesión renovada', async () => {
    const api = mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    await waitFor(() => expect(sockets.length).toBe(1));
    const refreshes = api.count('POST /auth/refresh');
    const s = lastSocket();
    s.fire('connect_error', new Error('unauthorized'));
    expect(getRealtimeStatus()).toBe('down');
    await waitFor(() => expect(api.count('POST /auth/refresh')).toBe(refreshes + 1), { timeout: 3500 });
    await waitFor(() => expect(s.connects).toBe(1));
  });

  it('al cerrar la conexión (salir o cambiar de empresa) el estado vuelve a «off» y no queda nada abierto', () => {
    const stop = startRealtime({ onChange: () => {}, onResync: () => {} });
    expect(getRealtimeStatus()).toBe('connecting');
    const s = lastSocket();
    stop();
    expect(s.closed).toBe(true);
    expect(getRealtimeStatus()).toBe('off');
  });

  it('un aviso mal formado (sin conversación) se ignora sin romper nada', () => {
    const seen: string[] = [];
    const stop = startRealtime({ onChange: (c) => seen.push(c.conversationId), onResync: () => {} });
    const s = lastSocket();
    s.fire('connect');
    s.fire('conversation.updated', { data: {} });
    s.fire('conversation.updated', undefined);
    s.fire('message.created', { data: { conversation_id: 'c7', message_id: 'm1' } });
    expect(seen).toEqual(['c7']);
    stop();
  });
});
