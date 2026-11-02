import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionAt, mentionIdsIn, splitMentions, suggestMentions } from '../src/features/inbox/mentions';
import type { AppNotification, ChatMessage, Conversation, ConversationList, InboxOptions, MentionOption, NotificationPage } from '../src/lib/types';
import { lastSocket, sockets } from './fake-socket';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// F1 — Menciones «@» en notas internas y campana de avisos (ADR-57).
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); sockets.length = 0; try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe('mentions · funciones puras', () => {
  it('la «@» se detecta al inicio o tras un espacio, no dentro de un correo, y trae lo escrito después', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('Hola @ca', 8)).toEqual({ start: 5, query: 'ca' });
    expect(mentionAt('escríbeme a ana@correo.com', 26)).toBeNull();
    expect(mentionAt('Hola @Carolina Vera', 19)).toBeNull(); // ya hay un espacio después del nombre: otra palabra
    expect(mentionAt('Hola @ca y más', 8)).toEqual({ start: 5, query: 'ca' }); // solo cuenta lo anterior al cursor
  });

  it('sugiere por el inicio de cualquier palabra del nombre, sin tildes ni mayúsculas, y conserva el orden', () => {
    const items: MentionOption[] = [{ id: 'a', name: 'Álvaro Mora', can_view: true }, { id: 'b', name: 'María Álvarez', can_view: true }, { id: 'c', name: 'Beto Luna', can_view: false }];
    expect(suggestMentions(items, '').map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(suggestMentions(items, 'alva').map((o) => o.id)).toEqual(['a', 'b']);
    expect(suggestMentions(items, 'LUN').map((o) => o.id)).toEqual(['c']);
    expect(suggestMentions(items, 'zz')).toEqual([]);
  });

  it('solo se avisa a quien sigue mencionado en el texto', () => {
    const picked = [{ id: 'u3', name: 'Carolina Vera' }, { id: 'u4', name: 'Eva Mora' }];
    expect(mentionIdsIn('@Carolina Vera mira esto', picked)).toEqual(['u3']);
    expect(mentionIdsIn('mira esto', picked)).toEqual([]);
    expect(mentionIdsIn('@Carolina Vera y @Eva Mora', picked)).toEqual(['u3', 'u4']);
  });

  it('parte el texto marcando las menciones, la más larga primero', () => {
    expect(splitMentions('Hola @Ana María, ¿ves esto? @Ana', [{ name: 'Ana' }, { name: 'Ana María' }])).toEqual([
      { text: 'Hola ', mention: false },
      { text: '@Ana María', mention: true },
      { text: ', ¿ves esto? ', mention: false },
      { text: '@Ana', mention: true },
    ]);
    expect(splitMentions('Sin menciones', [])).toEqual([{ text: 'Sin menciones', mention: false }]);
    expect(splitMentions('Un correo a@b.com', [{ name: 'Beto (x)' }])).toEqual([{ text: 'Un correo a@b.com', mention: false }]);
  });
});

const conv = (): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null,
});
const noteMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'n1', direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, kind: 'note', text: '@Carolina Vera mira esto', media: null, extra: null, reaction: null, my_reaction: null,
  status: 'internal', error: null, sent_at: ago(MIN), delivered_at: null, read_at: null, is_note: true, template: null, attachment: null, mentions: [], ...over,
});
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const PEOPLE: MentionOption[] = [{ id: 'u3', name: 'Carolina Vera', can_view: true }, { id: 'u4', name: 'Eva Mora', can_view: false }];

