import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  status: 'working',
  unread_count: 0,
  last_message_at: ago(5 * MIN),
  last_inbound_at: ago(HOUR),
  assigned_at: ago(2 * HOUR),
  closed_at: null,
  created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
  owner: { id: 'u2', name: 'Luis Navas' },
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola, ¿tienen cita mañana?', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true },
  ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola, ¿tienen cita mañana?', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, ...over,
});
const out = (id: string, text: string, status: ChatMessage['status'], over: Partial<ChatMessage> = {}): ChatMessage =>
  msg({ id, direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, text, status, ...over });

const OPTIONS: InboxOptions = {
  queues: [{ id: 'q1', name: 'Ventas', color: '#7c5cfa' }, { id: 'q2', name: 'Soporte', color: '#0b7a6b' }],
  channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }],
  owners: [],
  tags: [{ id: 't1', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true }],
};

interface World {
  convs: Conversation[];
  counts: ConversationList['counts'];
  messages: Record<string, ChatMessage[]>;
  options: InboxOptions;
  posts: Array<{ path: string; body: unknown }>;
  /** Respuesta de un envío: por omisión, el mensaje enviado. */
  onReply?: (text: string) => ReturnType<Handler>;
}
function world(over: Partial<World> = {}): World {
  return { convs: [conv()], counts: { working: 1, pending: 0, closed: 0, unread: 0 }, messages: { c1: [msg()] }, options: OPTIONS, posts: [], ...over };
}

/** Servidor del Inbox. mockApi no admite rutas con parámetros: se enrutan por conversación (c1, c2). */
function server(w: World, me = ME_ADVISOR) {
  const routes: Record<string, Handler> = {
    ...authed(me),
    'GET /conversations': () => ({ body: { items: w.convs, next_cursor: null, counts: w.counts } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: w.options }),
  };
  for (const id of ['c1', 'c2', 'c404']) {
    routes[`GET /conversations/${id}`] = () => {
      const c = w.convs.find((x) => x.id === id);
      return c ? { body: c } : err(404, 'NOT_FOUND', 'Recurso no encontrado');
    };
    routes[`GET /conversations/${id}/messages`] = ({ query }) => {
      const all = w.messages[id] ?? [];
      // Dos páginas de prueba: con cursor, lo más antiguo; sin él, lo más reciente
      if (query.get('cursor')) return { body: { items: all.slice(0, 2), next_cursor: null } };
      return { body: { items: all.length > 2 && w.messages['paged'] ? all.slice(2) : all, next_cursor: all.length > 2 && w.messages['paged'] ? 'older' : null } };
    };
    routes[`POST /conversations/${id}/messages`] = (call: Call) => {
      w.posts.push({ path: `/conversations/${id}/messages`, body: call.body });
      if (w.onReply) return w.onReply((call.body as { text: string }).text);
      const sent = out(`new-${w.posts.length}`, (call.body as { text: string }).text, 'sent', { sent_at: new Date().toISOString() });
      w.messages[id] = [...(w.messages[id] ?? []), sent];
      return { status: 201, body: sent };
    };
    routes[`POST /conversations/${id}/notes`] = (call: Call) => {
      w.posts.push({ path: `/conversations/${id}/notes`, body: call.body });
      const note = out(`note-${w.posts.length}`, (call.body as { text: string }).text, 'internal', { kind: 'note', is_note: true, sent_at: new Date().toISOString() });
      w.messages[id] = [...(w.messages[id] ?? []), note];
      return { status: 201, body: note };
    };
    for (const action of ['accept', 'take', 'close', 'read'] as const) {
      routes[`POST /conversations/${id}/${action}`] = () => {
        w.posts.push({ path: `/conversations/${id}/${action}`, body: undefined });
        const next: Partial<Conversation> = action === 'accept' ? { status: 'working', can: { reply: true, note: true, accept: false, take: false, close: true } } : action === 'take' ? { status: 'working', owner: { id: 'u1', name: 'Ana Pérez' }, can: { reply: true, note: true, accept: false, take: false, close: true } } : action === 'close' ? { status: 'closed', closed_at: new Date().toISOString(), can: { reply: false, note: true, accept: false, take: false, close: false } } : { unread_count: 0 };
        w.convs = w.convs.map((c) => (c.id === id ? { ...c, ...next } : c));
        return { body: w.convs.find((c) => c.id === id) };
      };
    }
  }
  for (const m of ['m3', 'm9']) {
    routes[`POST /messages/${m}/retry`] = () => {
      w.posts.push({ path: `/messages/${m}/retry`, body: undefined });
      w.messages['c1'] = (w.messages['c1'] ?? []).map((x) => (x.id === m ? { ...x, status: 'sent', error: null } : x));
      return { body: w.messages['c1']!.find((x) => x.id === m) };
    };
  }
  return routes;
}

