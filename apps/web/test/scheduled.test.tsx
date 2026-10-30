import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quickTimes, scheduleLimit, toLocalInput } from '../src/features/inbox/ScheduleDialog';
import type { ChatMessage, Conversation, ConversationList, InboxOptions, ScheduledMessage } from '../src/lib/types';
import { authed, err, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

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

const sch = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 's1',
  text: 'Te escribo luego',
  send_at: new Date(Date.now() + HOUR).toISOString(),
  status: 'scheduled',
  reason: null,
  created_at: ago(MIN),
  resolved_at: null,
  author: { id: 'u2', name: 'Luis Navas' },
  mine: true,
  can_cancel: true,
  ...over,
});

interface World {
  conv: Conversation;
  scheduled: ScheduledMessage[];
  posts: Array<{ method: string; path: string; body: unknown }>;
  onSchedule?: (body: { text: string; send_at: string }) => ReturnType<Handler>;
}
const world = (over: Partial<World> = {}): World => ({ conv: conv(), scheduled: [], posts: [], ...over });

function server(w: World): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [w.conv], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: w.conv }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: w.scheduled } }),
    'POST /conversations/c1/scheduled': (call: Call) => {
      const body = call.body as { text: string; send_at: string };
      w.posts.push({ method: 'POST', path: '/conversations/c1/scheduled', body });
      if (w.onSchedule) return w.onSchedule(body);
      const created = sch({ id: `new-${w.scheduled.length}`, text: body.text, send_at: body.send_at });
      w.scheduled = [...w.scheduled, created];
      return { status: 201, body: created };
    },
    'DELETE /conversations/c1/scheduled/s1': () => {
      w.posts.push({ method: 'DELETE', path: '/conversations/c1/scheduled/s1', body: undefined });
      w.scheduled = w.scheduled.map((s) => (s.id === 's1' ? { ...s, status: 'cancelled', reason: 'cancelled_by_user', can_cancel: false, resolved_at: new Date().toISOString() } : s));
      return { body: w.scheduled.find((s) => s.id === 's1') };
    },
  };
}
const box = async (): Promise<HTMLTextAreaElement> => (await screen.findByRole('textbox', { name: 'Mensaje' })) as HTMLTextAreaElement;