describe('Inbox · notas con menciones', () => {
  interface World { messages: ChatMessage[]; notes: unknown[]; people: MentionOption[] }
  const server = (w: World): Record<string, Handler> => ({
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: w.messages, next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /conversations/c1/mention-options': () => ({ body: { items: w.people } }),
    'POST /conversations/c1/notes': (call: Call) => {
      w.notes.push(call.body);
      return { status: 201, body: noteMsg() };
    },
  });
  const world = (over: Partial<World> = {}): World => ({ messages: [], notes: [], people: PEOPLE, ...over });
  const openNote = async (w: World): Promise<HTMLTextAreaElement> => {
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Nota interna' }));
    return screen.findByRole('textbox', { name: 'Nota interna' }) as Promise<HTMLTextAreaElement>;
  };

  it('«@» abre la lista de personas; quien aún no ve la conversación sale desactivado con su pista y no se puede elegir', async () => {
    const w = world();
    const box = await openNote(w);
    await userEvent.type(box, '@');
    const list = within(await screen.findByRole('listbox', { name: 'Personas a mencionar' }));
    expect(list.getAllByRole('option').map((o) => o.textContent)).toEqual(['@Carolina Vera', '@Eva MoraNo ve esta conversación: compártela primero']);
    const eva = list.getByRole('option', { name: /Eva Mora/ });
    expect(eva).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(eva);
    expect(box).toHaveValue('@'); // no se puede elegir
    expect(screen.getByRole('listbox', { name: 'Personas a mencionar' })).toBeInTheDocument();
  });

  it('filtra al escribir, Enter elige y la nota se guarda con la persona mencionada; quitar la mención del texto la deja fuera', async () => {
    const w = world();
    const box = await openNote(w);
    await userEvent.type(box, 'Mira esto @ca');
    expect(within(await screen.findByRole('listbox', { name: 'Personas a mencionar' })).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('Mira esto @Carolina Vera ');
    expect(screen.queryByRole('listbox', { name: 'Personas a mencionar' })).not.toBeInTheDocument();
    await userEvent.type(box, 'revisa el descuento');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nota' }));
    await waitFor(() => expect(w.notes).toEqual([{ text: 'Mira esto @Carolina Vera revisa el descuento', mentions: ['u3'] }]));
    // otra nota: elige y luego borra la mención → el servidor no recibe `mentions`
    await userEvent.type(box, '@');
    await userEvent.keyboard('{Enter}');
    await userEvent.clear(box);
    await userEvent.type(box, 'ya no la nombro');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nota' }));
    await waitFor(() => expect(w.notes.at(-1)).toEqual({ text: 'ya no la nombro' }));
  });

  it('con las flechas se recorre la lista y Esc la cierra sin cambiar lo escrito', async () => {
    const w = world();
    const box = await openNote(w);
    await userEvent.type(box, '@');
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Personas a mencionar' })).not.toBeInTheDocument();
    expect(box).toHaveValue('@');
  });

  it('un correo no abre la lista y sin nadie a quien mencionar lo dice', async () => {
    const w = world({ people: [] });
    const box = await openNote(w);
    await userEvent.type(box, 'escríbele a ana@correo.com');
    expect(screen.queryByRole('listbox', { name: 'Personas a mencionar' })).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, '@');
    expect(await screen.findByText('No hay otras personas en el equipo a quienes mencionar.')).toBeInTheDocument();
  });

  it('en modo «Responder» la «@» no abre nada (las menciones son solo de notas internas)', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.type(box, '@');
    expect(screen.queryByRole('listbox', { name: 'Personas a mencionar' })).not.toBeInTheDocument();
  });

  it('en el hilo, la persona mencionada se resalta en la nota', async () => {
    mockApi(server(world({ messages: [noteMsg({ mentions: [{ user_id: 'u3', name: 'Carolina Vera' }] })] })));
    renderApp('/inbox/c1');
    const mark = await screen.findByText('@Carolina Vera');
    expect(mark.tagName).toBe('MARK');
  });
});

const notice = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'a1', type: 'mention', created_at: ago(5 * MIN), read_at: null, actor: { id: 'u3', name: 'Carolina Vera' }, conversation: { id: 'c1', contact: { id: 'k1', name: 'Ana Torres' } }, message_id: 'm1', excerpt: 'Alicia, ¿puedes aprobar el descuento?', ...over,
});

