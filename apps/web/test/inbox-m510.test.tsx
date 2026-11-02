import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList, InboxOptions, ScheduledListItem, ScheduledPageData } from '../src/lib/types';
import { authed, ME_ADVISOR, mockApi, pickMore, renderApp, resetWorld, type Call, type Handler } from './helpers';

// M5.10 — Menú «⋯ Más» de la cabecera y vista global de mensajes programados.
beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const later = (ms: number): string => new Date(Date.now() + ms).toISOString();

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

describe('Inbox · menú «⋯ Más»', () => {
  const serverFor = (c: Conversation): Record<string, Handler> => ({
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
  });

  it('Transferir y Finalizar salen de la cabecera y viven en el menú; Aceptar y Asignarme siguen a la vista', async () => {
    mockApi(serverFor(conv({ status: 'pending', can: { ...FULL, accept: true } })));
    renderApp('/inbox/c1');
    expect(await screen.findByRole('button', { name: 'Aceptar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transferir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalizar' })).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'Más acciones' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const menu = within(await screen.findByRole('menu', { name: 'Más acciones' }));
    expect(menu.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Transferir', 'Finalizar']);
  });

  it('con el teclado: abre con el foco en la primera acción, las flechas recorren, Esc cierra y devuelve el foco al botón', async () => {
    mockApi(serverFor(conv()));
    renderApp('/inbox/c1');
    const more = await screen.findByRole('button', { name: 'Más acciones' });
    await userEvent.click(more);
    const [first, second] = await screen.findAllByRole('menuitem');
    expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(first).toHaveFocus(); // da la vuelta
    await userEvent.keyboard('{ArrowUp}');
    expect(second).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(more).toHaveFocus();
  });

  it('un clic fuera cierra el menú', async () => {
    mockApi(serverFor(conv()));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('log', { name: 'Mensajes' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('«Transferir» del menú abre el selector y «Finalizar» pide confirmación', async () => {
    mockApi({
      ...serverFor(conv()),
      'GET /conversations/c1/transfer-options': () => ({ body: { items: [], participants: [], can_transfer: true, can_share: true } }),
    });
    renderApp('/inbox/c1');
    await pickMore('Transferir');
    expect(await screen.findByRole('dialog', { name: 'Transferir o compartir' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    cleanup();
    mockApi(serverFor(conv()));
    renderApp('/inbox/c1');
    await pickMore('Finalizar');
    expect(await screen.findByText(/Si el cliente escribe de nuevo se abrirá otra conversación/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sí, finalizar' })).toBeInTheDocument();
  });

  it('un colaborador ve «Dejar de participar» en el menú; sin nada que hacer, el menú no aparece', async () => {
    mockApi(serverFor(conv({ my_access: 'collaborator_view', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } })));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Dejar de participar']);
    cleanup();
    mockApi(serverFor(conv({ status: 'closed', can: { reply: false, note: true, accept: false, take: false, close: false, transfer: false, share: false } })));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    expect(screen.queryByRole('button', { name: 'Más acciones' })).not.toBeInTheDocument();
  });
});

const item = (over: Partial<ScheduledListItem> = {}): ScheduledListItem => ({
  id: 's1', text: 'Te escribo más tarde', send_at: later(30 * MIN), status: 'scheduled', reason: null, created_at: ago(MIN), resolved_at: null, author: { id: 'u2', name: 'Luis Navas' }, mine: true, can_cancel: true,
  conversation: { id: 'c1', channel_name: 'Barbería WhatsApp', contact: { id: 'k1', name: 'Ana Torres' } }, ...over,
});

describe('Inbox · mensajes programados de todas las conversaciones', () => {
  interface Scenario { scheduled: ScheduledListItem[]; notSent: ScheduledListItem[]; calls: string[]; deletes: string[]; next?: boolean }
  const scenario = (over: Partial<Scenario> = {}): Scenario => ({ scheduled: [item(), item({ id: 's2', text: 'Recordatorio de la cita', send_at: later(2 * HOUR), mine: false, author: { id: 'u3', name: 'Carolina Vera' }, can_cancel: false, conversation: { id: 'c2', channel_name: 'Soporte', contact: { id: 'k2', name: 'Beto Luna' } } })], notSent: [item({ id: 's3', status: 'cancelled', reason: 'customer_replied', can_cancel: false, send_at: ago(HOUR), resolved_at: ago(30 * MIN) })], calls: [], deletes: [], ...over });
  function server(s: Scenario): Record<string, Handler> {
    return {
      ...authed(ME_ADVISOR),
      'GET /scheduled': (call: Call) => {
        s.calls.push(`${call.query.get('status')}|${call.query.get('mine') ?? ''}|${call.query.get('cursor') ?? ''}`);
        const status = call.query.get('status');
        const cursor = call.query.get('cursor');
        const list = status === 'not_sent' ? s.notSent : s.scheduled;
        const body: ScheduledPageData = cursor
          ? { items: [item({ id: 's9', text: 'Mensaje de la segunda página', send_at: later(5 * HOUR) })], next_cursor: null, counts: null }
          : { items: list, next_cursor: s.next && status !== 'not_sent' ? 'cur1' : null, counts: { scheduled: s.scheduled.length, not_sent: s.notSent.length } };
        return { body };
      },
      'DELETE /conversations/c1/scheduled/s1': () => {
        s.deletes.push('s1');
        s.notSent = [item({ id: 's1', status: 'cancelled', reason: 'cancelled_by_user', can_cancel: false }), ...s.notSent];
        s.scheduled = s.scheduled.filter((x) => x.id !== 's1');
        return { body: item({ status: 'cancelled', reason: 'cancelled_by_user' }) };
      },
    };
  }

  it('lista lo programado con su contacto, conexión y hora, con los conteos de cada pestaña; cada fila abre su conversación', async () => {
    mockApi(server(scenario()));
    renderApp('/inbox/scheduled');
    expect(await screen.findByRole('heading', { name: 'Mensajes programados' })).toBeInTheDocument();
    const list = within(await screen.findByRole('list', { name: 'Mensajes programados' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('Te escribo más tarde')).toBeInTheDocument();
    expect(list.getByRole('link', { name: 'Abrir la conversación con Ana Torres' })).toHaveAttribute('href', '/inbox/c1');
    expect(list.getByText(/Soporte · Carolina Vera/)).toBeInTheDocument(); // lo de otra persona dice quién lo programó
    expect(screen.getByRole('tab', { name: 'Programados (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'No salieron (1)' })).toHaveAttribute('aria-selected', 'false');
    // solo se puede cancelar lo que el servidor dice que se puede
    expect(list.getAllByRole('button', { name: /Cancelar el mensaje programado/ })).toHaveLength(1);
  });

  it('cancela desde la vista global con la ruta de la conversación y el mensaje pasa a «No salieron»', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/inbox/scheduled');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar el mensaje programado para Ana Torres' }));
    await waitFor(() => expect(s.deletes).toEqual(['s1']));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'No salieron (2)' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Programados (1)' })).toBeInTheDocument();
  });

  it('«No salieron» pide esa pestaña y explica por qué no salió cada uno', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/inbox/scheduled');
    await userEvent.click(await screen.findByRole('tab', { name: /No salieron/ }));
    expect(await screen.findByText('Se canceló porque el cliente escribió antes.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Mensajes que no salieron' })).toBeInTheDocument();
    expect(s.calls.some((c) => c.startsWith('not_sent|'))).toBe(true);
  });

  it('«Solo los que programé yo» vuelve a pedir con el filtro', async () => {
    const s = scenario();
    mockApi(server(s));
    renderApp('/inbox/scheduled');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Solo los que programé yo' }));
    await waitFor(() => expect(s.calls).toContain('scheduled|1|'));
  });

  it('«Cargar más» trae la página siguiente con el cursor', async () => {
    const s = scenario({ next: true });
    mockApi(server(s));
    renderApp('/inbox/scheduled');
    await userEvent.click(await screen.findByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Mensaje de la segunda página')).toBeInTheDocument();
    expect(s.calls).toContain('scheduled||cur1');
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('sin nada programado lo dice, y si falla ofrece reintentar', async () => {
    mockApi(server(scenario({ scheduled: [], notSent: [] })));
    renderApp('/inbox/scheduled');
    expect(await screen.findByText(/No hay mensajes programados\. Usa «Programar»/)).toBeInTheDocument();
    cleanup();
    mockApi({ ...authed(ME_ADVISOR), 'GET /scheduled': () => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'x', request_id: 'r', details: [] } } }) });
    renderApp('/inbox/scheduled');
    expect(await screen.findByText(/No pudimos cargar los mensajes programados|Tuvimos un problema/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('desde la lista de conversaciones hay un acceso a esta vista', async () => {
    mockApi({
      ...authed(ME_ADVISOR),
      'GET /conversations': () => ({ body: { items: [], next_cursor: null, counts: { working: 0, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
      'GET /conversations/options': () => ({ body: OPTIONS }),
    });
    renderApp('/inbox');
    expect(await screen.findByRole('link', { name: 'Mensajes programados de todas las conversaciones' })).toHaveAttribute('href', '/inbox/scheduled');
  });
});