describe('horas para programar (puras)', () => {
  const now = new Date(2026, 9, 20, 14, 0, 0);
  it('toLocalInput da el valor de un campo de fecha y hora local', () => {
    expect(toLocalInput(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05T09:07');
  });
  it('scheduleLimit: un minuto antes de cerrarse la ventana; null si está cerrada', () => {
    const exp = new Date(now.getTime() + 5 * HOUR);
    expect(scheduleLimit({ window: { open: true, expires_at: exp.toISOString() } })?.getTime()).toBe(exp.getTime() - MIN);
    expect(scheduleLimit({ window: { open: false, expires_at: null } })).toBeNull();
    expect(scheduleLimit({ window: { open: false, expires_at: exp.toISOString() } })).toBeNull();
  });
  it('quickTimes ofrece solo las horas que caben en la ventana', () => {
    expect(quickTimes(now, new Date(now.getTime() + 23 * HOUR)).map((o) => o.label)).toEqual(['En 30 minutos', 'En 1 hora', 'En 3 horas', 'Mañana a las 9:00']);
    expect(quickTimes(now, new Date(now.getTime() + 90 * MIN)).map((o) => o.label)).toEqual(['En 30 minutos', 'En 1 hora']);
    expect(quickTimes(now, new Date(now.getTime() + MIN))).toEqual([]);
    expect(quickTimes(new Date(2026, 9, 20, 22, 0), new Date(2026, 9, 21, 20, 0)).map((o) => o.label)).toContain('Mañana a las 9:00');
  });
});

describe('Redactor · programar', () => {
  it('«Programar» pide el mensaje; con texto abre la ventana con horas sugeridas; al confirmar manda el instante y vacía el redactor', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    const open = screen.getByRole('button', { name: 'Programar mensaje' });
    expect(open).toBeDisabled();
    await userEvent.type(input, 'Hola Ana, ¿pudiste ver la propuesta?');
    expect(open).toBeEnabled();
    await userEvent.click(open);
    const dlg = await screen.findByRole('dialog', { name: 'Programar mensaje' });
    expect(within(dlg).getByLabelText('Mensaje a programar')).toHaveTextContent('Hola Ana, ¿pudiste ver la propuesta?');
    expect(within(dlg).getByRole('group', { name: 'Horas sugeridas' })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'En 1 hora' }));
    const before = Date.now();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    const sent = w.posts[0]!.body as { text: string; send_at: string };
    expect(sent.text).toBe('Hola Ana, ¿pudiste ver la propuesta?');
    // «En 1 hora» se redondea al minuto: queda entre 59 y 61 minutos después
    expect(Math.abs(new Date(sent.send_at).getTime() - (before + HOUR))).toBeLessThan(2 * MIN);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Programar mensaje' })).not.toBeInTheDocument());
    await waitFor(() => expect(input.value).toBe(''));
    // el pendiente aparece en la lista de la conversación
    const list = await openScheduled();
    expect(within(list).getByText('Programado')).toBeInTheDocument();
    expect(within(list).getByText('Hola Ana, ¿pudiste ver la propuesta?')).toBeInTheDocument();
  });

  it('con la ventana por cerrarse solo ofrece horas que caben, y avisa hasta cuándo se puede', async () => {
    const w = world({ conv: conv({ window: { open: true, expires_at: new Date(Date.now() + 100 * MIN).toISOString() } }) });
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.type(await box(), 'Hola');
    await userEvent.click(screen.getByRole('button', { name: 'Programar mensaje' }));
    const dlg = await screen.findByRole('dialog', { name: 'Programar mensaje' });
    const group = within(dlg).getByRole('group', { name: 'Horas sugeridas' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['En 30 minutos', 'En 1 hora']);
    expect(within(dlg).getByText(/Puedes programarlo hasta/)).toBeInTheDocument();
  });

  it('valida la hora antes de molestar al servidor: vacía, pasada o fuera de la ventana', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    await userEvent.type(await box(), 'Hola');
    await userEvent.click(screen.getByRole('button', { name: 'Programar mensaje' }));
    const dlg = await screen.findByRole('dialog', { name: 'Programar mensaje' });
    const field = within(dlg).getByLabelText(/Día y hora/);
    fireEvent.change(field, { target: { value: '' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    expect(await within(dlg).findByText('Elige el día y la hora')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: toLocalInput(new Date(Date.now() + 30_000)) } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    expect(await within(dlg).findByText('Elige una hora al menos dos minutos en el futuro')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: toLocalInput(new Date(Date.now() + 30 * HOUR)) } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    expect(await within(dlg).findByText(/WhatsApp solo permite escribir libremente hasta/)).toBeInTheDocument();
    expect(w.posts).toEqual([]);
  });

  it('los errores del servidor se muestran: hora en su campo y el resto como aviso; el texto no se pierde', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const input = await box();
    await userEvent.type(input, 'Hola');
    await userEvent.click(screen.getByRole('button', { name: 'Programar mensaje' }));
    const dlg = await screen.findByRole('dialog', { name: 'Programar mensaje' });
    w.onSchedule = () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'send_at', code: 'too_soon', message: 'Elige una hora al menos un minuto en el futuro' }] } } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    expect(await within(dlg).findByText('Elige una hora al menos un minuto en el futuro')).toBeInTheDocument();
    w.onSchedule = () => err(409, 'SCHEDULE_LIMIT', 'Esta conversación ya tiene 10 mensajes programados: cancela alguno para programar otro');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Programar' }));
    expect(await within(dlg).findByText(/ya tiene 10 mensajes programados/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancelar' }));
    expect(input.value).toBe('Hola');
  });

  it('un dato sin completar de una respuesta rápida no deja programar; en una nota interna no hay «Programar»', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    const input = await box();
    fireEvent.change(input, { target: { value: 'Hola {{contact.ciudad}}' } });
    expect(screen.getByRole('button', { name: 'Programar mensaje' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Hola Quito' } });
    expect(screen.getByRole('button', { name: 'Programar mensaje' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Nota interna' }));
    expect(screen.queryByRole('button', { name: 'Programar mensaje' })).not.toBeInTheDocument();
  });

  it('con la ventana cerrada o sin poder responder no se ofrece programar', async () => {
    const closed = world({ conv: conv({ window: { open: false, expires_at: null } }) });
    mockApi(server(closed));
    renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Nota interna' });
    expect(screen.queryByRole('button', { name: 'Programar mensaje' })).not.toBeInTheDocument();
  });
});

/** Abre la lista de mensajes programados con el reloj de la cabecera del hilo (M5.9). */
const openScheduled = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^Mensajes programados/ }));
  return screen.findByRole('region', { name: 'Mensajes programados' });
};

