import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDrafts } from '../src/features/inbox/draftStore';
import { compactSpan } from '../src/features/inbox/inboxFormat';
import type { ChatMessage, ContactTag, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, err, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v13 · S1 — Inbox en móvil: «Aceptar» en la fila, icono de etiquetas en la cabecera, filas más altas, cronómetro de icono + tiempo y redactor con «mantener pulsado».

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
  vi.useRealTimers();
  resetWorld();
  clearDrafts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over });
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const tag = (id: string, name: string, color = '#4f46e5'): ContactTag => ({ id, name, color, system_key: null, is_system: false });
const SYSTEM: ContactTag = { id: 'sys', name: 'Venta', color: '#d97706', system_key: 'sale', is_system: true };

interface World { conv: Conversation; tags: ContactTag[]; manage: boolean; posts: Array<{ path: string; body: unknown }>; patches: unknown[] }
const world = (over: Partial<World> = {}): World => ({ conv: conv(), tags: [], manage: false, posts: [], patches: [], ...over });

function server(w: World, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [w.conv], next_cursor: null, counts: { working: 1, pending: 1, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: w.conv }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'POST /conversations/c1/read': () => ({ body: w.conv }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /contacts/k1': () => err(404, 'NOT_FOUND'),
    'GET /tags': () => ({ body: { items: w.tags, access: { manage: w.manage } } }),
    'PATCH /contacts/k1': (call: Call) => {
      w.patches.push(call.body);
      const ids = (call.body as { tag_ids: string[] }).tag_ids;
      w.conv = { ...w.conv, tags: [...w.conv.tags.filter((t) => t.is_system), ...w.tags.filter((t) => ids.includes(t.id))] };
      return { body: { id: 'k1' } };
    },
    'POST /conversations/c1/accept': () => {
      w.posts.push({ path: '/conversations/c1/accept', body: null });
      w.conv = { ...w.conv, status: 'working', can: { ...w.conv.can, accept: false } };
      return { body: w.conv };
    },
    'POST /conversations/c1/messages': (call: Call) => {
      w.posts.push({ path: '/conversations/c1/messages', body: call.body });
      return { status: 201, body: msg({ id: 'new', direction: 'out', sender_type: 'human', text: (call.body as { text: string }).text, status: 'sent' }) };
    },
    ...extra,
  };
}

describe('S1.1 · «Aceptar» en la fila de la lista (móvil)', () => {
  const pending = (): World => world({ conv: conv({ status: 'pending', can: { reply: true, note: true, accept: true, take: false, close: true, transfer: true, share: true } }) });

  it('una conversación por aceptar muestra «Aceptar» a la derecha de la fila; tocarlo la acepta sin abrir el chat y avisa', async () => {
    stubWidth(390);
    const w = pending();
    mockApi(server(w));
    renderApp('/inbox');
    const btn = await screen.findByRole('button', { name: 'Aceptar la conversación de Ana Torres' });
    expect(btn).toHaveTextContent('Aceptar');
    await userEvent.click(btn);
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/accept', body: null }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Aceptaste la conversación de Ana Torres');
    // no se abrió el chat
    expect(screen.queryByRole('region', { name: /Conversación con/ })).not.toBeInTheDocument();
    // y la fila ya no ofrece «Aceptar»
    await waitFor(() => expect(screen.queryByRole('button', { name: /Aceptar la conversación/ })).not.toBeInTheDocument());
  });

  it('si el servidor lo rechaza, la fila sigue ahí y se explica por qué', async () => {
    stubWidth(390);
    const w = pending();
    mockApi(server(w, { 'POST /conversations/c1/accept': () => err(409, 'CONVERSATION_STATE', 'La conversación ya no está pendiente') }));
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('button', { name: 'Aceptar la conversación de Ana Torres' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La conversación ya no está pendiente');
    expect(screen.getByRole('button', { name: 'Aceptar la conversación de Ana Torres' })).toBeInTheDocument();
  });

  it('no aparece si la persona no puede aceptarla, si la conversación no está pendiente ni en escritorio', async () => {
    stubWidth(390);
    mockApi(server(world({ conv: conv({ status: 'pending', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } }) })));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    expect(screen.queryByRole('button', { name: /Aceptar/ })).not.toBeInTheDocument();
  });

  it('en escritorio la lista no lo muestra (ahí «Aceptar» está en la cabecera del chat)', async () => {
    stubWidth(1440);
    mockApi(server(pending()));
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    expect(screen.queryByRole('button', { name: 'Aceptar la conversación de Ana Torres' })).not.toBeInTheDocument();
  });
});

