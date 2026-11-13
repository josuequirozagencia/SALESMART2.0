import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitCount, HeaderActionBar, MAX_VISIBLE, type HeaderAction } from '../src/features/inbox/HeaderActions';
import type { ChatMessage, Conversation, ConversationList, InboxOptions, ScheduledListItem, ScheduledMessage, ScheduledPageData } from '../src/lib/types';
import { whenIn } from '../src/lib/zone';
import { authed, err, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v13 · S2 — Inbox de escritorio: acciones como iconos con desbordamiento, mensajes programados dentro del chat y como pestaña de Tareas, y «Programar» solo con el reloj.
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const later = (ms: number): string => new Date(Date.now() + ms).toISOString();

// ═════════════════════════════════════════════════════════════════════════════ 2.2 — iconos y desbordamiento
describe('fitCount: cuántas acciones caben a la vista', () => {
  it('todas si caben (y no pasan del máximo); si no, el «⋮» ocupa un lugar y siempre queda al menos una dentro', () => {
    expect(fitCount(0, 1000)).toBe(0);
    expect(fitCount(4, 192)).toBe(4); // 4 × 48 px
    expect(fitCount(4, 191)).toBe(2); // ya no caben: el «⋮» pide un lugar → (191 − 48) / 48
    expect(fitCount(6, 288)).toBe(6);
    expect(fitCount(7, 10_000)).toBe(MAX_VISIBLE); // nunca más del máximo a la vista
    expect(fitCount(7, 0)).toBe(0);
    expect(fitCount(1, 0)).toBe(0); // la única acción pasa al «⋮»
    expect(fitCount(1, 47)).toBe(0);
    expect(fitCount(2, 95)).toBe(0); // 2 no caben (96) → «⋮» (48) + 0
    expect(fitCount(2, 96)).toBe(2);
  });
});

describe('HeaderActionBar · desbordamiento con ResizeObserver', () => {
  let observers: Array<() => void> = [];
  class FakeResizeObserver {
    private readonly cb: () => void;
    constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
    observe(): void {}
    disconnect(): void { observers = observers.filter((c) => c !== this.cb); }
  }
  const define = (el: HTMLElement, prop: 'clientWidth' | 'offsetWidth', value: () => number): void => { Object.defineProperty(el, prop, { configurable: true, get: value }); };
  const acts = (n: number): HeaderAction[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `Acción ${i + 1}`, icon: 'check', group: i < 4 ? 1 : 2, onSelect: vi.fn() }));

  /** Una «cabecera» con el nombre (que se estira), un grupo fijo de 300 px y, dentro de `host`, las acciones. */
  function mount(total: number, width: { v: number }) {
    observers = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const row = document.createElement('div');
    document.body.append(row);
    define(row, 'clientWidth', () => width.v);
    const title = document.createElement('div');
    title.dataset['flex'] = '';
    row.append(title);
    const fixed = document.createElement('div');
    define(fixed, 'offsetWidth', () => 300);
    row.append(fixed);
    const host = document.createElement('div');
    define(host, 'offsetWidth', () => 0);
    row.append(host);
    return render(<HeaderActionBar actions={acts(total)} rowRef={{ current: row }} />, { container: host });
  }
  const resize = (): void => { act(() => { for (const cb of observers) cb(); }); };
  const labels = (): Array<string | null> => within(screen.getByRole('group', { name: 'Acciones de la conversación' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

  it('con ancho de sobra no hay «⋮»; al estrechar la ventana las últimas pasan a «Más acciones» y al ensancharla vuelven', () => {
    const width = { v: 1400 };
    mount(4, width);
    expect(labels()).toEqual(['Acción 1', 'Acción 2', 'Acción 3', 'Acción 4']);
    expect(screen.queryByRole('button', { name: 'Más acciones' })).not.toBeInTheDocument();
    width.v = 600; // disponible = 600 − (160 del nombre + 300) − 30 = 110 → caben 1 y el «⋮»
    resize();
    expect(labels()).toEqual(['Acción 1', 'Más acciones']);
    width.v = 1400;
    resize();
    expect(labels()).toEqual(['Acción 1', 'Acción 2', 'Acción 3', 'Acción 4']);
    expect(screen.queryByRole('button', { name: 'Más acciones' })).not.toBeInTheDocument();
    cleanup();
  });

  it('el «⋮» abre un menú con las acciones que no caben y elegir una la ejecuta', async () => {
    const width = { v: 760 };
    const view = mount(7, width);
    // disponible = 760 − 460 − 30 = 270 → 4 a la vista + «⋮» con las otras 3
    expect(labels()).toEqual(['Acción 1', 'Acción 2', 'Acción 3', 'Acción 4', 'Más acciones']);
    const more = screen.getByRole('button', { name: 'Más acciones' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(more);
    const menu = within(await screen.findByRole('menu', { name: 'Más acciones' }));
    expect(menu.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Acción 5', 'Acción 6', 'Acción 7']);
    await userEvent.keyboard('{Escape}');
    expect(more).toHaveFocus();
    view.unmount();
  });

  it('con muy poco espacio todas están en el «⋮»; el tope de iconos a la vista es 6 aunque sobre el ancho', () => {
    const width = { v: 400 };
    mount(4, width);
    expect(labels()).toEqual(['Más acciones']);
    width.v = 3000;
    resize();
    expect(labels()).toEqual(['Acción 1', 'Acción 2', 'Acción 3', 'Acción 4']);
    cleanup();
    mount(8, width);
    expect(labels()).toHaveLength(MAX_VISIBLE + 1); // 6 iconos y el «⋮»
  });

  it('sin acciones no pinta nada; un separador aparta las frecuentes de las demás', () => {
    const width = { v: 3000 };
    const none = mount(0, width);
    expect(screen.queryByRole('group', { name: 'Acciones de la conversación' })).not.toBeInTheDocument();
    none.unmount();
    mount(6, width);
    const group = screen.getByRole('group', { name: 'Acciones de la conversación' });
    // grupo 1 (4 acciones) | separador | grupo 2 (2 acciones) | separador final
    const kinds = Array.from(group.children).map((el) => (el.tagName === 'BUTTON' ? 'b' : 's')).join('');
    expect(kinds).toBe('bbbbsbbs');
  });
});

// ═════════════════════════════════════════════════════════════════════════════ Chat: 2.3 sin reloj, 2.4 programados dentro del chat
const FULL = { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true };
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: later(23 * HOUR) }, can: FULL, sla: null, ...over,
});
const msg = (): ChatMessage => ({
  id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null,
});
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const sch = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 's1', text: 'Te escribo más tarde', send_at: later(30 * MIN), status: 'scheduled', reason: null, created_at: ago(MIN), resolved_at: null, author: { id: 'u2', name: 'Luis Navas' }, mine: true, can_cancel: true, ...over,
});

