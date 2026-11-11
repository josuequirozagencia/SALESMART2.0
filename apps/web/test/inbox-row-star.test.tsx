import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

function stubWidth(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return { matches, media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  status: 'working',
  unread_count: 0,
  last_message_at: ago(5 * MIN),
  last_inbound_at: ago(60 * MIN),
  assigned_at: ago(120 * MIN),
  closed_at: null,
  created_at: ago(180 * MIN),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
  owner: { id: 'u2', name: 'Luis Navas' },
  participants: [],
  my_access: 'owner',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola, ¿tienen cita mañana?', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * 60 * MIN).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
  sla: null,
  ...over,
});
const OPTIONS: InboxOptions = {
  queues: [{ id: 'q1', name: 'Ventas', color: '#7c5cfa' }],
  channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }],
  owners: [],
  tags: [],
};

function routes(items: Conversation[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items, next_cursor: null, counts: { working: items.length, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    ...extra,
  };
}
const favRoutes = (calls: string[]): Record<string, Handler> => ({
  'PUT /conversations/c1/favorite': () => { calls.push('PUT'); return { body: conv({ favorite: true }) }; },
  'DELETE /conversations/c1/favorite': () => { calls.push('DELETE'); return { body: conv({ favorite: false }) }; },
});
const touch = (x: number, y: number) => ({ pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y });

describe('Estrella desde la fila de la lista (v11 S4)', () => {
  it('mantener pulsada la fila (móvil) abre una hoja con «Destacar» y «Abrir la conversación»; Destacar pone la estrella (PUT) y la hoja se cierra', async () => {
    stubWidth(390);
    const calls: string[] = [];
    mockApi(routes([conv()], favRoutes(calls)));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(row, touch(100, 100));
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    const sheet = within(await screen.findByRole('dialog', { name: 'Acciones de Ana Torres' }));
    expect(sheet.getByRole('button', { name: 'Abrir la conversación' })).toBeInTheDocument();
    await userEvent.click(sheet.getByRole('button', { name: 'Destacar' }));
    await waitFor(() => expect(calls).toEqual(['PUT']));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Acciones de Ana Torres' })).not.toBeInTheDocument());
  });

  it('soltar antes de tiempo, o mover el dedo (desplazar la lista), cancela el mantener pulsado', async () => {
    stubWidth(390);
    mockApi(routes([conv()]));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(row, touch(100, 100));
    await vi.advanceTimersByTimeAsync(200);
    fireEvent.pointerUp(row, touch(100, 100));
    await vi.advanceTimersByTimeAsync(600);
    fireEvent.pointerDown(row, touch(100, 100));
    fireEvent.pointerMove(row, touch(100, 160)); // vertical: es un scroll
    await vi.advanceTimersByTimeAsync(700);
    vi.useRealTimers();
    expect(screen.queryByRole('dialog', { name: 'Acciones de Ana Torres' })).not.toBeInTheDocument();
  });

  it('deslizar a la izquierda deja ver «Destacar»; tocarlo pone la estrella y la fila vuelve a su sitio', async () => {
    stubWidth(390);
    const calls: string[] = [];
    mockApi(routes([conv()], favRoutes(calls)));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    expect(screen.getByRole('button', { name: 'Destacar la conversación de Ana Torres', hidden: true })).toHaveAttribute('tabindex', '-1'); // cerrada: fuera del orden de tabulación
    fireEvent.pointerDown(row, touch(300, 100));
    fireEvent.pointerMove(row, touch(200, 104)); // 100 px a la izquierda: pasa de la mitad
    fireEvent.pointerUp(row, touch(200, 104));
    await waitFor(() => expect(row.getAttribute('style')).toContain('translateX(-88px)'));
    const action = screen.getByRole('button', { name: 'Destacar la conversación de Ana Torres' });
    expect(action).toHaveAttribute('tabindex', '0');
    await userEvent.click(action);
    await waitFor(() => expect(calls).toEqual(['PUT']));
    await waitFor(() => expect(row.getAttribute('style') ?? '').not.toContain('translateX(-88px)'));
  });

  it('un deslizamiento corto vuelve a su sitio sin abrir nada, y uno sobre todo vertical no desliza la fila', async () => {
    stubWidth(390);
    mockApi(routes([conv()]));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    fireEvent.pointerDown(row, touch(300, 100));
    fireEvent.pointerMove(row, touch(270, 102)); // 30 px: menos de la mitad
    fireEvent.pointerUp(row, touch(270, 102));
    await waitFor(() => expect(row.getAttribute('style') ?? '').not.toContain('translateX(-88px)'));
    fireEvent.pointerDown(row, touch(300, 100));
    fireEvent.pointerMove(row, touch(280, 200)); // sobre todo vertical
    fireEvent.pointerUp(row, touch(280, 200));
    expect(row.getAttribute('style') ?? '').not.toContain('translateX(-');
  });

  it('con ratón (sin toque) los gestos no hacen nada', async () => {
    stubWidth(390);
    mockApi(routes([conv()]));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(row, { pointerType: 'mouse', pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(row, { pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 100 });
    await vi.advanceTimersByTimeAsync(700);
    vi.useRealTimers();
    expect(screen.queryByRole('dialog', { name: 'Acciones de Ana Torres' })).not.toBeInTheDocument();
    expect(row.getAttribute('style') ?? '').not.toContain('translateX(-');
  });

  it('en escritorio la fila trae un botón de estrella que pone la estrella; si ya la tiene, ofrece quitarla', async () => {
    stubWidth(1440);
    const calls: string[] = [];
    mockApi(routes([conv()], favRoutes(calls)));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    const star = screen.getByRole('button', { name: 'Destacar la conversación de Ana Torres' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    await waitFor(() => expect(calls).toEqual(['PUT']));
  });

  it('en escritorio una conversación destacada ofrece «Quitar de destacadas» (DELETE)', async () => {
    stubWidth(1440);
    const calls: string[] = [];
    mockApi(routes([conv({ favorite: true })], favRoutes(calls)));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres, destacada' });
    const star = screen.getByRole('button', { name: 'Quitar de destacadas la conversación de Ana Torres' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(star);
    await waitFor(() => expect(calls).toEqual(['DELETE']));
  });
});
