import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { slashAt, suggest } from '../src/features/inbox/Composer';
import type { ChatMessage, Conversation, ConversationList, InboxOptions, QuickReply, QuickReplyList, ResolvedQuickReply } from '../src/lib/types';
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
  participants: [],
  my_access: 'owner',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
  sla: null,
  ...over,
});
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };

const rq = (over: Partial<ResolvedQuickReply> & { shortcut: string }): ResolvedQuickReply => ({
  id: `r-${over.shortcut}`,
  body: over.text ?? 'texto',
  text: 'texto',
  missing: [],
  shared: false,
  mine: true,
  can_edit: true,
  variables: [],
  updated_at: ago(HOUR),
  ...over,
});

const BUILT_IN = [
  { key: 'primer_nombre', label: 'Primer nombre del contacto' },
  { key: 'nombre', label: 'Nombre completo del contacto' },
  { key: 'telefono', label: 'Teléfono del contacto' },
  { key: 'mi_nombre', label: 'Mi nombre (quien escribe)' },
  { key: 'empresa', label: 'Nombre de la empresa' },
];

interface World {
  resolved: ResolvedQuickReply[];
  /** Si es false, el servidor responde 404 a las respuestas rápidas de la conversación. */
  resolvedOk: boolean;
  managed: QuickReply[];
  share: boolean;
  fields: Array<{ id: string; name: string; key: string }>;
  posts: Array<{ method: string; path: string; body: unknown }>;
  onCreate?: (body: { shortcut: string; body: string; shared: boolean }) => ReturnType<Handler>;
}
const world = (over: Partial<World> = {}): World => ({ resolved: [], resolvedOk: true, managed: [], share: false, fields: [], posts: [], ...over });

function server(w: World, me = ME_ADVISOR): Record<string, Handler> {
  const base = authed(me);
  return {
    ...base,
    'GET /custom-fields': () => ({ body: { items: w.fields.map((f) => ({ ...f, entity: 'contact', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: ago(HOUR) })), access: { manage: me === ME_ADMIN } } }),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/quick-replies': () => (w.resolvedOk ? { body: { items: w.resolved } } : err(404, 'NOT_FOUND')),
    'POST /conversations/c1/messages': (call: Call) => {
      w.posts.push({ method: 'POST', path: '/conversations/c1/messages', body: call.body });
      return { status: 201, body: { id: 'm-new', direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, kind: 'text', text: (call.body as { text: string }).text, media: null, extra: null, reaction: null, status: 'sent', error: null, sent_at: new Date().toISOString(), delivered_at: null, read_at: null, is_note: false, template: null } };
    },
    'GET /quick-replies': () => ({ body: { items: w.managed, access: { share: w.share }, built_in_variables: BUILT_IN } satisfies QuickReplyList }),
    'POST /quick-replies': (call: Call) => {
      const body = call.body as { shortcut: string; body: string; shared: boolean };
      w.posts.push({ method: 'POST', path: '/quick-replies', body });
      if (w.onCreate) return w.onCreate(body);
      const created: QuickReply = { id: `new-${w.managed.length}`, shortcut: body.shortcut, body: body.body, shared: body.shared, mine: true, can_edit: true, variables: [], updated_at: new Date().toISOString() };
      w.managed = [...w.managed, created];
      return { status: 201, body: created };
    },
    'PATCH /quick-replies/m1': (call: Call) => {
      w.posts.push({ method: 'PATCH', path: '/quick-replies/m1', body: call.body });
      const cur = w.managed.find((q) => q.id === 'm1')!;
      const next = { ...cur, ...(call.body as Partial<QuickReply>) };
      w.managed = w.managed.map((q) => (q.id === 'm1' ? next : q));
      return { body: next };
    },
    'DELETE /quick-replies/m1': () => {
      w.posts.push({ method: 'DELETE', path: '/quick-replies/m1', body: undefined });
      w.managed = w.managed.filter((q) => q.id !== 'm1');
      return { body: { id: 'm1', deleted: true } };
    },
  };
}