interface ChatWorld { items: ScheduledMessage[]; posts: string[]; deletes: string[]; sendFails?: boolean }
function chatServer(w: ChatWorld, c: Conversation = conv()): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: w.items, time_zone: 'America/Guayaquil' } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'POST /conversations/c1/scheduled/s1/send': () => {
      w.posts.push('s1');
      if (w.sendFails) return err(409, 'WINDOW_CLOSED', 'Pasaron más de 24 horas desde el último mensaje del cliente.');
      w.items = w.items.filter((x) => x.id !== 's1');
      return { body: sch({ status: 'sent', can_cancel: false, resolved_at: new Date().toISOString() }) };
    },
    'DELETE /conversations/c1/scheduled/s1': () => {
      w.deletes.push('s1');
      w.items = w.items.map((x) => (x.id === 's1' ? { ...x, status: 'cancelled' as const, reason: 'cancelled_by_user', can_cancel: false } : x));
      return { body: sch({ status: 'cancelled', reason: 'cancelled_by_user' }) };
    },
  };
}

describe('Chat de escritorio · mensajes programados', () => {
  it('2.3: el reloj de «mensajes programados» ya no está en la cabecera del chat ni de la lista', async () => {
    mockApi(chatServer({ items: [sch()], posts: [], deletes: [] }));
    renderApp('/inbox/c1');
    await screen.findByRole('group', { name: 'Acciones de la conversación' });
    expect(screen.queryByRole('button', { name: /^Mensajes programados/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Mensajes programados de todas las conversaciones' })).not.toBeInTheDocument();
  });

  it('2.4: el pendiente se ve al final del chat con borde punteado, su hora y «Enviar ahora» / «Cancelar»; lo de otra persona no ofrece acciones', async () => {
    const mine = sch();
    const other = sch({ id: 's2', text: 'Recordatorio de la cita', send_at: later(3 * HOUR), mine: false, author: { id: 'u3', name: 'Carolina Vera' }, can_cancel: false });
    mockApi(chatServer({ items: [mine, other], posts: [], deletes: [] }));
    renderApp('/inbox/c1');
    const list = within(await screen.findByRole('list', { name: 'Mensajes programados de esta conversación' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    const first = within(list.getAllByRole('group', { name: /^Mensaje programado para / })[0]!);
    expect(first.getByText(/Mensaje programado · (hoy|mañana) \d{2}:\d{2}/)).toBeInTheDocument();
    expect(first.getByText('Te escribo más tarde')).toBeInTheDocument();
    expect(first.getByRole('button', { name: /^Enviar ahora el mensaje programado/ })).toBeInTheDocument();
    expect(first.getByRole('button', { name: /^Cancelar el mensaje programado/ })).toBeInTheDocument();
    // el de Carolina dice quién lo dejó y no trae botones (el servidor dijo que no se puede cancelar)
    expect(list.getByText(/· Carolina Vera/)).toBeInTheDocument();
    expect(list.getAllByRole('button')).toHaveLength(2);
    // el borde es punteado y va después de los mensajes del hilo
    const box = list.getAllByRole('group')[0]!;
    expect(box.className).toMatch(/border-dashed/);
    const log = screen.getByRole('log', { name: 'Mensajes' });
    const hola = within(log).getByText('Hola');
    expect(hola.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('2.4: «Enviar ahora» manda el envío y el programado deja de verse; «Cancelar» manda el DELETE', async () => {
    const w: ChatWorld = { items: [sch()], posts: [], deletes: [] };
    mockApi(chatServer(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: /^Enviar ahora el mensaje programado/ }));
    await waitFor(() => expect(w.posts).toEqual(['s1']));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Mensajes programados de esta conversación' })).not.toBeInTheDocument());
    cleanup();
    const v: ChatWorld = { items: [sch()], posts: [], deletes: [] };
    mockApi(chatServer(v));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: /^Cancelar el mensaje programado/ }));
    await waitFor(() => expect(v.deletes).toEqual(['s1']));
    // lo que la persona misma canceló ya no ocupa el chat
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Mensajes programados de esta conversación' })).not.toBeInTheDocument());
  });

  it('2.4: si el servidor rechaza «Enviar ahora» (ventana cerrada) se dice el motivo y el mensaje sigue programado', async () => {
    const w: ChatWorld = { items: [sch()], posts: [], deletes: [], sendFails: true };
    mockApi(chatServer(w));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: /^Enviar ahora el mensaje programado/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/24 horas/);
    expect(screen.getByText('Te escribo más tarde')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Enviar ahora el mensaje programado/ })).toBeEnabled();
  });

  it('2.4: lo que no salió por un motivo ajeno se ve 24 h con ese motivo; lo cancelado por la propia persona no', async () => {
    const w: ChatWorld = {
      posts: [], deletes: [],
      items: [
        sch({ id: 's3', status: 'failed', reason: 'window_closed', can_cancel: false, send_at: ago(HOUR), resolved_at: ago(30 * MIN), text: 'No salió por la ventana' }),
        sch({ id: 's4', status: 'cancelled', reason: 'cancelled_by_user', can_cancel: false, text: 'Lo cancelé yo' }),
        sch({ id: 's5', status: 'cancelled', reason: 'customer_replied', can_cancel: false, text: 'El cliente contestó antes' }),
      ],
    };
    mockApi(chatServer(w));
    renderApp('/inbox/c1');
    const list = within(await screen.findByRole('list', { name: 'Mensajes programados de esta conversación' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('No salió por la ventana')).toBeInTheDocument();
    expect(list.getByText(/se cerró la ventana de 24 h/)).toBeInTheDocument();
    expect(list.getByText('Se canceló porque el cliente escribió antes.')).toBeInTheDocument();
    expect(list.queryByText('Lo cancelé yo')).not.toBeInTheDocument();
    expect(list.queryByRole('button')).not.toBeInTheDocument(); // ya no hay nada que enviar ni cancelar
  });

  it('sin programados no hay lista en el chat', async () => {
    mockApi(chatServer({ items: [], posts: [], deletes: [] }));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    expect(screen.queryByRole('list', { name: 'Mensajes programados de esta conversación' })).not.toBeInTheDocument();
  });

  it('2.4: «Programar» es solo el reloj del redactor (nombre accesible y ayuda, sin texto) y sigue pidiendo el mensaje primero', async () => {
    mockApi(chatServer({ items: [], posts: [], deletes: [] }));
    renderApp('/inbox/c1');
    const clock = await screen.findByRole('button', { name: 'Programar mensaje' });
    expect(clock).toHaveAttribute('title', 'Programar mensaje');
    expect(clock).toHaveTextContent('');
    expect(screen.queryByText('Programar')).not.toBeInTheDocument();
    expect(clock).toBeDisabled(); // sin texto
    await userEvent.type(screen.getByRole('textbox', { name: 'Mensaje' }), 'Te aviso mañana');
    expect(clock).toBeEnabled();
    await userEvent.click(clock);
    expect(await screen.findByRole('dialog', { name: 'Programar mensaje' })).toBeInTheDocument();
  });
});

describe('whenIn: cuándo, en la zona horaria de la empresa', () => {
  it('«hoy», «mañana» o el día corto, con la hora de esa zona', () => {
    const now = Date.parse('2026-11-13T15:00:00Z'); // 10:00 en Guayaquil (UTC−5)
    expect(whenIn('2026-11-13T20:30:00Z', 'America/Guayaquil', now)).toBe('hoy 15:30');
    expect(whenIn('2026-11-14T14:00:00Z', 'America/Guayaquil', now)).toBe('mañana 09:00');
    expect(whenIn('2026-11-13T03:00:00Z', 'America/Guayaquil', now)).toMatch(/^(?!hoy|mañana).+22:00$/); // 22:00 del 12: un día corto, no «hoy»
    expect(whenIn('2026-11-20T14:00:00Z', 'America/Guayaquil', now)).toMatch(/^vie.*20.*09:00$/);
    // la misma hora instantánea cae en otro día según la zona
    expect(whenIn('2026-11-14T03:00:00Z', 'America/Guayaquil', now)).toMatch(/^hoy 22:00$/);
    expect(whenIn('2026-11-14T03:00:00Z', 'Asia/Tokyo', now)).toBe('hoy 12:00'); // en Tokio ya es 14 de noviembre
    expect(whenIn('2026-11-15T03:00:00Z', 'Asia/Tokyo', now)).toBe('mañana 12:00');
  });
});

// ═════════════════════════════════════════════════════════════════════════════ 2.3 — Tareas › Mensajes programados
const item = (over: Partial<ScheduledListItem> = {}): ScheduledListItem => ({
  ...sch(), send_at: later(30 * MIN),
  conversation: { id: 'c1', channel_name: 'Barbería WhatsApp', contact: { id: 'k1', name: 'Ana Torres' } }, ...over,
});

describe('Tareas · pestaña «Mensajes programados»', () => {
  interface Scenario { scheduled: ScheduledListItem[]; sent: ScheduledListItem[]; notSent: ScheduledListItem[]; calls: URLSearchParams[]; deletes: string[]; next?: boolean }
  const scenario = (over: Partial<Scenario> = {}): Scenario => ({
    scheduled: [item(), item({ id: 's2', text: 'Recordatorio de la cita', send_at: later(2 * HOUR), mine: false, author: { id: 'u3', name: 'Carolina Vera' }, can_cancel: false, conversation: { id: 'c2', channel_name: 'Soporte', contact: { id: 'k2', name: 'Beto Luna' } } })],
    sent: [item({ id: 's6', status: 'sent', can_cancel: false, text: 'Ya salió', send_at: ago(HOUR), resolved_at: ago(HOUR) })],
    notSent: [item({ id: 's3', status: 'cancelled', reason: 'customer_replied', can_cancel: false, send_at: ago(HOUR), resolved_at: ago(30 * MIN) })],
    calls: [], deletes: [], ...over,
  });
  function server(s: Scenario): Record<string, Handler> {
    return {
      ...authed(ME_ADVISOR),
      'GET /tasks': () => ({ body: { items: [], next_cursor: null, total: 0, access: { view_all: false, write: true } } }),
      'GET /scheduled': (call: Call) => {
        s.calls.push(call.query);
        const status = call.query.get('status');
        const cursor = call.query.get('cursor');
        const list = status === 'not_sent' ? s.notSent : status === 'sent' ? s.sent : s.scheduled;
        const body: ScheduledPageData = cursor
          ? { items: [item({ id: 's9', text: 'Mensaje de la segunda página', send_at: later(5 * HOUR) })], next_cursor: null, counts: null }
          : { items: list, next_cursor: s.next && status !== 'not_sent' && status !== 'sent' ? 'cur1' : null, counts: { scheduled: s.scheduled.length, not_sent: s.notSent.length, sent: s.sent.length } };
        return { body };
      },
      'DELETE /conversations/c1/scheduled/s1': () => {
        s.deletes.push('s1');
        s.notSent = [item({ id: 's1', status: 'cancelled', reason: 'cancelled_by_user', can_cancel: false }), ...s.notSent];
        s.scheduled = s.scheduled.filter((x) => x.id !== 's1');
        return { body: sch({ status: 'cancelled', reason: 'cancelled_by_user' }) };
      },
    };
  }
  const last = (s: Scenario): URLSearchParams => s.calls[s.calls.length - 1]!;

  it('«Tareas» tiene dos pestañas; «Mensajes programados» lista lo pendiente con contacto, conexión, hora y los conteos; cada fila lleva «Ir al chat»', async () => {
    mockApi(server(scenario()));
    renderApp('/tasks?tab=scheduled');
    expect(await screen.findByRole('heading', { name: 'Tareas' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Mensajes programados' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Tareas' })).toHaveAttribute('aria-selected', 'false');
    const list = within(await screen.findByRole('list', { name: 'Mensajes programados' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('Te escribo más tarde')).toBeInTheDocument();
    expect(list.getByText('Ana Torres')).toBeInTheDocument();
    expect(list.getByRole('link', { name: 'Ir al chat con Ana Torres' })).toHaveAttribute('href', '/inbox/c1');
    expect(list.getByText(/Soporte · Carolina Vera/)).toBeInTheDocument(); // lo de otra persona dice quién lo programó
    expect(screen.getByRole('tab', { name: 'Programados (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Enviados (1)' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'No salieron (1)' })).toHaveAttribute('aria-selected', 'false');
    expect(list.getAllByRole('button', { name: /Cancelar el mensaje programado/ })).toHaveLength(1); // solo lo que el servidor dice que se puede cancelar
  });

  it('cambiar de pestaña de la pantalla no pierde nada: «Tareas» muestra las tareas y la dirección guarda `?tab=scheduled`', async () => {
    mockApi(server(scenario()));
    renderApp('/tasks');
    expect(await screen.findByRole('tab', { name: 'Pendientes' })).toBeInTheDocument(); // el filtro de tareas
    await userEvent.click(screen.getByRole('tab', { name: 'Mensajes programados' }));
    expect(await screen.findByRole('list', { name: 'Mensajes programados' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Pendientes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Tareas' }));
    expect(await screen.findByRole('tab', { name: 'Pendientes' })).toBeInTheDocument();
  });

  it('la dirección de antes (`/inbox/scheduled`) redirige a la pestaña', async () => {
    mockApi(server(scenario()));
    renderApp('/inbox/scheduled');
    expect(await screen.findByRole('list', { name: 'Mensajes programados' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Mensajes programados' })).toHaveAttribute('aria-selected', 'true');
  });

  it('cancela desde la lista con la ruta de la conversación y el mensaje pasa a «No salieron»', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/tasks?tab=scheduled');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar el mensaje programado para Ana Torres' }));
    await waitFor(() => expect(s.deletes).toEqual(['s1']));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'No salieron (2)' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Programados (1)' })).toBeInTheDocument();
  });

  it('«Enviados» y «No salieron» piden su pestaña; el que salió se dice «Enviado» y el que no, por qué', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/tasks?tab=scheduled');
    await userEvent.click(await screen.findByRole('tab', { name: /^Enviados/ }));
    const sentList = within(await screen.findByRole('list', { name: 'Mensajes programados que salieron' }));
    expect(sentList.getByText('Ya salió')).toBeInTheDocument();
    expect(sentList.getByText('Enviado')).toBeInTheDocument();
    expect(s.calls.some((c) => c.get('status') === 'sent')).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: /No salieron/ }));
    expect(await screen.findByText('Se canceló porque el cliente escribió antes.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Mensajes que no salieron' })).toBeInTheDocument();
    expect(s.calls.some((c) => c.get('status') === 'not_sent')).toBe(true);
  });

  it('filtros: «Solo los que programé yo», rango de fechas y un contacto (`?contact=`) vuelven a pedir con el filtro', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/tasks?tab=scheduled&contact=k1');
    await screen.findByRole('list', { name: 'Mensajes programados' });
    expect(last(s).get('contact_id')).toBe('k1');
    expect(screen.getByText('Solo un contacto')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Solo los que programé yo' }));
    await waitFor(() => expect(last(s).get('mine')).toBe('1'));
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-11-20' } });
    await waitFor(() => expect(last(s).get('from')).not.toBeNull());
    expect(new Date(last(s).get('from')!).getTime()).toBe(new Date('2026-11-20T00:00:00').getTime());
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-11-22' } });
    await waitFor(() => expect(last(s).get('to')).not.toBeNull());
    expect(new Date(last(s).get('to')!).getTime()).toBe(new Date('2026-11-22T23:59:59.999').getTime());
    await userEvent.click(screen.getByRole('button', { name: 'Quitar este filtro' }));
    await waitFor(() => expect(last(s).get('contact_id')).toBeNull());
    expect(screen.queryByText('Solo un contacto')).not.toBeInTheDocument();
  });

  it('«Cargar más» trae la página siguiente con el cursor', async () => {
    const s = scenario({ next: true });
    mockApi(server(s));
    renderApp('/tasks?tab=scheduled');
    await userEvent.click(await screen.findByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Mensaje de la segunda página')).toBeInTheDocument();
    expect(s.calls.some((c) => c.get('cursor') === 'cur1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('sin nada programado lo dice (y con filtros, que no hay con esos filtros); si falla ofrece reintentar', async () => {
    mockApi(server(scenario({ scheduled: [], sent: [], notSent: [] })));
    renderApp('/tasks?tab=scheduled');
    expect(await screen.findByText(/No hay mensajes programados\. Usa el reloj del redactor/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Solo los que programé yo' }));
    expect(await screen.findByText('No hay mensajes con esos filtros.')).toBeInTheDocument();
    cleanup();
    mockApi({
      ...authed(ME_ADVISOR),
      'GET /tasks': () => ({ body: { items: [], next_cursor: null, total: 0, access: { view_all: false, write: true } } }),
      'GET /scheduled': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'x', request_id: 'r', details: [] } } }),
    });
    renderApp('/tasks?tab=scheduled');
    expect(await screen.findByText(/No pudimos cargar los mensajes programados|Tuvimos un problema/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
});
