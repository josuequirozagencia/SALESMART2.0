import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDrafts } from '../src/features/inbox/draftStore';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, err, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

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
  clearDrafts();
});
afterEach(() => vi.unstubAllGlobals());

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
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true },
  sla: null,
  ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', status: 'received', sent_at: ago(5 * MIN), is_note: false, ...over } as ChatMessage);
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const AI = (suggestions: boolean) => ({ agent: { id: 'a1', name: 'Sofía', suggestions_enabled: suggestions }, state: 'paused', reason: 'manual', can_control: true });
const DRAFT = { text: 'Hola Ana, mañana tenemos cita a las 10:00 y a las 15:00. ¿Cuál te acomoda?', agent: { id: 'a1', name: 'Sofía' }, credits_used: 2, remaining_today: 49 };

function server(c: Conversation, ai: ReturnType<typeof AI> | null, extra: Record<string, Handler> = {}): { routes: Record<string, Handler>; posts: Array<{ path: string; body: unknown }>; suggests: number } {
  const state = { posts: [] as Array<{ path: string; body: unknown }>, suggests: 0 };
  const routes: Record<string, Handler> = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'POST /conversations/c1/read': () => ({ body: c }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /contacts/k1': () => err(404, 'NOT_FOUND'),
    'GET /conversations/c1/ai': () => ({ body: ai ?? { agent: null, state: 'idle', reason: null, can_control: false } }),
    'POST /conversations/c1/ai/suggest': () => { state.suggests += 1; return { body: DRAFT }; },
    'POST /conversations/c1/messages': (call: Call) => {
      state.posts.push({ path: '/conversations/c1/messages', body: call.body });
      return { status: 201, body: msg({ id: 'new', direction: 'out', sender_type: 'human', text: (call.body as { text: string }).text, status: 'sent' }) };
    },
    ...extra,
  };
  return { routes, posts: state.posts, get suggests() { return state.suggests; } };
}

describe('Sugerir respuesta en el redactor (v11 S4)', () => {
  it('con las sugerencias activadas aparece «Sugerir»: muestra una tarjeta rotulada, «Usar» la pone en el redactor SIN enviarla y la tarjeta se cierra', async () => {
    stubWidth(1440);
    const s = server(conv(), AI(true));
    mockApi(s.routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Sugerir respuesta' }));
    const card = within(await screen.findByRole('region', { name: 'Sugerencia de IA' }));
    expect(card.getByText(/revísala antes de enviar/)).toBeInTheDocument();
    expect(card.getByText(DRAFT.text)).toBeInTheDocument();
    expect(card.getByText(/2 créditos · quedan 49 hoy/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toHaveValue('');
    await userEvent.click(card.getByRole('button', { name: 'Usar' }));
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toHaveValue(DRAFT.text);
    expect(screen.queryByRole('region', { name: 'Sugerencia de IA' })).not.toBeInTheDocument();
    expect(s.posts).toEqual([]); // nunca se envía solo
    expect(s.suggests).toBe(1);
  });

  it('si ya hay texto escrito pregunta: «Reemplazar lo que escribí» o «Agregar al final»', async () => {
    stubWidth(1440);
    mockApi(server(conv(), AI(true)).routes);
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.type(box, 'Hola Ana');
    await userEvent.click(screen.getByRole('button', { name: 'Sugerir respuesta' }));
    const card = within(await screen.findByRole('region', { name: 'Sugerencia de IA' }));
    expect(card.queryByRole('button', { name: 'Usar' })).not.toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Agregar al final' }));
    expect(box).toHaveValue(`Hola Ana\n\n${DRAFT.text}`);
  });

  it('«Descartar» cierra la tarjeta sin tocar el redactor y «Regenerar» pide otra', async () => {
    stubWidth(1440);
    const s = server(conv(), AI(true));
    mockApi(s.routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Sugerir respuesta' }));
    const card = within(await screen.findByRole('region', { name: 'Sugerencia de IA' }));
    await userEvent.click(card.getByRole('button', { name: 'Regenerar' }));
    await waitFor(() => expect(s.suggests).toBe(2));
    await userEvent.click(within(await screen.findByRole('region', { name: 'Sugerencia de IA' })).getByRole('button', { name: 'Descartar' }));
    expect(screen.queryByRole('region', { name: 'Sugerencia de IA' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toHaveValue('');
  });

  it('un error (tope del día, sin créditos…) se dice con su motivo y se puede cerrar', async () => {
    stubWidth(1440);
    mockApi(server(conv(), AI(true), { 'POST /conversations/c1/ai/suggest': () => err(409, 'SUGGESTION_LIMIT', 'Tu empresa llegó al máximo de 50 sugerencias en 24 horas: inténtalo más tarde') }).routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Sugerir respuesta' }));
    expect(await screen.findByText(/máximo de 50 sugerencias en 24 horas/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByText(/máximo de 50 sugerencias/)).not.toBeInTheDocument();
  });

  it('no se ofrece si el agente no las tiene activadas, si no hay agente, si la ventana de 24 h está cerrada o en modo nota', async () => {
    stubWidth(1440);
    mockApi(server(conv(), AI(false)).routes);
    const first = renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(screen.queryByRole('button', { name: 'Sugerir respuesta' })).not.toBeInTheDocument();
    first.unmount();

    vi.unstubAllGlobals(); resetWorld(); stubWidth(1440);
    mockApi(server(conv(), null).routes);
    const second = renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(screen.queryByRole('button', { name: 'Sugerir respuesta' })).not.toBeInTheDocument();
    second.unmount();

    vi.unstubAllGlobals(); resetWorld(); stubWidth(1440);
    mockApi(server(conv({ window: { open: false, expires_at: null } }), AI(true)).routes);
    const third = renderApp('/inbox/c1');
    await screen.findByRole('button', { name: 'Datos del contacto' });
    expect(screen.queryByRole('button', { name: 'Sugerir respuesta' })).not.toBeInTheDocument();
    third.unmount();

    vi.unstubAllGlobals(); resetWorld(); stubWidth(1440);
    mockApi(server(conv(), AI(true)).routes);
    renderApp('/inbox/c1');
    expect(await screen.findByRole('button', { name: 'Sugerir respuesta' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    expect(screen.queryByRole('button', { name: 'Sugerir respuesta' })).not.toBeInTheDocument();
  });

  it('en el celular está en «Más opciones» como «Sugerir respuesta»', async () => {
    stubWidth(390);
    const s = server(conv(), AI(true));
    mockApi(s.routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más opciones' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Más opciones del mensaje' }));
    await userEvent.click(sheet.getByRole('button', { name: /Sugerir respuesta/ }));
    expect(await screen.findByRole('region', { name: 'Sugerencia de IA' })).toBeInTheDocument();
    expect(s.suggests).toBe(1);
  });
});
