import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDrafts, readDraft } from '../src/features/inbox/draftStore';
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
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over });
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };

function server(c: Conversation = conv()): { routes: Record<string, Handler>; posts: Array<{ path: string; body: unknown }> } {
  const posts: Array<{ path: string; body: unknown }> = [];
  return {
    posts,
    routes: {
      ...authed(ME_ADVISOR),
      'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
      'GET /conversations/options': () => ({ body: OPTIONS }),
      'GET /conversations/c1': () => ({ body: c }),
      'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
      'POST /conversations/c1/read': () => ({ body: c }),
      'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
      'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
      'GET /contacts/k1': () => err(404, 'NOT_FOUND'),
      'POST /conversations/c1/messages': (call: Call) => {
        posts.push({ path: '/conversations/c1/messages', body: call.body });
        return { status: 201, body: msg({ id: 'new', direction: 'out', sender_type: 'human', text: (call.body as { text: string }).text, status: 'sent' }) };
      },
      'POST /conversations/c1/notes': (call: Call) => {
        posts.push({ path: '/conversations/c1/notes', body: call.body });
        return { status: 201, body: msg({ id: 'nota', is_note: true, kind: 'note', text: (call.body as { text: string }).text, status: 'internal' }) };
      },
    },
  };
}

describe('Chat móvil · cabecera y acciones', () => {
  it('cabecera: atrás, nombre, canal y quien atiende, y «⋯» que abre la hoja; sin llamada ni «en línea»', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(chat.getByRole('heading', { name: 'Ana Torres' })).toBeInTheDocument();
    expect(chat.getByText(/Barbería WhatsApp · Luis Navas/)).toBeInTheDocument();
    expect(chat.getByRole('link', { name: 'Volver a las conversaciones' })).toHaveAttribute('href', '/inbox');
    expect(chat.queryByRole('button', { name: /llam/i })).not.toBeInTheDocument();
    expect(chat.queryByText(/en línea/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).not.toBeInTheDocument();
    await userEvent.click(chat.getByRole('button', { name: 'Más acciones' }));
    const sheet = await screen.findByRole('dialog', { name: 'Acciones de la conversación' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    for (const name of ['Ver contacto', 'Transferir o compartir', 'Mensajes programados', 'Finalizar la conversación']) expect(within(sheet).getByRole('button', { name })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Acciones de la conversación' })).not.toBeInTheDocument());
    expect(chat.getByRole('button', { name: 'Más acciones' })).toHaveFocus();
  });

  it('«Ver contacto» abre el contacto a pantalla completa y se cierra con su botón', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver contacto' }));
    const dlg = await screen.findByRole('dialog', { name: 'Datos del contacto' });
    expect(dlg.firstElementChild).toHaveClass('w-full');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cerrar los datos del contacto' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Datos del contacto' })).not.toBeInTheDocument());
  });

  it('con Aceptar y Asignarme disponibles aparecen en la hoja; «Finalizar» pide confirmación', async () => {
    stubWidth(390);
    const c = conv({ status: 'pending', can: { reply: false, note: true, accept: true, take: false, close: true, transfer: false, share: false } });
    mockApi(server(c).routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    const sheet = await screen.findByRole('dialog', { name: 'Acciones de la conversación' });
    expect(within(sheet).getByRole('button', { name: 'Aceptar' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Transferir o compartir' })).not.toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Finalizar la conversación' }));
    expect(within(sheet).getByRole('alertdialog', { name: 'Finalizar la conversación' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'No' }));
    expect(within(sheet).queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('atrás: desde la lista vuelve a la lista; con un enlace directo (sin historia) va a /inbox', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('link', { name: 'Ana Torres' }));
    expect(await screen.findByRole('region', { name: 'Conversación con Ana Torres' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ana Torres' })).not.toHaveAttribute('aria-current'));
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('atrás con un enlace directo a la conversación lleva a la lista', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Ana Torres' })).not.toHaveAttribute('aria-current'));
  });
});

describe('Chat móvil · redactor', () => {
  it('Enter da salto de línea y no envía; el botón alterna entre micrófono (vacío) y enviar (con texto)', async () => {
    stubWidth(390);
    const w = server();
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    await userEvent.type(box, 'hola{Enter}segunda línea');
    expect(box).toHaveValue('hola\nsegunda línea');
    expect(w.posts).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Grabar nota de voz' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'hola\nsegunda línea' } }]));
    expect(box).toHaveValue('');
    expect(await screen.findByRole('button', { name: 'Grabar nota de voz' })).toBeInTheDocument();
  });

  it('«+» abre la hoja con adjuntar, plantillas, respuestas rápidas, programar y nota interna; la nota cambia el redactor y se puede dejar', async () => {
    stubWidth(390);
    const w = server();
    mockApi(w.routes);
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    const sheet = await screen.findByRole('dialog', { name: 'Más opciones del mensaje' });
    for (const name of ['Adjuntar archivo', 'Plantillas', 'Respuestas rápidas', /Programar mensaje/, 'Escribir una nota interna']) expect(within(sheet).getByRole('button', { name })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Programar mensaje/ })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Escribir una nota interna' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Más opciones del mensaje' })).not.toBeInTheDocument());
    expect(screen.getByText('Nota interna · solo la ve tu equipo')).toBeInTheDocument();
    const note = screen.getByRole('textbox', { name: 'Nota interna' });
    expect(note).toBe(box);
    await userEvent.type(note, 'recordar llamar');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nota' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/notes', body: { text: 'recordar llamar' } }]));
    await userEvent.click(screen.getByRole('button', { name: 'Volver a responder' }));
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toBeInTheDocument();
  });

  it('el borrador se conserva al volver a la lista y reabrir; se borra al enviar; otra conversación no lo hereda', async () => {
    stubWidth(390);
    mockApi(server().routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('link', { name: 'Ana Torres' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'a medio escribir');
    expect(readDraft('c1').text).toBe('a medio escribir');
    await userEvent.click(screen.getByRole('link', { name: 'Volver a las conversaciones' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Mensaje' })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('link', { name: 'Ana Torres' }));
    expect(await screen.findByRole('textbox', { name: 'Mensaje' })).toHaveValue('a medio escribir');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(readDraft('c1').text).toBe(''));
    expect(readDraft('otra').text).toBe('');
  });
});

describe('Chat móvil · distribución', () => {
  it('es una pantalla completa fija (sin la tarjeta del escritorio) y con el hilo como único desplazamiento', async () => {
    stubWidth(390);
    mockApi(server().routes);
    const { container } = renderApp('/inbox/c1');
    await screen.findByRole('region', { name: 'Conversación con Ana Torres' });
    const root = container.querySelector('.chat-screen');
    expect(root).not.toBeNull();
    expect(root).toHaveClass('fixed');
    const log = screen.getByRole('log', { name: 'Mensajes' });
    expect(log).toHaveClass('overflow-y-auto', 'overscroll-contain');
  });

  it('el escritorio no usa la pantalla completa y Enter sigue enviando', async () => {
    stubWidth(1440);
    const w = server();
    mockApi(w.routes);
    const { container } = renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(container.querySelector('.chat-screen')).toBeNull();
    await userEvent.type(box, 'hola{Enter}');
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'hola' } }]));
  });
});