describe('Inbox · listado', () => {
  it('la sección «Inbox» está en el menú y lleva a /inbox', async () => {
    mockApi(server(world()));
    renderApp('/inbox');
    expect(await screen.findByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/inbox');
    expect(await screen.findByText('Elige una conversación')).toBeInTheDocument();
  });

  it('cada conversación muestra contacto, último mensaje, no leídos, estado, cola, responsable y etiquetas; las pestañas traen sus conteos', async () => {
    const w = world({
      convs: [
        conv({ id: 'c1', unread_count: 3, tags: [{ id: 't1', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true }] }),
        conv({ id: 'c2', status: 'waiting', contact: { id: 'k2', name: 'Bruno Díaz', phone: '+593984000002' }, last_message: { direction: 'out', kind: 'text', preview: 'Te espero a las 3', status: 'sent', at: ago(HOUR) }, owner: null, queue: null }),
      ],
      counts: { working: 2, pending: 5, closed: 7, unread: 1 },
    });
    mockApi(server(w));
    renderApp('/inbox');
    const a = within(await screen.findByRole('link', { name: 'Ana Torres, 3 sin leer' }));
    expect(a.getByText('Hola, ¿tienen cita mañana?')).toBeInTheDocument();
    expect(a.getByText('Trabajando')).toBeInTheDocument();
    expect(a.getByText('Ventas')).toBeInTheDocument();
    expect(a.getByText('Luis')).toBeInTheDocument();
    expect(a.getByText('Lead')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ana Torres, 3 sin leer' })).toHaveAttribute('href', '/inbox/c1');
    const b = within(screen.getByRole('link', { name: 'Bruno Díaz' }));
    expect(b.getByText('Esperando al cliente')).toBeInTheDocument();
    expect(b.getByText('Te espero a las 3')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Trabajando\s*2/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Pendientes\s*5/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Finalizadas\s*7/ })).toBeInTheDocument();
  });

  it('cambiar de pestaña, buscar y filtrar piden al servidor justo eso', async () => {
    const w = world({ options: { ...OPTIONS, owners: [{ id: 'u2', name: 'Luis Navas' }] } });
    const api = mockApi(server(w, ME_ADMIN));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    expect(api.last('GET /conversations')!.query.get('tab')).toBe('working');
    await userEvent.click(screen.getByRole('tab', { name: /Pendientes/ }));
    await waitFor(() => expect(api.last('GET /conversations')!.query.get('tab')).toBe('pending'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar conversaciones' }), 'ana');
    await waitFor(() => expect(api.last('GET /conversations')!.query.get('q')).toBe('ana'));
    await userEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Responsable' }), 'u2');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Cola' }), 'q2');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Solo no leídas' }));
    await waitFor(() => {
      const q = api.last('GET /conversations')!.query;
      expect([q.get('tab'), q.get('q'), q.get('owner'), q.get('queue'), q.get('unread')]).toEqual(['pending', 'ana', 'u2', 'q2', '1']);
    });
    expect(screen.getByRole('button', { name: /Filtros\s*3/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => {
      const q = api.last('GET /conversations')!.query;
      expect([q.get('owner'), q.get('queue'), q.get('unread'), q.get('q')]).toEqual([null, null, null, 'ana']);
    });
  });

  it('quien no ve todo no tiene el filtro de responsable', async () => {
    mockApi(server(world(), ME_ADVISOR));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    await userEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    expect(await screen.findByRole('combobox', { name: 'Cola' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Responsable' })).not.toBeInTheDocument();
  });

  it('sin conversaciones explica por qué según la pestaña, y si hay filtros lo dice', async () => {
    const w = world({ convs: [], counts: { working: 0, pending: 0, closed: 0, unread: 0 } });
    mockApi(server(w));
    renderApp('/inbox');
    expect(await screen.findByText('No tienes conversaciones en curso.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Finalizadas/ }));
    expect(await screen.findByText('Aún no hay conversaciones finalizadas.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar conversaciones' }), 'zzz');
    expect(await screen.findByText('No hay conversaciones con estos filtros.')).toBeInTheDocument();
  });

  it('un error al cargar se muestra con «Reintentar»', async () => {
    const routes = server(world());
    let fail = true;
    routes['GET /conversations'] = () => (fail ? err(500, 'INTERNAL') : { body: { items: [conv()], next_cursor: null, counts: null } });
    mockApi(routes);
    renderApp('/inbox');
    expect(await screen.findByText(/No pudimos cargar las conversaciones|Tuvimos un problema/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('link', { name: 'Ana Torres' })).toBeInTheDocument();
  });
});

describe('Inbox · hilo', () => {
  it('muestra el encabezado, los mensajes con su estado de envío, las notas internas y los separadores de día', async () => {
    const w = world({
      messages: {
        c1: [
          msg({ id: 'm0', text: 'Mensaje de ayer', sent_at: ago(30 * HOUR) }),
          msg({ id: 'm1', text: 'Hola, ¿tienen cita mañana?', sent_at: ago(20 * MIN) }),
          out('m2', 'Claro que sí', 'delivered', { sent_at: ago(15 * MIN) }),
          out('m4', 'Leído por el cliente', 'read', { sent_at: ago(14 * MIN) }),
          out('m5', 'Aún enviándose', 'queued', { sent_at: ago(13 * MIN) }),
          out('m6', 'Recordar el descuento', 'internal', { kind: 'note', is_note: true, sent_at: ago(12 * MIN) }),
          msg({ id: 'm7', kind: 'image', text: null, media: { mime_type: 'image/jpeg', filename: null }, sent_at: ago(11 * MIN) }),
          msg({ id: 'm8', kind: 'location', text: null, extra: { location: { name: 'Local', address: 'Av. 9 de Octubre' } }, sent_at: ago(10 * MIN) }),
        ],
      },
    });
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByRole('heading', { name: 'Ana Torres' })).toBeInTheDocument();
    expect(screen.getByText(/\+593984217730 · Barbería WhatsApp · Ventas/)).toBeInTheDocument();
    expect(screen.getByText('Asignada a Luis Navas')).toBeInTheDocument();
    const log = within(await screen.findByRole('log', { name: 'Mensajes' }));
    expect(await log.findByText('Claro que sí')).toBeInTheDocument();
    expect(log.getByText('Ayer')).toBeInTheDocument();
    expect(log.getByText('Hoy')).toBeInTheDocument();
    expect(log.getByRole('img', { name: 'Entregado' })).toBeInTheDocument();
    expect(log.getByRole('img', { name: 'Leído' })).toBeInTheDocument();
    expect(log.getByRole('img', { name: 'Enviando' })).toBeInTheDocument();
    expect(log.getByText(/Nota interna · Luis Navas/)).toBeInTheDocument();
    expect(log.getByText('Recordar el descuento')).toBeInTheDocument();
    expect(log.getByText('Imagen')).toBeInTheDocument();
    expect(log.getByText('El archivo aún no se puede ver aquí.')).toBeInTheDocument();
    expect(log.getByText('Av. 9 de Octubre', { exact: false })).toBeInTheDocument();
    // la nota no lleva marca de envío
    expect(log.getAllByRole('img').map((x) => x.getAttribute('aria-label'))).toEqual(['Entregado', 'Leído', 'Enviando']);
  });

  it('la reacción del cliente a un mensaje se ve sobre ese mensaje, en el nuestro y en el suyo, y sin reacción no aparece nada', async () => {
    const w = world({ messages: { c1: [msg({ id: 'm1', text: 'Mensaje del cliente', reaction: '\u{2764}\u{FE0F}' }), out('m2', 'Respuesta nuestra', 'delivered', { reaction: '\u{1F44D}' }), out('m3', 'Sin reacción', 'sent')] } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const log = within(await screen.findByRole('log', { name: 'Mensajes' }));
    expect(await log.findByRole('img', { name: 'Reacción del cliente: \u{2764}\u{FE0F}' })).toBeInTheDocument();
    expect(log.getByRole('img', { name: 'Reacción del cliente: \u{1F44D}' })).toBeInTheDocument();
    expect(log.getAllByRole('img').filter((x) => x.getAttribute('aria-label')?.startsWith('Reacción'))).toHaveLength(2);
  });

  it('un mensaje fallido muestra por qué y se puede reintentar', async () => {
    const w = world({ messages: { c1: [msg(), out('m3', 'No salió', 'failed', { error: 'WhatsApp rechazó el mensaje' })] } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByText('WhatsApp rechazó el mensaje')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'No se pudo enviar' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(w.posts.map((p) => p.path)).toContain('/messages/m3/retry'));
    await waitFor(() => expect(screen.queryByText('WhatsApp rechazó el mensaje')).not.toBeInTheDocument());
  });

  it('quien no puede responder no ve «Reintentar» en un mensaje fallido', async () => {
    const w = world({ convs: [conv({ can: { reply: false, note: true, accept: false, take: false, close: true } })], messages: { c1: [out('m3', 'No salió', 'failed', { error: 'WhatsApp rechazó el mensaje' })] } });
    mockApi(server(w, ME_ADMIN));
    renderApp('/inbox/c1');
    expect(await screen.findByText('WhatsApp rechazó el mensaje')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('carga los mensajes anteriores por páginas', async () => {
    const all = [msg({ id: 'a1', text: 'Muy antiguo 1' }), msg({ id: 'a2', text: 'Muy antiguo 2' }), msg({ id: 'a3', text: 'Reciente' })];
    const w = world({ messages: { c1: all, paged: [] } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByText('Reciente')).toBeInTheDocument();
    expect(screen.queryByText('Muy antiguo 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cargar mensajes anteriores' }));
    expect(await screen.findByText('Muy antiguo 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cargar mensajes anteriores' })).not.toBeInTheDocument();
  });

  it('una conversación que no existe o no se puede ver dice eso y lleva de vuelta a la lista', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c404');
    expect(await screen.findByText('Esa conversación no existe o no tienes acceso a ella.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver conversaciones' })).toHaveAttribute('href', '/inbox');
  });

  it('al abrir una conversación propia con mensajes sin leer, la marca como leída (una sola vez)', async () => {
    const w = world({ convs: [conv({ unread_count: 2 })] });
    const api = mockApi(server(w));
    renderApp('/inbox/c1');
    await waitFor(() => expect(w.posts.map((p) => p.path)).toEqual(['/conversations/c1/read']));
    await screen.findByRole('log', { name: 'Mensajes' });
    expect(api.count('POST /conversations/c1/read')).toBe(1);
  });

  it('si la conversación es de otra persona, no la marca como leída', async () => {
    const w = world({ convs: [conv({ unread_count: 2, owner: { id: 'u9', name: 'Marta Sol' }, can: { reply: false, note: true, accept: false, take: false, close: true } })] });
    const api = mockApi(server(w, ME_ADMIN));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    expect(api.count('POST /conversations/c1/read')).toBe(0);
  });
});

describe('Inbox · responder y notas', () => {
  it('Enter envía el mensaje y limpia el campo; Mayús+Enter da un salto de línea', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.type(box, 'Hola Ana{Shift>}{Enter}{/Shift}te espero');
    expect(box).toHaveValue('Hola Ana\nte espero');
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'Hola Ana\nte espero' } }]));
    await waitFor(() => expect(box).toHaveValue(''));
    expect(await screen.findByText(/Hola Ana\s+te espero/)).toBeInTheDocument();
  });

  it('el botón Enviar está apagado sin texto y no manda espacios en blanco', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const send = await screen.findByRole('button', { name: 'Enviar' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Mensaje' }), '   ');
    expect(send).toBeDisabled();
    expect(w.posts).toEqual([]);
  });

  it('un mensaje que el servidor deja fallido se ve fallido, con su explicación', async () => {
    const w = world();
    w.onReply = (text) => {
      const failed = out('m9', text, 'failed', { error: 'WhatsApp no pudo entregar el mensaje a este número', sent_at: new Date().toISOString() });
      w.messages['c1'] = [...(w.messages['c1'] ?? []), failed];
      return { status: 201, body: failed };
    };
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'Hola{Enter}');
    expect(await screen.findByText('WhatsApp no pudo entregar el mensaje a este número')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('si el servidor rechaza el envío (ventana cerrada) muestra su motivo y conserva el texto', async () => {
    const w = world({ onReply: () => err(409, 'WINDOW_CLOSED', 'Pasaron más de 24 horas desde el último mensaje del cliente') });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    await userEvent.type(box, 'Hola{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Pasaron más de 24 horas desde el último mensaje del cliente');
    expect(box).toHaveValue('Hola');
  });

  it('la nota interna se escribe aparte: sale por /notes, se ve como nota y nunca como mensaje', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Nota interna' }));
    const box = screen.getByRole('textbox', { name: 'Nota interna' });
    await userEvent.type(box, 'Prefiere la tarde');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nota' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/notes', body: { text: 'Prefiere la tarde' } }]));
    expect(await screen.findByText(/Nota interna · Luis Navas/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(screen.getByRole('textbox', { name: 'Mensaje' })).toBeInTheDocument();
  });

  const closedWindow = { open: false, expires_at: ago(HOUR) };
  const cases: Array<[string, Partial<Conversation>, RegExp, boolean]> = [
    ['la ventana de 24 h cerrada', { window: closedWindow }, /Pasaron más de 24 horas/, true],
    ['una conversación finalizada', { status: 'closed', can: { reply: false, note: true, accept: false, take: false, close: false } }, /está finalizada/, true],
    ['una conversación sin asesor (quien puede tomarla)', { status: 'unassigned', owner: null, can: { reply: false, note: true, accept: false, take: true, close: true } }, /Asígnatela para poder responder/, true],
    ['una conversación de otra persona', { owner: { id: 'u9', name: 'Marta Sol' }, can: { reply: false, note: true, accept: false, take: false, close: true } }, /Solo Marta Sol puede responder/, true],
    ['la conexión desactivada', { channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'disabled' }, can: { reply: false, note: true, accept: false, take: false, close: true } }, /desactivada o desconectada/, true],
  ];
  it.each(cases)('con %s no se puede escribir al cliente, se explica por qué y solo quedan las notas', async (_label, over, reason, noteOnly) => {
    const w = world({ convs: [conv(over)] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Mensaje' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nota interna' })).toBeEnabled();
    expect(noteOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
  });

  it('quien no puede escribir nada (solo lectura) ve el motivo y ningún redactor', async () => {
    const w = world({ convs: [conv({ can: { reply: false, note: false, accept: false, take: false, close: false } })] });
    mockApi(server(w, ME_ADMIN));
    renderApp('/inbox/c1');
    expect(await screen.findByText(/Solo Luis Navas puede responder/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('Inbox · acciones', () => {
  it('«Aceptar» acepta la conversación pendiente y pasa a trabajando', async () => {
    const w = world({ convs: [conv({ status: 'pending', can: { reply: true, note: true, accept: true, take: false, close: true } })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    await waitFor(() => expect(w.posts.map((p) => p.path)).toContain('/conversations/c1/accept'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Aceptar' })).not.toBeInTheDocument());
    expect(screen.getAllByText('Trabajando').length).toBeGreaterThan(0);
  });

  it('«Asignarme» toma una conversación sin asignar', async () => {
    const w = world({ convs: [conv({ status: 'unassigned', owner: null, can: { reply: false, note: true, accept: false, take: true, close: true } })] });
    mockApi(server(w, ME_ADMIN));
    renderApp('/inbox/c1');
    expect(screen.queryByRole('button', { name: 'Aceptar' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Asignarme' }));
    await waitFor(() => expect(w.posts.map((p) => p.path)).toContain('/conversations/c1/take'));
    expect(await screen.findByText('Asignada a Ana Pérez')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Mensaje' })).toBeInTheDocument();
  });

  it('«Finalizar» pide confirmación antes de cerrar; «No» la cancela', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Finalizar' }));
    expect(screen.getByText(/Si el cliente escribe de nuevo se abrirá otra conversación/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(w.posts).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Finalizar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, finalizar' }));
    await waitFor(() => expect(w.posts.map((p) => p.path)).toContain('/conversations/c1/close'));
    expect(await screen.findByText(/está finalizada/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).not.toBeInTheDocument();
  });

  it('si el servidor rechaza una acción (409), muestra su motivo', async () => {
    const w = world({ convs: [conv({ status: 'pending', can: { reply: true, note: true, accept: true, take: false, close: true } })] });
    const routes = server(w);
    routes['POST /conversations/c1/accept'] = () => err(409, 'CONVERSATION_STATE', 'La conversación no está pendiente de aceptar');
    mockApi(routes);
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Aceptar' }));
    expect(await screen.findByText('La conversación no está pendiente de aceptar')).toBeInTheDocument();
  });

  it('el aviso de la ventana de 24 h cuenta cuánto queda o dice que se cerró', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByText(/Puedes escribir libremente: quedan 2\d h/)).toBeInTheDocument();
  });

  it('la ventana cerrada se avisa también en el encabezado', async () => {
    const w = world({ convs: [conv({ window: { open: false, expires_at: ago(HOUR) } })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    expect(await screen.findByText('Ventana de 24 h cerrada')).toBeInTheDocument();
  });
});
