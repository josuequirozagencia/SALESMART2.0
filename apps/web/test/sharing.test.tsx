import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList, PersonOption, TransferOptions } from '../src/lib/types';
import { authed, err, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const FULL = { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true };

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
  can: FULL,
  sla: null,
  ...over,
});
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, ...over,
});
const person = (id: string, name: string, over: Partial<PersonOption> = {}): PersonOption => ({ id, name, role: 'advisor', open_count: 0, in_queue: true, is_owner: false, is_self: false, collaborator: null, ...over });
const OPTIONS: TransferOptions = {
  items: [person('u2', 'Luis Navas', { is_owner: true, is_self: true, open_count: 4 }), person('u3', 'Carolina Vera', { open_count: 1 }), person('u4', 'Eva Mora', { in_queue: false, open_count: 7 }), person('u1', 'Ana Pérez', { role: 'client_admin' })],
  queue: { id: 'q1', name: 'Ventas' },
  can: { transfer: true, share: true },
};

interface World { conv: Conversation; messages: ChatMessage[]; options: TransferOptions; posts: Array<{ method: string; path: string; body: unknown }>; onTransfer?: () => ReturnType<Handler>; onShare?: () => ReturnType<Handler> }
const world = (over: Partial<World> = {}): World => ({ conv: conv(), messages: [msg()], options: OPTIONS, posts: [], ...over });

function server(w: World) {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [w.conv], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: w.conv }),
    'GET /conversations/c1/messages': () => ({ body: { items: w.messages, next_cursor: null } }),
    'GET /conversations/c1/transfer-options': () => ({ body: w.options }),
    'POST /conversations/c1/transfer': ({ body }) => {
      w.posts.push({ method: 'POST', path: '/conversations/c1/transfer', body });
      if (w.onTransfer) return w.onTransfer();
      return { body: { id: 'c1', status: 'pending', owner: { id: 'u3', name: 'Carolina Vera' }, still_visible: false } };
    },
    'POST /conversations/c1/share': ({ body }) => {
      w.posts.push({ method: 'POST', path: '/conversations/c1/share', body });
      if (w.onShare) return w.onShare();
      const b = body as { user_id: string; permission: 'reply' | 'view' };
      const target = OPTIONS.items.find((p) => p.id === b.user_id)!;
      w.conv = { ...w.conv, participants: [...w.conv.participants, { user: { id: target.id, name: target.name }, permission: b.permission, added_by: { id: 'u2', name: 'Luis Navas' }, added_at: new Date().toISOString() }] };
      return { body: w.conv };
    },
  };
  for (const id of ['u3', 'u4', 'u2']) {
    routes[`DELETE /conversations/c1/participants/${id}`] = () => {
      w.posts.push({ method: 'DELETE', path: `/conversations/c1/participants/${id}`, body: undefined });
      w.conv = { ...w.conv, participants: w.conv.participants.filter((p) => p.user.id !== id) };
      return { body: { id: 'c1', user_id: id, revoked: true, still_visible: id !== 'u2' } };
    };
  }
  return routes;
}