describe('S1.3 · filas más altas', () => {
  it('la fila móvil mide al menos 76 px y 14 px de relleno vertical (antes 72 y 12)', async () => {
    stubWidth(390);
    mockApi(server(world()));
    renderApp('/inbox');
    const row = await screen.findByRole('link', { name: 'Ana Torres' });
    expect(row.className).toMatch(/min-h-\[76px\]/);
    expect(row.className).toMatch(/py-\[14px\]/);
  });
});

describe('S1.4 · cronómetro: solo icono y tiempo', () => {
  it('compactSpan: minutos, horas con minutos y días', () => {
    expect(compactSpan(30_000)).toBe('1 min');
    expect(compactSpan(8 * 60 * MIN + 10 * MIN)).toBe('8 h 10 min');
    expect(compactSpan(2 * 60 * MIN)).toBe('2 h');
    expect(compactSpan((24 * 60 + 3 * 60) * MIN)).toBe('1 d 3 h');
    expect(compactSpan(48 * 60 * MIN)).toBe('2 d');
  });

  it('en la lista un SLA vencido muestra «8 h 10 min» sin la palabra «Vencida», y su estado completo va en el nombre accesible y el título', async () => {
    stubWidth(390);
    const c = conv({ sla: { kind: 'followup', state: 'late', started_at: ago(10 * 60 * MIN), due_at: ago(8 * 60 * MIN + 10 * MIN - 20_000), response_seconds: null } });
    mockApi(server(world({ conv: c })));
    renderApp('/inbox');
    const row = within(await screen.findByRole('link', { name: 'Ana Torres' }));
    const chip = row.getByLabelText('SLA vencido hace 8 h 10 min');
    expect(chip).toHaveTextContent('8 h 10 min');
    expect(chip).not.toHaveTextContent(/Vencida/);
    expect(chip).toHaveAttribute('title', expect.stringContaining('SLA vencido hace 8 h 10 min'));
    // el estado no depende solo del color: el vencido lleva borde continuo; el que está por vencer, discontinuo
    expect(chip.className).toMatch(/\bborder\b/);
    expect(chip.className).not.toMatch(/border-dashed/);
  });

  it('en riesgo lleva borde discontinuo y el que está al día, ninguno', async () => {
    stubWidth(390);
    const risk = conv({ sla: { kind: 'followup', state: 'risk', started_at: ago(10 * MIN), due_at: new Date(Date.now() + 2 * MIN).toISOString(), response_seconds: null } });
    mockApi(server(world({ conv: risk })));
    renderApp('/inbox');
    const chip = (await within(await screen.findByRole('link', { name: 'Ana Torres' })).findByLabelText(/SLA en riesgo: vence en/));
    expect(chip.className).toMatch(/border-dashed/);
  });
});

