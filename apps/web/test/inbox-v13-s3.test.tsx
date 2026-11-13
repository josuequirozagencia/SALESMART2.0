import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDrafts } from '../src/features/inbox/draftStore';
import { MessageBubble, quoteWho } from '../src/features/inbox/MessageBubble';
import { EDGE_GUARD, REPLY_THRESHOLD } from '../src/features/inbox/useSwipeReply';
import type { ChatMessage, Conversation, ConversationList, InboxOptions, ReplyQuote } from '../src/lib/types';
import { authed, err, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// v13 · S3.3 — Responder citando un mensaje: arrastrar a la derecha (móvil), botón «Responder» (escritorio y teclado), cita sobre el redactor, cita dentro de la burbuja y salto al original.

function stubWidth(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return { matches, media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); clearDrafts(); });
afterEach(() => { vi.unstubAllGlobals(); });

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: '¿Atienden mañana?', media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null,
  sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over,
});
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(60 * MIN), assigned_at: ago(120 * MIN), closed_at: null, created_at: ago(180 * MIN),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * 60 * MIN).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true }, sla: null, ...over,
});

const show = (m: ChatMessage, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) => render(<ul><MessageBubble m={m} canRetry={false} retrying={false} onRetry={() => undefined} contactName="Ana Torres" {...props} /></ul>);
const touch = { pointerType: 'touch', pointerId: 1, isPrimary: true };