describe('campana de avisos', () => {
  interface World { items: AppNotification[]; marked: string[]; readAll: number; fail: boolean }
  const world = (over: Partial<World> = {}): World => ({ items: [notice(), notice({ id: 'a2', read_at: ago(MIN), excerpt: 'Ya lo vi' }), notice({ id: 'a3', excerpt: 'Otra más' })], marked: [], readAll: 0, fail: false, ...over });
  const unread = (w: World): number => w.items.filter((n) => n.read_at === null).length;
  const server = (w: World, me = ME_ADVISOR): Record<string, Handler> => ({
    ...authed(me),
    'GET /notifications': (call: Call) => {
      if (w.fail) return err(403, 'FORBIDDEN');
      const only = call.query.get('unread') === '1';
      const items = only ? w.items.filter((n) => n.read_at === null) : w.items;
      return { body: { items: items.slice(0, Number(call.query.get('limit') ?? 25)), next_cursor: null, unread: call.query.get('cursor') ? null : unread(w) } satisfies NotificationPage };
    },
    'POST /notifications/read-all': () => {
      w.readAll += 1;
      w.items = w.items.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }));
      return { body: { updated: 2 } };
    },
    'POST /notifications/a1/read': () => {
      w.marked.push('a1');
      w.items = w.items.map((n) => (n.id === 'a1' ? { ...n, read_at: new Date().toISOString() } : n));
      return { body: { id: 'a1', read_at: new Date().toISOString() } };
    },
    'GET /conversations': () => ({ body: { items: [], next_cursor: null, counts: { working: 0, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /conversations/c1/mention-options': () => ({ body: { items: [] } }),
  });

  it('muestra el contador de no leídos y el panel con quién mencionó a la persona, el extracto y la hora', async () => {
    mockApi(server(world()));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (2 sin leer)' }));
    const d = within(await screen.findByRole('dialog', { name: 'Avisos' }));
    expect(await d.findByText('2 sin leer')).toBeInTheDocument();
    const list = within(await d.findByRole('list', { name: 'Avisos' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(list.getAllByText('Carolina Vera te mencionó en una nota de la conversación con Ana Torres')).toHaveLength(3);
    expect(list.getByText('Alicia, ¿puedes aprobar el descuento?')).toBeInTheDocument();
    expect(list.getAllByRole('img', { name: 'Sin leer' })).toHaveLength(2);
  });

  it('abrir un aviso sin leer lo marca como leído y lleva a su conversación; uno ya leído no se vuelve a marcar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (2 sin leer)' }));
    const list = within(await screen.findByRole('list', { name: 'Avisos' }));
    await userEvent.click(list.getByRole('link', { name: /Ya lo vi/ }));
    expect(w.marked).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Avisos' })).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: /^Avisos/ }));
    await userEvent.click(within(await screen.findByRole('list', { name: 'Avisos' })).getByRole('link', { name: /Alicia, ¿puedes aprobar/ }));
    await waitFor(() => expect(w.marked).toEqual(['a1']));
    expect(await screen.findByRole('log', { name: 'Mensajes' })).toBeInTheDocument(); // abrió la conversación
  });

  it('«Marcar todo como leído» deja el contador en 0', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (2 sin leer)' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Marcar todo como leído' }));
    await waitFor(() => expect(w.readAll).toBe(1));
    expect(await screen.findByText('Estás al día.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar todo como leído' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Avisos' })).toBeInTheDocument());
  });

  it('sin avisos lo explica; si la persona no puede verlos, la campana no aparece', async () => {
    mockApi(server(world({ items: [] })));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos' }));
    expect(await screen.findByText(/Todavía no tienes avisos/)).toBeInTheDocument();
    cleanup();
    mockApi(server(world({ fail: true })));
    renderApp('/');
    await screen.findByRole('link', { name: 'Inbox' });
    expect(screen.queryByRole('button', { name: /^Avisos/ })).not.toBeInTheDocument();
  });

  it('«Ver como» ve los avisos pero no puede marcarlos como leídos', async () => {
    mockApi(server(world(), { ...ME_ADMIN, viewing_as: 'advisor', read_only: true }));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (2 sin leer)' }));
    expect(await screen.findByText('2 sin leer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar todo como leído' })).not.toBeInTheDocument();
  });

  it('un aviso en vivo vuelve a pedir los avisos', async () => {
    const w = world({ items: [] });
    const api = mockApi(server(w));
    renderApp('/');
    await screen.findByRole('button', { name: 'Avisos' });
    const before = api.count('GET /notifications');
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    w.items = [notice()];
    lastSocket().fire('notification.created', { data: { notification_id: 'a1' } });
    expect(await screen.findByRole('button', { name: 'Avisos (1 sin leer)' })).toBeInTheDocument();
    expect(api.count('GET /notifications')).toBeGreaterThan(before);
  });
});