describe('Mensajes programados de la conversación', () => {
  it('lista los pendientes con su hora; cancelar manda el DELETE y el mensaje queda como cancelado', async () => {
    const w = world({ scheduled: [sch()] });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const list = await openScheduled();
    expect(within(list).getByText('Programado')).toBeInTheDocument();
    expect(within(list).getByText('Te escribo luego')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /Cancelar el mensaje programado para/ }));
    await waitFor(() => expect(w.posts).toEqual([{ method: 'DELETE', path: '/conversations/c1/scheduled/s1', body: undefined }]));
    expect(await within(list).findByText('Cancelado')).toBeInTheDocument();
    expect(within(list).getByText('Se canceló.')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Cancelar el mensaje/ })).not.toBeInTheDocument();
  });

  it('los de otra persona muestran quién los dejó y, si no puedo cancelarlos, no hay botón', async () => {
    mockApi(server(world({ scheduled: [sch({ mine: false, can_cancel: false, author: { id: 'u9', name: 'Eva Mora' } })] })));
    renderApp('/inbox/c1');
    const list = await openScheduled();
    expect(within(list).getByText(/Eva Mora/)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Cancelar el mensaje/ })).not.toBeInTheDocument();
  });

  it('los que no salieron explican por qué', async () => {
    mockApi(server(world({ scheduled: [
      sch({ id: 'a', status: 'cancelled', reason: 'customer_replied', can_cancel: false, text: 'Uno' }),
      sch({ id: 'b', status: 'failed', reason: 'window_closed', can_cancel: false, text: 'Dos' }),
      sch({ id: 'c', status: 'failed', reason: 'channel_unavailable', can_cancel: false, text: 'Tres' }),
    ] })));
    renderApp('/inbox/c1');
    const list = await openScheduled();
    expect(within(list).getByText('Se canceló porque el cliente escribió antes.')).toBeInTheDocument();
    expect(within(list).getByText(/se cerró la ventana de 24 h de WhatsApp/)).toBeInTheDocument();
    expect(within(list).getByText('No salió: la conexión de WhatsApp estaba desactivada.')).toBeInTheDocument();
  });

  it('el reloj de la cabecera SIEMPRE está: con pendientes muestra el contador y sin ninguno la lista vacía explica cómo programar', async () => {
    mockApi(server(world({ scheduled: [sch(), sch({ id: 's2', text: 'Otro' }), sch({ id: 's3', status: 'cancelled', reason: 'customer_replied', can_cancel: false, text: 'Viejo' })] })));
    renderApp('/inbox/c1');
    const btn = await screen.findByRole('button', { name: 'Mensajes programados (2 pendientes)' });
    expect(within(btn).getByText('2')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mensajes programados' })).not.toBeInTheDocument(); // cerrada hasta que se pide
    await userEvent.click(btn);
    expect(within(await screen.findByRole('dialog', { name: 'Mensajes programados' })).getAllByText('Programado')).toHaveLength(2);
  });

  it('sin mensajes programados el reloj sigue ahí y la lista dice que no hay ninguno', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    await box();
    const list = await openScheduled();
    expect(within(list).getByText('No hay mensajes programados. Usa «Programar» en el redactor.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mensajes programados' })).toBeInTheDocument();
  });
});