describe('S1.2 · icono de etiquetas en la cabecera del chat', () => {
  const tagged = (): World => world({ tags: [SYSTEM, tag('t1', 'Interesado'), tag('t2', 'Seguimiento')], conv: conv({ tags: [SYSTEM, tag('t1', 'Interesado')] }) });

  it('la cabecera ya no trae el chip «QR»: el canal va en el subtítulo y el icono de etiquetas lleva un punto si hay etiquetas', async () => {
    stubWidth(390);
    const w = tagged();
    w.conv = { ...w.conv, channel: { id: 'ch2', name: 'Chip de ventas', state: 'active', kind: 'qr', session: 'open' } as unknown as Conversation['channel'] };
    mockApi(server(w));
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    expect(chat.getByRole('button', { name: 'Ver los datos de Ana Torres' })).toHaveTextContent('+593984217730 · QR');
    expect(chat.queryByTitle('WhatsApp por QR')).not.toBeInTheDocument();
    const icon = chat.getByRole('button', { name: 'Etiquetas de la conversación (2)' });
    expect(icon.querySelector('span[aria-hidden="true"]')).not.toBeNull(); // el punto
  });

  it('sin etiquetas no hay punto', async () => {
    stubWidth(390);
    mockApi(server(world({ tags: [tag('t1', 'Interesado')] })));
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    const icon = chat.getByRole('button', { name: 'Etiquetas de la conversación' });
    expect(icon.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('abre «Etiquetas de la conversación»: las del sistema solo se leen, las personalizadas se marcan y se guardan con tag_ids; Esc cierra y devuelve el foco', async () => {
    stubWidth(390);
    const w = tagged();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    const icon = chat.getByRole('button', { name: /Etiquetas de la conversación/ });
    await userEvent.click(icon);
    const dlg = within(await screen.findByRole('dialog', { name: 'Etiquetas de la conversación' }));
    expect(icon).toHaveAttribute('aria-expanded', 'true');
    expect(dlg.getByText('Venta')).toBeInTheDocument();
    expect(dlg.queryByRole('checkbox', { name: /Venta/ })).not.toBeInTheDocument(); // las del sistema no se mueven
    expect(await dlg.findByRole('checkbox', { name: 'Interesado' })).toBeChecked();
    expect(dlg.getByRole('checkbox', { name: 'Seguimiento' })).not.toBeChecked();
    await userEvent.click(dlg.getByRole('checkbox', { name: 'Seguimiento' }));
    await waitFor(() => expect(w.patches).toEqual([{ tag_ids: ['t1', 't2'] }]));
    // sin buscador ni «Crear etiqueta» (8 o menos y sin permiso)
    expect(dlg.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Crear etiqueta' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Etiquetas de la conversación' })).not.toBeInTheDocument());
    expect(icon).toHaveFocus();
  });

  it('tocar fuera lo cierra', async () => {
    stubWidth(390);
    mockApi(server(tagged()));
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    await userEvent.click(chat.getByRole('button', { name: /Etiquetas de la conversación/ }));
    await screen.findByRole('dialog', { name: 'Etiquetas de la conversación' });
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Etiquetas de la conversación' })).not.toBeInTheDocument());
  });

  it('con más de 8 etiquetas ofrece buscar; «Crear etiqueta» solo con permiso (tags.manage)', async () => {
    stubWidth(390);
    const many = Array.from({ length: 10 }, (_, i) => tag(`x${i}`, i === 3 ? 'Matriculado' : `Etiqueta ${i}`));
    const w = world({ tags: many, manage: true });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const chat = within(await screen.findByRole('region', { name: 'Conversación con Ana Torres' }));
    await userEvent.click(chat.getByRole('button', { name: /Etiquetas de la conversación/ }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Etiquetas de la conversación' }));
    const search = await dlg.findByRole('searchbox', { name: 'Buscar etiquetas' });
    await userEvent.type(search, 'matri');
    expect(dlg.getAllByRole('checkbox')).toHaveLength(1);
    expect(dlg.getByRole('checkbox', { name: 'Matriculado' })).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(dlg.getByRole('status')).toHaveTextContent('Ninguna etiqueta se llama «zzz»');
    // crear: escondido tras el botón, que lo muestra
    expect(dlg.queryByRole('form', { name: 'Crear etiqueta' })).not.toBeInTheDocument();
    await userEvent.click(dlg.getByRole('button', { name: 'Crear etiqueta' }));
    expect(dlg.getByRole('form', { name: 'Crear etiqueta' })).toBeInTheDocument();
  });
});

describe('S1.5 · redactor móvil: micrófono ↔ enviar, y «Enviar» mantenido abre «Programar»', () => {
  const touch = { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 200, clientY: 700 };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('sin texto el botón de la derecha es el micrófono; con texto, «Enviar»; borrar el texto devuelve el micrófono', async () => {
    stubWidth(390);
    mockApi(server(world()));
    renderApp('/inbox/c1');
    const box = await screen.findByRole('textbox', { name: 'Mensaje' });
    expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeEnabled();
    await userEvent.type(box, 'hola');
    expect(screen.queryByRole('button', { name: 'Grabar nota de voz' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    await userEvent.clear(box);
    expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
  });

  it('mantener pulsado «Enviar» 500 ms abre «Programar mensaje» con el texto escrito y NO envía; un toque corto sí envía', async () => {
    stubWidth(390);
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'Te escribo luego');
    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(send).toHaveAccessibleDescription('Mantén pulsado para programar el mensaje');
    fireEvent.pointerDown(send, touch);
    await wait(650);
    const dlg = await screen.findByRole('dialog', { name: 'Programar mensaje' });
    expect(within(dlg).getByLabelText('Mensaje a programar')).toHaveTextContent('Te escribo luego');
    // al soltar, el clic que sigue no cuenta como «enviar»
    fireEvent.pointerUp(send, touch);
    fireEvent.click(send);
    expect(w.posts.filter((p) => p.path.endsWith('/messages'))).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancelar' }));
    // un toque corto envía
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Enviar' }), touch);
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Enviar' }), touch);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts.filter((p) => p.path.endsWith('/messages'))).toEqual([{ path: '/conversations/c1/messages', body: { text: 'Te escribo luego' } }]));
    expect(screen.queryByRole('dialog', { name: 'Programar mensaje' })).not.toBeInTheDocument();
  });

  it('si el dedo se mueve más de 10 px o se levanta antes, no se abre nada', async () => {
    stubWidth(390);
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'hola');
    const send = screen.getByRole('button', { name: 'Enviar' });
    fireEvent.pointerDown(send, touch);
    fireEvent.pointerMove(send, { ...touch, clientX: 240 });
    await wait(650);
    expect(screen.queryByRole('dialog', { name: 'Programar mensaje' })).not.toBeInTheDocument();
    fireEvent.pointerDown(send, touch);
    await wait(200);
    fireEvent.pointerUp(send, touch);
    await wait(450);
    expect(screen.queryByRole('dialog', { name: 'Programar mensaje' })).not.toBeInTheDocument();
  });

  it('el menú contextual del sistema se anula en el botón (para que no tape el gesto)', async () => {
    stubWidth(390);
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'hola');
    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(fireEvent.contextMenu(send)).toBe(false); // preventDefault
    expect(send).toHaveStyle({ userSelect: 'none' });
  });

  it('con la ventana de 24 h cerrada (WhatsApp oficial) no hay gesto ni pista', async () => {
    stubWidth(390);
    const closed = world({ conv: conv({ window: { open: false, expires_at: ago(MIN) } }) });
    mockApi(server(closed));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Nota interna' }), 'hola');
    expect(screen.getByRole('button', { name: 'Guardar nota' })).not.toHaveAccessibleDescription('Mantén pulsado para programar el mensaje');
  });

  it('en una conversación de QR (sin ventana) el gesto funciona', async () => {
    stubWidth(390);
    const w = world({ conv: conv({ window: { open: true, expires_at: null }, channel: { id: 'ch2', name: 'Chip', state: 'active', kind: 'qr', session: 'open' } as unknown as Conversation['channel'] }) });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'Hola por QR');
    const send = screen.getByRole('button', { name: 'Enviar' });
    fireEvent.pointerDown(send, touch);
    await wait(650);
    expect(await screen.findByRole('dialog', { name: 'Programar mensaje' })).toBeInTheDocument();
    expect(screen.queryByText(/Pasaron más de 24 horas/)).not.toBeInTheDocument();
  });

  it('el menú «+» sigue ofreciendo «Programar mensaje» como vía accesible', async () => {
    stubWidth(390);
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Mensaje' }), 'hola');
    await userEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Más opciones del mensaje' }));
    await userEvent.click(sheet.getByRole('button', { name: 'Programar mensaje' }));
    expect(await screen.findByRole('dialog', { name: 'Programar mensaje' })).toBeInTheDocument();
  });
});