describe('Inbox · transferir', () => {
  it('«Transferir» abre el selector con la carga de cada persona, quién es el dueño y una advertencia si está fuera de la cola', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    expect(await d.findByRole('radio', { name: 'Carolina Vera' })).toBeEnabled();
    expect(d.getByRole('radio', { name: 'Luis Navas' })).toBeDisabled(); // quien la tiene
    expect(d.getByText('Quien la tiene')).toBeInTheDocument();
    expect(d.getByText(/· 7 conversaciones abiertas/)).toBeInTheDocument();
    expect(d.getByText(/· 1 conversación abierta/)).toBeInTheDocument();
    expect(d.getAllByText('Fuera de la cola')).toHaveLength(1);
    expect(d.queryByText(/no está en la cola/)).not.toBeInTheDocument();
    await userEvent.click(d.getByRole('radio', { name: 'Eva Mora' }));
    expect(d.getByText(/Eva Mora no está en la cola «Ventas»\. Puedes continuar/)).toBeInTheDocument(); // advertencia, no bloqueo
    expect(d.getByRole('button', { name: 'Transferir' })).toBeEnabled();
  });

  it('transfiere eligiendo seguir como colaborador y con una nota; si ya no la ve, vuelve a la lista', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    expect(d.getByRole('button', { name: 'Transferir' })).toBeDisabled(); // sin elegir a nadie
    await userEvent.click(await d.findByRole('radio', { name: 'Carolina Vera' }));
    await userEvent.click(d.getByRole('radio', { name: 'Seguir como colaborador: solo ver y dejar notas' }));
    await userEvent.type(d.getByRole('textbox', { name: 'Nota (opcional)' }), 'Es cliente frecuente');
    await userEvent.click(d.getByRole('button', { name: 'Transferir' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/conversations/c1/transfer', body: { to_user_id: 'u3', keep_as: 'view', note: 'Es cliente frecuente' } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Elige una conversación')).toBeInTheDocument(); // ya no la ve: de vuelta a la lista
  });

  it('sin elegir seguir como colaborador no manda `keep_as`; si el servidor rechaza, muestra su motivo y deja el selector abierto', async () => {
    const w = world({ onTransfer: () => err(409, 'ALREADY_OWNER', 'Esa persona ya es quien tiene asignada la conversación') });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    await userEvent.click(await d.findByRole('radio', { name: 'Ana Pérez' }));
    await userEvent.click(d.getByRole('button', { name: 'Transferir' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Esa persona ya es quien tiene asignada la conversación');
    expect(w.posts[0]!.body).toEqual({ to_user_id: 'u1' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('si sigue viéndola (administrador), se queda en la conversación', async () => {
    const w = world({ onTransfer: () => ({ body: { id: 'c1', status: 'pending', owner: { id: 'u3', name: 'Carolina Vera' }, still_visible: true } }) });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    await userEvent.click(await d.findByRole('radio', { name: 'Carolina Vera' }));
    await userEvent.click(d.getByRole('button', { name: 'Transferir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Conversación con Ana Torres' })).toBeInTheDocument();
  });

  it('quien no puede transferir ni compartir no ve el botón', async () => {
    mockApi(server(world({ conv: conv({ can: { ...FULL, transfer: false, share: false } }) })));
    renderApp('/inbox/c1');
    await screen.findByRole('heading', { name: 'Ana Torres' });
    expect(screen.queryByRole('button', { name: 'Transferir' })).not.toBeInTheDocument();
  });
});

describe('Inbox · compartir', () => {
  it('comparte con permiso de responder; la conversación muestra con quién se comparte y la persona se puede quitar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    await userEvent.click(d.getByRole('tab', { name: 'Compartir' }));
    expect(d.queryByRole('radio', { name: 'Seguir como colaborador: puede responder' })).not.toBeInTheDocument();
    await userEvent.click(await d.findByRole('radio', { name: 'Carolina Vera' }));
    expect(d.getByRole('radio', { name: 'Puede responder' })).toBeChecked();
    await userEvent.click(d.getByRole('radio', { name: 'Solo ver y dejar notas' }));
    await userEvent.click(d.getByRole('button', { name: 'Compartir' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'POST', path: '/conversations/c1/share', body: { user_id: 'u3', permission: 'view' } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Compartida con Carolina')).toBeInTheDocument();
    // quitar el acceso desde el mismo selector
    await userEvent.click(screen.getByRole('button', { name: 'Transferir' }));
    const d2 = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    await userEvent.click(await d2.findByRole('button', { name: 'Quitar el acceso de Carolina Vera' }));
    await waitFor(() => expect(w.posts.at(-1)).toEqual({ method: 'DELETE', path: '/conversations/c1/participants/u3', body: undefined }));
    await waitFor(() => expect(d2.queryByRole('region', { name: 'Quién tiene acceso' })).not.toBeInTheDocument());
  });

  it('marca a quien ya participa y muestra el motivo si el servidor rechaza (tope de colaboradores)', async () => {
    const w = world({
      conv: conv({ participants: [{ user: { id: 'u4', name: 'Eva Mora' }, permission: 'reply', added_by: { id: 'u2', name: 'Luis Navas' }, added_at: ago(HOUR) }] }),
      options: { ...OPTIONS, items: OPTIONS.items.map((p) => (p.id === 'u4' ? { ...p, collaborator: 'reply' as const } : p)) },
      onShare: () => err(409, 'PARTICIPANT_LIMIT', 'Una conversación admite hasta 10 colaboradores'),
    });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Transferir' }));
    const d = within(await screen.findByRole('dialog', { name: 'Transferir o compartir' }));
    await userEvent.click(d.getByRole('tab', { name: 'Compartir' }));
    expect(await d.findByText('Ya participa (responde)')).toBeInTheDocument();
    await userEvent.click(d.getByRole('radio', { name: 'Carolina Vera' }));
    await userEvent.click(d.getByRole('button', { name: 'Compartir' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Una conversación admite hasta 10 colaboradores');
    expect(d.getByRole('region', { name: 'Quién tiene acceso' })).toHaveTextContent('Eva Mora');
  });
});

describe('Inbox · como colaborador', () => {
  const asCollaborator = (access: 'collaborator_view' | 'collaborator_reply', over: Partial<Conversation> = {}): Conversation =>
    conv({ owner: { id: 'u9', name: 'Marta Sol' }, my_access: access, can: { reply: access === 'collaborator_reply', note: true, accept: false, take: false, close: false, transfer: false, share: false }, ...over });

  it('en la lista aparece «Compartida»; sin permiso de responder, el redactor lo explica y solo deja notas', async () => {
    mockApi(server(world({ conv: asCollaborator('collaborator_view') })));
    renderApp('/inbox/c1');
    expect(await screen.findByText('Compartida')).toBeInTheDocument();
    expect(await screen.findByText('Te compartieron esta conversación solo para ver y dejar notas: no puedes escribirle al cliente.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Mensaje' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nota interna' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Transferir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).not.toBeInTheDocument();
  });

  it('con permiso de responder escribe, salvo mientras el dueño no acepta (lo explica)', async () => {
    mockApi(server(world({ conv: asCollaborator('collaborator_reply') })));
    renderApp('/inbox/c1');
    expect(await screen.findByRole('textbox', { name: 'Mensaje' })).toBeEnabled();
  });

  it('la conversación pendiente de aceptar no se puede responder todavía', async () => {
    mockApi(server(world({ conv: asCollaborator('collaborator_reply', { status: 'pending', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } }) })));
    renderApp('/inbox/c1');
    expect(await screen.findByText('Marta Sol aún no acepta la conversación: podrás responder cuando lo haga.')).toBeInTheDocument();
  });

  it('«Dejar de participar» quita su propio acceso y vuelve a la lista', async () => {
    const w = world({ conv: asCollaborator('collaborator_view', { participants: [{ user: { id: 'u2', name: 'Luis Navas' }, permission: 'view', added_by: { id: 'u9', name: 'Marta Sol' }, added_at: ago(HOUR) }] }) });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Dejar de participar' }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'DELETE', path: '/conversations/c1/participants/u2', body: undefined }]));
    expect(await screen.findByText('Elige una conversación')).toBeInTheDocument();
  });

  it('los avisos automáticos del traspaso se ven como avisos, distintos de una nota de una persona', async () => {
    const w = world({ messages: [msg(), msg({ id: 'n1', direction: 'out', sender_type: 'system', kind: 'note', is_note: true, status: 'internal', text: 'Luis Navas transfirió la conversación a Carolina Vera.', author: { id: 'u2', name: 'Luis Navas' } }), msg({ id: 'n2', direction: 'out', sender_type: 'human', kind: 'note', is_note: true, status: 'internal', text: 'Prefiere la tarde', author: { id: 'u2', name: 'Luis Navas' } })] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const log = within(await screen.findByRole('log', { name: 'Mensajes' }));
    expect(await log.findByText('Aviso automático')).toBeInTheDocument();
    expect(log.getByText('Luis Navas transfirió la conversación a Carolina Vera.')).toBeInTheDocument();
    expect(log.getByText('Nota interna · Luis Navas')).toBeInTheDocument();
  });
});
