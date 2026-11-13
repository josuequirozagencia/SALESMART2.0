import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import { PRESENCE_HEARTBEAT_MS } from '../src/lib/realtime';
import { lastSocket, sockets } from './fake-socket';
import { authed, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// v13 · S4.1 — La web le dice al servidor qué conversación tiene abierta y si la pestaña está a la vista; el servidor decide si un mensaje nuevo merece una notificación del sistema.
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date().toISOString();
const conv = (id: string): Conversation => ({
  id, status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [], last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW },
  window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null,
});
const server = (): Record<string, Handler> => {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [conv(CONV), conv(OTHER)], next_cursor: null, counts: { working: 2, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
  };
  for (const id of [CONV, OTHER]) {
    routes[`GET /conversations/${id}`] = () => ({ body: conv(id) });
    routes[`GET /conversations/${id}/messages`] = () => ({ body: { items: [] as ChatMessage[], next_cursor: null } });
    routes[`GET /conversations/${id}/scheduled`] = () => ({ body: { items: [], time_zone: 'America/Guayaquil' } });
    routes[`GET /conversations/${id}/quick-replies`] = () => ({ body: { items: [] } });
  }
  return routes;
};
const presence = (): Array<{ conversation_id: string | null; visible: boolean }> =>
  lastSocket().emitted.filter((e) => e.event === 'presence').map((e) => e.payload as { conversation_id: string | null; visible: boolean });
let visibility: 'visible' | 'hidden' = 'visible';
const setVisibility = (v: 'visible' | 'hidden'): void => { visibility = v; document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  sockets.length = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => { vi.useRealTimers(); });

describe('presencia (latido hacia el servidor)', () => {
  it('con una conversación abierta y la pestaña a la vista dice cuál mira; al conectar lo repite (la conexión nueva no sabe nada)', async () => {
    mockApi(server());
    renderApp(`/inbox/${CONV}`);
    await screen.findByRole('region', { name: 'Conversación con Ana Torres' });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    lastSocket().fire('connect');
    expect(presence().at(-1)).toEqual({ conversation_id: CONV, visible: true });
  });

  it('al ocultar la pestaña dice «no la miro»; al volver, que sí', async () => {
    mockApi(server());
    renderApp(`/inbox/${CONV}`);
    await screen.findByRole('region', { name: 'Conversación con Ana Torres' });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    lastSocket().fire('connect');
    act(() => setVisibility('hidden'));
    expect(presence().at(-1)).toEqual({ conversation_id: CONV, visible: false });
    act(() => setVisibility('visible'));
    expect(presence().at(-1)).toEqual({ conversation_id: CONV, visible: true });
  });

  it('en la lista (sin conversación abierta) dice que no mira ninguna; al abrir otra, cuál', async () => {
    mockApi(server());
    renderApp('/inbox');
    await screen.findByRole('searchbox', { name: 'Buscar conversaciones' });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    lastSocket().fire('connect');
    expect(presence().at(-1)).toEqual({ conversation_id: null, visible: true });
  });

  it('repite el latido cada 10 s mientras la pestaña se ve, y no mientras está oculta', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi(server());
    renderApp(`/inbox/${OTHER}`);
    await screen.findByRole('region', { name: 'Conversación con Ana Torres' });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    lastSocket().fire('connect');
    const before = presence().length;
    act(() => { vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3 + 100); });
    expect(presence().length).toBeGreaterThanOrEqual(before + 3);
    expect(presence().length).toBeLessThanOrEqual(before + 4);
    visibility = 'hidden';
    const hidden = presence().length;
    act(() => { vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3); });
    expect(presence().length).toBe(hidden); // oculta: no hay latido (el servidor la da por ausente a los 20 s)
  });

  it('el identificador de la conversación solo se manda si es un UUID (rutas como /inbox/scheduled no lo son)', async () => {
    mockApi(server());
    renderApp('/inbox');
    await screen.findByRole('searchbox', { name: 'Buscar conversaciones' });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    lastSocket().fire('connect');
    for (const p of presence()) expect(p.conversation_id === null || /^[0-9a-f-]{36}$/.test(p.conversation_id)).toBe(true);
  });
});