// ═════════════════════════════════════════════════════════════════════════════ El gesto
describe('arrastrar a la derecha para responder (móvil)', () => {
  const drag = (el: HTMLElement, from: [number, number], to: [number, number], extra: Record<string, unknown> = {}): void => {
    fireEvent.pointerDown(el, { ...touch, clientX: from[0], clientY: from[1], ...extra });
    fireEvent.pointerMove(el, { ...touch, clientX: to[0], clientY: to[1], ...extra });
    fireEvent.pointerUp(el, { ...touch, clientX: to[0], clientY: to[1], ...extra });
  };
  const row = (): HTMLElement => screen.getByText('¿Atienden mañana?').closest('li')!.lastElementChild as HTMLElement;

  it('pasar el umbral (60 px) y soltar responde a ese mensaje; el icono y la burbuja acompañan al dedo', () => {
    stubWidth(390);
    const onReply = vi.fn();
    show(msg(), { onReply });
    const r = row();
    fireEvent.pointerDown(r, { ...touch, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(r, { ...touch, clientX: 140, clientY: 302 });
    expect(r.style.transform).toBe('translateX(40px)'); // la burbuja sigue al dedo
    fireEvent.pointerMove(r, { ...touch, clientX: 100 + REPLY_THRESHOLD + 5, clientY: 302 });
    fireEvent.pointerUp(r, { ...touch, clientX: 165, clientY: 302 });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]![0]).toMatchObject({ id: 'm1' });
    expect(r.style.transform).toBe(''); // vuelve a su sitio
  });

  it('el arrastre se limita a 88 px aunque el dedo siga', () => {
    stubWidth(390);
    show(msg(), { onReply: vi.fn() });
    const r = row();
    fireEvent.pointerDown(r, { ...touch, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(r, { ...touch, clientX: 300, clientY: 300 });
    expect(r.style.transform).toBe('translateX(88px)');
  });

  it('no responde si se suelta antes del umbral, si se arrastra a la izquierda o si el movimiento es sobre todo vertical (desplazar el hilo)', () => {
    stubWidth(390);
    const onReply = vi.fn();
    show(msg(), { onReply });
    const r = row();
    drag(r, [100, 300], [100 + REPLY_THRESHOLD - 10, 300]); // se queda corto
    drag(r, [200, 300], [100, 300]); // a la izquierda
    drag(r, [100, 300], [150, 400]); // diagonal con más vertical que horizontal
    drag(r, [100, 300], [100, 450]); // vertical
    expect(onReply).not.toHaveBeenCalled();
    expect(r.style.transform).toBe('');
  });

  it('un arrastre que empieza a menos de 20 px del borde izquierdo (el gesto «atrás» de iOS) se ignora', () => {
    stubWidth(390);
    const onReply = vi.fn();
    show(msg(), { onReply });
    drag(row(), [EDGE_GUARD - 5, 300], [EDGE_GUARD + 120, 300]);
    expect(onReply).not.toHaveBeenCalled();
    drag(row(), [EDGE_GUARD + 5, 300], [EDGE_GUARD + 120, 300]); // un poco más adentro sí vale
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('con el ratón no hace nada (ahí está el botón «Responder»); cancelar el toque tampoco responde', () => {
    stubWidth(390);
    const onReply = vi.fn();
    show(msg(), { onReply });
    drag(row(), [100, 300], [220, 300], { pointerType: 'mouse' });
    const r = row();
    fireEvent.pointerDown(r, { ...touch, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(r, { ...touch, clientX: 220, clientY: 300 });
    fireEvent.pointerCancel(r, touch);
    fireEvent.pointerUp(r, { ...touch, clientX: 220, clientY: 300 });
    expect(onReply).not.toHaveBeenCalled();
  });

  it('el gesto funciona también sobre un mensaje nuestro; sin onReply (no se puede citar) el gesto no existe', () => {
    stubWidth(390);
    const onReply = vi.fn();
    const { unmount } = show(msg({ id: 'o1', direction: 'out', sender_type: 'human', text: 'Sí, a las 9', status: 'sent', author: { id: 'u2', name: 'Luis Navas' } }), { onReply });
    drag(screen.getByText('Sí, a las 9').closest('li')!.lastElementChild as HTMLElement, [100, 300], [200, 300]);
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }));
    unmount();
    show(msg());
    const r = row();
    drag(r, [100, 300], [220, 300]);
    expect(r.style.transform).toBe('');
    expect(screen.queryByRole('button', { name: 'Responder a este mensaje' })).not.toBeInTheDocument();
  });

  it('el botón «Responder» está en el DOM (teclado y lector de pantalla) y funciona igual que el gesto', async () => {
    stubWidth(1440);
    const onReply = vi.fn();
    show(msg(), { onReply });
    const b = screen.getByRole('button', { name: 'Responder a este mensaje' });
    expect(b).toHaveAttribute('title', 'Responder');
    await userEvent.click(b);
    expect(onReply).toHaveBeenCalledTimes(1);
    onReply.mockClear();
    b.focus();
    await userEvent.keyboard('{Enter}');
    expect(onReply).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════ La cita dentro de la burbuja
describe('la cita dentro de la burbuja', () => {
  const quote = (over: Partial<ReplyQuote> = {}): ReplyQuote => ({ id: 'm0', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: '¿Atienden mañana?', ...over });

  it('muestra de quién y qué se cita, y tocarla salta al original', async () => {
    stubWidth(1440);
    const onJump = vi.fn();
    show(msg({ id: 'm2', direction: 'out', sender_type: 'human', text: 'Sí, de 9 a 18', status: 'sent', reply_to: quote() }), { onJump });
    const q = screen.getByRole('button', { name: /^Mensaje citado de Ana Torres: ¿Atienden mañana\?/ });
    expect(q).toHaveTextContent('Ana Torres');
    expect(q).toHaveTextContent('¿Atienden mañana?');
    await userEvent.click(q);
    expect(onJump).toHaveBeenCalledWith('m0');
  });

  it('cita un mensaje sin texto con el tipo de contenido; y de quién era según quien lo escribió', () => {
    stubWidth(1440);
    expect(quoteWho(quote(), 'Ana Torres')).toBe('Ana Torres');
    expect(quoteWho(quote({ direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' } }), 'Ana Torres')).toBe('Luis Navas');
    expect(quoteWho(quote({ direction: 'out', sender_type: 'ai' }), 'Ana Torres')).toBe('Agente de IA');
    expect(quoteWho(quote({ direction: 'out', sender_type: 'automation' }), 'Ana Torres')).toBe('Mensaje automático');
    expect(quoteWho(quote({ direction: 'out', sender_type: 'human', author: null }), 'Ana Torres')).toBe('Equipo');
    show(msg({ id: 'm3', reply_to: quote({ kind: 'image', text: null }) }));
    expect(screen.getByRole('button', { name: /Mensaje citado de Ana Torres: Imagen/ })).toBeInTheDocument();
  });

  it('un mensaje sin cita no trae el bloque; una cita dentro de un mensaje de color de tema sigue siendo legible (hereda el color)', () => {
    stubWidth(1440);
    show(msg({ id: 'm4', direction: 'out', sender_type: 'human', status: 'sent', text: 'ok', reply_to: quote() }));
    const q = screen.getByRole('button', { name: /Mensaje citado/ });
    expect(q.closest('.bubble-grad')).not.toBeNull();
    expect(q.className).toContain('border-current');
  });
});

// ═════════════════════════════════════════════════════════════════════════════ El flujo completo en el Inbox
describe('Inbox · responder citando', () => {
  interface World { c: Conversation; items: ChatMessage[]; posts: Array<{ path: string; body: unknown }>; fail?: Handler }
  const server = (w: World): Record<string, Handler> => ({
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [w.c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] } satisfies InboxOptions }),
    'GET /conversations/c1': () => ({ body: w.c }),
    'GET /conversations/c1/messages': () => ({ body: { items: w.items, next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [], time_zone: 'America/Guayaquil' } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'POST /conversations/c1/messages': (call) => {
      w.posts.push({ path: call.path, body: call.body });
      if (w.fail) return w.fail(call);
      const b = call.body as { text: string; reply_to_message_id?: string };
      const sent = msg({ id: 'm9', direction: 'out', sender_type: 'human', status: 'sent', text: b.text, author: { id: 'u2', name: 'Luis Navas' }, reply_to: b.reply_to_message_id ? { id: b.reply_to_message_id, direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: '¿Atienden mañana?' } : null });
      w.items = [...w.items, sent];
      return { status: 201, body: sent };
    },
  });
  const world = (over: Partial<World> = {}): World => ({ c: conv(), items: [msg()], posts: [], ...over });

  it('«Responder» pone la cita sobre el redactor; al enviar manda reply_to_message_id, la cita queda en el mensaje y el redactor la suelta', async () => {
    stubWidth(1440);
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await userEvent.click(await within(log).findByRole('button', { name: 'Responder a este mensaje' }));
    const bar = await screen.findByRole('group', { name: 'Respondiendo a un mensaje' });
    expect(bar).toHaveTextContent('Respondiendo a Ana Torres');
    expect(bar).toHaveTextContent('¿Atienden mañana?');
    const box = screen.getByRole('textbox', { name: 'Mensaje' });
    expect(box).toHaveFocus();
    await userEvent.type(box, 'Sí, de 9 a 18');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'Sí, de 9 a 18', reply_to_message_id: 'm1' } }]));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Respondiendo a un mensaje' })).not.toBeInTheDocument());
    expect(await within(log).findByRole('button', { name: /^Mensaje citado de Ana Torres/ })).toBeInTheDocument();
  });

  it('cancelar la respuesta quita la cita y el siguiente envío sale sin ella', async () => {
    stubWidth(1440);
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Responder a este mensaje' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar la respuesta' }));
    expect(screen.queryByRole('group', { name: 'Respondiendo a un mensaje' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Mensaje' }), 'Hola de nuevo');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(w.posts).toEqual([{ path: '/conversations/c1/messages', body: { text: 'Hola de nuevo' } }]));
  });

  it('si el servidor rechaza el envío, la cita se conserva para reintentar', async () => {
    stubWidth(1440);
    const w = world({ fail: () => err(409, 'WINDOW_CLOSED', 'Pasaron más de 24 horas desde el último mensaje del cliente.') });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Responder a este mensaje' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Mensaje' }), 'Va');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/24 horas/);
    expect(screen.getByRole('group', { name: 'Respondiendo a un mensaje' })).toBeInTheDocument();
  });

  it('solo se ofrece sobre lo que se puede citar: no en lo que aún no salió o falló, ni en notas, ni por GoHighLevel, ni con la ventana cerrada, ni sin permiso de escribir', async () => {
    stubWidth(1440);
    const items = [
      msg({ id: 'ok', text: 'Mensaje normal' }),
      msg({ id: 'q', direction: 'out', sender_type: 'human', status: 'queued', text: 'En cola' }),
      msg({ id: 'f', direction: 'out', sender_type: 'human', status: 'failed', text: 'Falló' }),
      msg({ id: 'n', direction: 'out', sender_type: 'human', status: 'internal', kind: 'note', is_note: true, text: 'Recordar llamar mañana' }),
    ];
    mockApi(server(world({ items })));
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await within(log).findByText('Mensaje normal');
    expect(within(log).getAllByRole('button', { name: 'Responder a este mensaje' })).toHaveLength(1);
    const lis = (t: string) => within(log).getByText(t).closest('li')!;
    expect(within(lis('En cola')).queryByRole('button', { name: 'Responder a este mensaje' })).not.toBeInTheDocument();
    expect(within(lis('Falló')).queryByRole('button', { name: 'Responder a este mensaje' })).not.toBeInTheDocument();
    expect(within(lis('Recordar llamar mañana')).queryByRole('button', { name: 'Responder a este mensaje' })).not.toBeInTheDocument();
  });

  it.each([
    ['por GoHighLevel (no tiene citas)', () => conv({ channel: { id: 'ch1', name: 'GoHighLevel', state: 'active', kind: 'ghl' } })],
    ['con la ventana de 24 h cerrada', () => conv({ window: { open: false, expires_at: ago(MIN) } })],
    ['sin permiso de escribir', () => conv({ can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } })],
    ['en una conversación finalizada', () => conv({ status: 'closed' })],
  ])('no se ofrece %s', async (_name, make) => {
    stubWidth(1440);
    mockApi(server(world({ c: make(), items: [msg()] })));
    renderApp('/inbox/c1');
    const l = await screen.findByRole('log', { name: 'Mensajes' });
    await within(l).findByText('¿Atienden mañana?');
    expect(within(l).queryByRole('button', { name: 'Responder a este mensaje' })).not.toBeInTheDocument();
  });

  it('tocar la cita salta al mensaje original (si está en el hilo) y lo remarca un instante', async () => {
    stubWidth(1440);
    const items = [msg({ id: 'm1' }), msg({ id: 'm2', direction: 'out', sender_type: 'human', status: 'sent', text: 'Sí', reply_to: { id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: '¿Atienden mañana?' } })];
    mockApi(server(world({ items })));
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await within(log).findByText('Sí');
    const scroll = vi.fn();
    const target = log.querySelector('#msg-m1') as HTMLElement;
    expect(target).not.toBeNull();
    target.scrollIntoView = scroll;
    await userEvent.click(within(log).getByRole('button', { name: /^Mensaje citado/ }));
    expect(scroll).toHaveBeenCalled();
    expect(target.classList.contains('flash-msg')).toBe(true);
    // una cita a un mensaje que no está cargado no rompe nada
    await waitFor(() => expect(target.classList.contains('flash-msg')).toBe(false), { timeout: 3000 });
  });
});