const managed = (over: Partial<QuickReply> & { shortcut: string }): QuickReply => ({ id: 'm1', body: 'Hola {{primer_nombre}}', shared: false, mine: true, can_edit: true, variables: ['primer_nombre'], updated_at: ago(HOUR), ...over });
const box = async (): Promise<HTMLTextAreaElement> => (await screen.findByRole('textbox', { name: 'Mensaje' })) as HTMLTextAreaElement;

describe('slashAt y suggest (puros)', () => {
  it('detecta «/palabra» al abrir el texto o tras un espacio, justo antes del cursor', () => {
    expect(slashAt('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashAt('/Pre', 4)).toEqual({ start: 0, query: 'pre' });
    expect(slashAt('Hola /pre', 9)).toEqual({ start: 5, query: 'pre' });
    expect(slashAt('Hola\n/pre', 9)).toEqual({ start: 5, query: 'pre' });
    expect(slashAt('/pre y más', 4)).toEqual({ start: 0, query: 'pre' }); // el cursor está al final de la palabra
  });
  it('no se activa con barras dentro de una palabra, de un enlace o lejos del cursor', () => {
    expect(slashAt('https://sitio.com/pre', 21)).toBeNull();
    expect(slashAt('a/b', 3)).toBeNull();
    expect(slashAt('/pre y más', 10)).toBeNull();
    expect(slashAt('Hola', 4)).toBeNull();
  });
  it('sugiere primero las que empiezan por lo escrito y luego las que lo contienen, hasta 6', () => {
    const items = ['cita', 'precios', 'repreguntar', 'hola', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((s) => rq({ shortcut: s }));
    expect(suggest(items, 'pre').map((r) => r.shortcut)).toEqual(['precios', 'repreguntar']);
    expect(suggest(items, '').length).toBe(6);
    expect(suggest(items, 'zzz')).toEqual([]);
  });
});

describe('Redactor · respuestas rápidas', () => {
  it('escribir «/» ofrece las respuestas; al elegir una (Enter) se inserta ya resuelta en lugar de «/atajo»', async () => {
    const w = world({ resolved: [rq({ shortcut: 'hola', text: 'Hola Ana, soy Luis de Mi Empresa SA' }), rq({ shortcut: 'precios', text: 'Nuestros precios: corte $10' })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, 'Buenas. /pre');
    const list = await screen.findByRole('listbox', { name: 'Respuestas rápidas' });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByText('/precios')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(input.value).toBe('Buenas. Nuestros precios: corte $10');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(w.posts).toEqual([]); // Enter eligió, no envió
  });

  it('con solo «/» salen todas; las flechas cambian la elegida y Tab inserta; Escape cierra sin insertar', async () => {
    const w = world({ resolved: [rq({ shortcut: 'hola', text: 'Hola Ana' }), rq({ shortcut: 'precios', text: 'Precios' })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/');
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input.value).toBe('/');
    await userEvent.type(input, 'h'); // al seguir escribiendo vuelve a abrirse
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Tab}');
    expect(input.value).toBe('Hola Ana');
  });

  it('un clic en una opción la inserta', async () => {
    mockApi(server(world({ resolved: [rq({ shortcut: 'hola', text: 'Hola Ana' })] })));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/ho');
    await userEvent.click(await screen.findByRole('option', { name: /hola/ }));
    expect(input.value).toBe('Hola Ana');
  });

  it('lo que no se pudo llenar se marca («Falta: ciudad»), queda como {{…}}, avisa y no deja enviar hasta completarlo', async () => {
    const w = world({ resolved: [rq({ shortcut: 'ciudad', text: 'Te escribo desde {{contact.ciudad}}', missing: ['contact.ciudad'] })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/ciudad');
    expect(await screen.findByText('Falta: ciudad')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(input.value).toBe('Te escribo desde {{contact.ciudad}}');
    expect(screen.getByText(/Falta completar \{\{contact\.ciudad\}\}/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(send).toBeDisabled();
    await userEvent.type(input, '{Enter}'); // Enter tampoco envía
    expect(w.posts).toEqual([]);
    // la persona reemplaza la variable por el dato
    fireEvent.change(input, { target: { value: 'Te escribo desde Quito' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    expect(screen.queryByText(/Falta completar/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/conversations/c1/messages', body: { text: 'Te escribo desde Quito' } }]));
  });

  it('lo insertado se envía tal cual con Enter y la caja queda vacía', async () => {
    const w = world({ resolved: [rq({ shortcut: 'hola', text: 'Hola Ana, ¿en qué te ayudo?' })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/hola{Enter}');
    expect(input.value).toBe('Hola Ana, ¿en qué te ayudo?');
    await userEvent.type(input, '{Enter}');
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/conversations/c1/messages', body: { text: 'Hola Ana, ¿en qué te ayudo?' } }]));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('las compartidas llevan su etiqueta; sin coincidencias o sin respuestas se explica', async () => {
    const w = world({ resolved: [rq({ shortcut: 'equipo', text: 'Para todos', shared: true, mine: false })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/');
    expect(await within(await screen.findByRole('listbox')).findByText('Compartida')).toBeInTheDocument();
    await userEvent.type(input, 'zzz');
    expect(await screen.findByText('No hay una respuesta que se llame «/zzz».')).toBeInTheDocument();
  });

  it('sin ninguna respuesta guardada, «/» lo dice y señala dónde crearlas', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await userEvent.type(await box(), '/');
    expect(await screen.findByText(/Aún no tienes respuestas rápidas/)).toBeInTheDocument();
  });

  it('en una nota interna «/» no abre nada', async () => {
    const api = mockApi(server(world({ resolved: [rq({ shortcut: 'hola', text: 'Hola' })] })));
    renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Mensaje' });
    await waitFor(() => expect(api.count('GET /conversations/c1/quick-replies')).toBe(1)); // al abrir el hilo, en modo «Responder»
    await userEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    const note = await screen.findByRole('textbox', { name: 'Nota interna' });
    await userEvent.type(note, '/ho');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(api.count('GET /conversations/c1/quick-replies')).toBe(1); // no se volvió a pedir
  });

  it('si no se pueden cargar las respuestas el redactor sigue funcionando (no hay lista ni error)', async () => {
    mockApi(server(world({ resolvedOk: false })));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, '/ho');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input.value).toBe('/ho');
  });

  it('quien solo mira y deja notas no pide ni ve las respuestas rápidas', async () => {
    const api = mockApi({ ...server(world()), 'GET /conversations/c1': () => ({ body: conv({ my_access: 'collaborator_view', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } }) }) });
    renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Nota interna' });
    expect(screen.queryByRole('button', { name: 'Respuestas rápidas' })).not.toBeInTheDocument();
    expect(api.count('GET /conversations/c1/quick-replies')).toBe(0);
  });
});

describe('Respuestas rápidas · gestión', () => {
  it('desde el Inbox, quien responde abre «Respuestas rápidas», ve las suyas y las compartidas y crea una (el atajo se limpia; sin opción de compartir)', async () => {
    const w = world({ managed: [managed({ id: 'm1', shortcut: 'hola' }), managed({ id: 'm2', shortcut: 'equipo', shared: true, mine: false, can_edit: false, body: 'Para todos' })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Respuestas rápidas' }));
    const dlg = await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
    const rows = await within(dlg).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Solo mía')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Compartida')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Cambiar /hola' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button', { name: /Cambiar|Borrar/ })).not.toBeInTheDocument(); // una compartida ajena no se cambia
    await userEvent.click(within(dlg).getByRole('button', { name: 'Nueva respuesta' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva respuesta rápida' });
    expect(within(form).queryByLabelText(/Compartir con toda la empresa/)).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText(/Atajo/), '/Precios ');
    await userEvent.type(within(form).getByLabelText(/Mensaje/), 'Hola ');
    await userEvent.click(within(form).getByRole('button', { name: 'Insertar Primer nombre del contacto' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Crear respuesta' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/quick-replies', body: { shortcut: 'precios', body: 'Hola {{primer_nombre}}', shared: false } }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva respuesta rápida' })).not.toBeInTheDocument());
    expect(await within(dlg).findByText('/precios')).toBeInTheDocument();
  });

  it('el administrador la comparte con toda la empresa y puede insertar también los campos personalizados', async () => {
    const w = world({ share: true, fields: [{ id: 'f1', name: 'Ciudad', key: 'ciudad' }] });
    mockApi(server(w, ME_ADMIN));
    renderApp('/settings/quick-replies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva respuesta' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva respuesta rápida' });
    await userEvent.type(within(form).getByLabelText(/Atajo/), 'sede');
    await userEvent.type(within(form).getByLabelText(/Mensaje/), 'Estamos en ');
    await userEvent.click(await within(form).findByRole('button', { name: 'Insertar Ciudad' }));
    await userEvent.click(within(form).getByLabelText(/Compartir con toda la empresa/));
    await userEvent.click(within(form).getByRole('button', { name: 'Crear respuesta' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/quick-replies', body: { shortcut: 'sede', body: 'Estamos en {{contact.ciudad}}', shared: true } }]));
  });

  it('valida el atajo y el mensaje sin molestar al servidor', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/quick-replies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva respuesta' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva respuesta rápida' });
    await userEvent.type(within(form).getByLabelText(/Atajo/), 'con espacio');
    await userEvent.click(within(form).getByRole('button', { name: 'Crear respuesta' }));
    expect(await within(form).findByText(/Usa letras sin tilde/)).toBeInTheDocument();
    expect(within(form).getByText('Escribe el mensaje')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
  });

  it('un atajo repetido se marca en su campo y una variable inexistente, en el mensaje', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/quick-replies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva respuesta' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva respuesta rápida' });
    await userEvent.type(within(form).getByLabelText(/Atajo/), 'hola');
    await userEvent.type(within(form).getByLabelText(/Mensaje/), 'Hola');
    w.onCreate = () => err(409, 'QUICK_REPLY_EXISTS', 'Ya tienes una respuesta con ese atajo');
    await userEvent.click(within(form).getByRole('button', { name: 'Crear respuesta' }));
    expect(await within(form).findByText('Ya tienes una respuesta con ese atajo')).toBeInTheDocument();
    w.onCreate = () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Los datos enviados no son válidos', request_id: 'r', details: [{ path: 'body', code: 'unknown_variable', message: 'La variable «{{foo}}» no existe.' }] } } });
    await userEvent.click(within(form).getByRole('button', { name: 'Crear respuesta' }));
    expect(await within(form).findByText('La variable «{{foo}}» no existe.')).toBeInTheDocument();
  });

  it('cambiar una respuesta manda lo editado; borrar pide confirmación', async () => {
    const w = world({ managed: [managed({ id: 'm1', shortcut: 'hola' })] });
    mockApi(server(w));
    renderApp('/settings/quick-replies');
    await userEvent.click(await screen.findByRole('button', { name: 'Cambiar /hola' }));
    const form = await screen.findByRole('dialog', { name: 'Cambiar /hola' });
    const body = within(form).getByLabelText(/Mensaje/);
    await userEvent.clear(body);
    await userEvent.type(body, 'Buenas');
    await userEvent.click(within(form).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'PATCH', path: '/quick-replies/m1', body: { shortcut: 'hola', body: 'Buenas', shared: false } }]));
    await userEvent.click(await screen.findByRole('button', { name: 'Borrar /hola' }));
    const confirm = await screen.findByRole('dialog', { name: 'Borrar /hola' });
    expect(w.posts.some((p) => p.method === 'DELETE')).toBe(false);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Borrar' }));
    await waitFor(() => expect(w.posts.some((p) => p.method === 'DELETE')).toBe(true));
    expect(await screen.findByText(/Aún no tienes respuestas rápidas/)).toBeInTheDocument();
  });

  it('Configuración tiene la pestaña «Respuestas rápidas» para el administrador', async () => {
    mockApi({ ...server(world(), ME_ADMIN), 'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }) });
    renderApp('/settings/quick-replies');
    expect(await screen.findByRole('link', { name: 'Respuestas rápidas' })).toHaveAttribute('href', '/settings/quick-replies');
  });
});
