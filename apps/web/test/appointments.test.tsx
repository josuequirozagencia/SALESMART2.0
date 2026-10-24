import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appointment, AppointmentOptions } from '../src/features/appointments/useAppointments';
import { addDays, isoToZoned, todayIn, zonedToIso } from '../src/lib/zone';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const TZ = 'America/Guayaquil';
const HOUR = 3_600_000;
const NOW = new Date().toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1', status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner',
    queue: null, channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
    last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW }, window: { open: true, expires_at: new Date(Date.now() + HOUR).toISOString() },
    can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null, ...over,
  }) as Conversation;

const OPTIONS: AppointmentOptions = {
  timezone: TZ,
  max_reminders: 3,
  window: { open: true, expires_at: new Date(Date.now() + 20 * HOUR).toISOString() },
  templates: [{ id: 't1', name: 'recordatorio_cita', language: 'es', category: 'utility', body: 'Hola {{1}}, te recordamos tu cita el {{2}}.', variables: [{ id: 'body:1', part: 'body', key: '1' }, { id: 'body:2', part: 'body', key: '2' }] }],
  blocked: null,
};
const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'a1', contact: { id: 'k1', name: 'Ana Torres' }, conversation_id: 'c1', owner: { id: 'u2', name: 'Luis Navas' }, starts_at: new Date(Date.now() + 3 * HOUR).toISOString(),
  ends_at: new Date(Date.now() + 3.5 * HOUR).toISOString(), duration_minutes: 30, kind: 'Corte', notes: null, status: 'scheduled', cancel_reason: null, created_at: NOW,
  reminders: [
    { id: 'r1', offset_minutes: 60, send_at: new Date(Date.now() + 2 * HOUR).toISOString(), status: 'sent', via: 'text', reason: null, delivery: 'delivered' },
    { id: 'r2', offset_minutes: 10, send_at: new Date(Date.now() + 2.8 * HOUR).toISOString(), status: 'skipped', via: null, reason: 'window_closed', delivery: null },
  ],
  reminder_offsets: [60, 10], reminder_template: null, can: { edit: true, cancel: true, complete: true }, ...over,
});

interface World {
  options: AppointmentOptions;
  appt: Appointment;
  posts: Array<{ path: string; body: unknown; key: string | undefined }>;
  agendaQueries: string[];
  failFirst?: boolean;
}
const world = (over: Partial<World> = {}): World => ({ options: OPTIONS, appt: appt(), posts: [], agendaQueries: [], ...over });

function server(w: World, me = ME_ADVISOR): Record<string, Handler> {
  const record = (c: Call) => w.posts.push({ path: c.path, body: c.body, key: c.headers['idempotency-key'] });
  return {
    ...authed(me),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /appointments/options': () => ({ body: w.options }),
    'POST /appointments': (c) => {
      record(c);
      if (w.failFirst && w.posts.length === 1) return err(500, 'INTERNAL_ERROR', 'Error interno');
      return { status: 201, body: w.appt };
    },
    'GET /appointments': (c) => { w.agendaQueries.push(`${c.query.get('from')}|${c.query.get('to')}`); return { body: { items: [w.appt], timezone: TZ } }; },
    'GET /appointments/a1': () => ({ body: w.appt }),
    'PATCH /appointments/a1': (c) => { record(c); w.appt = appt({ starts_at: (c.body as { starts_at: string }).starts_at }); return { body: w.appt }; },
    'POST /appointments/a1/cancel': (c) => { record(c); w.appt = appt({ status: 'cancelled', cancel_reason: (c.body as { reason: string }).reason, can: { edit: false, cancel: false, complete: false } }); return { body: w.appt }; },
    'POST /appointments/a1/complete': (c) => { record(c); w.appt = appt({ status: 'completed', can: { edit: false, cancel: false, complete: false } }); return { body: w.appt }; },
  };
}

const tomorrow = (): string => addDays(todayIn(TZ), 1);
const openDialog = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Agendar' }));
  return within(await screen.findByRole('dialog', { name: 'Agendar cita' }));
};
const fillWhen = async (d: ReturnType<typeof within>, date: string, time: string) => {
  const day = await d.findByLabelText('Día');
  await userEvent.clear(day);
  await userEvent.type(day, date);
  const hour = d.getByLabelText('Hora');
  await userEvent.clear(hour);
  await userEvent.type(hour, time);
};

describe('zona horaria de la empresa', () => {
  it('convierte día y hora de la empresa a un instante UTC y de vuelta, también cerca de la medianoche', () => {
    expect(zonedToIso('2026-10-24', '15:30', TZ)).toBe('2026-10-24T20:30:00.000Z'); // Guayaquil es UTC−5 todo el año
    expect(isoToZoned('2026-10-24T20:30:00.000Z', TZ)).toEqual({ date: '2026-10-24', time: '15:30' });
    expect(isoToZoned('2026-10-25T03:00:00.000Z', TZ)).toEqual({ date: '2026-10-24', time: '22:00' }); // para el navegador ya sería otro día
    expect(zonedToIso('2026-10-24', '00:00', TZ)).toBe('2026-10-24T05:00:00.000Z');
    expect(zonedToIso('2026-03-15', '12:00', 'America/New_York')).toBe('2026-03-15T16:00:00.000Z'); // con horario de verano
    expect(zonedToIso('no', '12:00', TZ)).toBeNull();
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('Agendar desde el chat', () => {
  it('manda la hora de la empresa como instante UTC, la duración, el tipo y los recordatorios elegidos, con una llave de idempotencia', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: true, expires_at: new Date(Date.now() + 60 * HOUR).toISOString() } } }); // ventana abierta de sobra: ningún recordatorio necesita plantilla
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '15:30');
    await userEvent.selectOptions(d.getByLabelText('Duración'), '45');
    await userEvent.clear(d.getByLabelText('Tipo de cita'));
    await userEvent.type(d.getByLabelText('Tipo de cita'), 'Corte y barba');
    await userEvent.click(d.getByLabelText('1 día antes')); // se suma al de 1 hora que viene marcado
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toEqual({ conversation_id: 'c1', starts_at: zonedToIso(tomorrow(), '15:30', TZ), duration_minutes: 45, kind: 'Corte y barba', reminders: [1440, 60] });
    expect(w.posts[0]!.key).toMatch(/^web-/);
    expect(await screen.findByText(/Cita agendada para/)).toBeInTheDocument();
  });

  it('no deja pasar del tope de recordatorios del canal', async () => {
    mockApi(server(world()));
    renderApp('/inbox/c1');
    const d = await openDialog();
    for (const l of ['15 min antes', '30 min antes', '2 horas antes']) await userEvent.click(d.getByLabelText(l));
    expect(d.getByText(/Elegidos: .*1 hora antes/)).toBeInTheDocument();
    expect(d.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(3); // el 4.º no se marcó
  });

  it('pide día y hora, un tipo y que no sea en el pasado; no envía nada hasta que esté bien', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.click(await d.findByRole('button', { name: 'Agendar' }));
    expect(await d.findByText('Elige el día y la hora')).toBeInTheDocument();
    await fillWhen(d, todayIn(TZ), '00:01');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    expect(await d.findByText('La cita debe ser en el futuro')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
  });

  it('si algún recordatorio saldría con la ventana de 24 h cerrada, exige una plantilla y los valores de sus variables', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: false, expires_at: null } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:00');
    await userEvent.click(await d.findByRole('button', { name: 'Agendar' }));
    expect(await d.findByText(/Elige una plantilla aprobada/)).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText('Plantilla'), 't1');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    expect(await d.findByText('Llena todos los valores de la plantilla')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Valor de {{1}}'), 'Ana');
    await userEvent.type(d.getByLabelText('Valor de {{2}}'), 'mañana a las 10');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toMatchObject({ reminder_template_id: 't1', reminder_params: { 'body:1': 'Ana', 'body:2': 'mañana a las 10' } });
  });

  it('sin plantilla ni recordatorios dentro de la ventana no se pide plantilla', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: true, expires_at: new Date(Date.now() + 40 * HOUR).toISOString() } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:00');
    expect(d.queryByLabelText('Plantilla')).toBeNull();
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).not.toHaveProperty('reminder_template_id');
  });

  it('si el envío falla y se reintenta se reutiliza la MISMA llave', async () => {
    const w = world({ failFirst: true, options: { ...OPTIONS, window: { open: true, expires_at: new Date(Date.now() + 60 * HOUR).toISOString() } } }); // ventana abierta de sobra: el resultado no depende de la hora a la que corra la prueba
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:00');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    await userEvent.click(await d.findByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(2));
    expect(w.posts[1]!.key).toBe(w.posts[0]!.key);
  });

  it('explica por qué no se puede agendar y no ofrece el botón', async () => {
    mockApi(server(world({ options: { ...OPTIONS, blocked: 'channel_off' } })));
    renderApp('/inbox/c1');
    const d = await openDialog();
    expect(await d.findByText(/conexión de WhatsApp de esta conversación está desactivada/)).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Agendar' })).toBeNull();
  });

  it('quien solo colabora en la conversación no ve el botón', async () => {
    const routes = server(world());
    routes['GET /conversations/c1'] = () => ({ body: conv({ my_access: 'collaborator_view' }) });
    mockApi(routes);
    renderApp('/inbox/c1');
    await screen.findByRole('heading', { name: 'Ana Torres' });
    expect(screen.queryByRole('button', { name: 'Agendar' })).toBeNull();
  });
});

describe('Agenda', () => {
  it('la sección está en el menú; lista las citas de la semana por día, en la hora de la empresa', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    expect(await screen.findByRole('link', { name: 'Agenda' })).toHaveAttribute('href', '/agenda');
    const item = await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' });
    expect(item).toHaveTextContent('Corte');
    expect(item).toHaveTextContent('1/2 recordatorios enviados');
    expect(screen.getByText(/Hora de la empresa: America\/Guayaquil/)).toBeInTheDocument();
    const [from, to] = w.agendaQueries.at(-1)!.split('|') as [string, string];
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * 24 * HOUR);
    expect(isoToZoned(from, TZ).time).toBe('00:00'); // la semana empieza a las 00:00 de la empresa
  });

  it('navega por semanas', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' });
    const before = w.agendaQueries.at(-1)!;
    await userEvent.click(screen.getByRole('button', { name: 'Semana siguiente' }));
    await waitFor(() => expect(w.agendaQueries.at(-1)).not.toBe(before));
    const [f0] = before.split('|') as [string];
    const [f1] = w.agendaQueries.at(-1)!.split('|') as [string];
    expect(Date.parse(f1) - Date.parse(f0)).toBe(7 * 24 * HOUR);
    expect(screen.getByRole('button', { name: 'Hoy' })).toBeInTheDocument();
  });

  it('el detalle muestra cada recordatorio con su estado, su entrega y por qué no salió', async () => {
    mockApi(server(world()));
    renderApp('/agenda');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    const list = within(await d.findByRole('region', { name: 'Recordatorios' }));
    expect(list.getByText('1 hora antes')).toBeInTheDocument();
    expect(list.getByText('entregado')).toBeInTheDocument();
    expect(list.getByText('Enviado')).toBeInTheDocument();
    expect(list.getByText('No se envió')).toBeInTheDocument();
    expect(list.getByText(/ventana de 24 h estaba cerrada y no hay plantilla/)).toBeInTheDocument();
  });

  it('reprograma con la hora de la empresa; cancela exigiendo un motivo; completa', async () => {
    const w = world();
    mockApi(server(w, ME_ADMIN));
    renderApp('/agenda');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    await userEvent.click(await d.findByRole('button', { name: 'Reprogramar' }));
    const day = d.getByLabelText('Día');
    await userEvent.clear(day);
    await userEvent.type(day, tomorrow());
    const hour = d.getByLabelText('Hora');
    await userEvent.clear(hour);
    await userEvent.type(hour, '16:45');
    await userEvent.click(d.getByRole('button', { name: 'Guardar nueva hora' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/appointments/a1', body: { starts_at: zonedToIso(tomorrow(), '16:45', TZ) } }));
    expect(await d.findByText(/Cita reprogramada/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Cancelar cita' }));
    await userEvent.click(d.getByRole('button', { name: 'Cancelar cita' }));
    expect(await d.findByText('Escribe el motivo')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Motivo'), 'El cliente no puede');
    await userEvent.click(d.getByRole('button', { name: 'Cancelar cita' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/appointments/a1/cancel', body: { reason: 'El cliente no puede' } }));
    expect(await d.findByText(/Cancelada: El cliente no puede/)).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Reprogramar' })).toBeNull();
  });

  it('marcar completada', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    await userEvent.click(await d.findByRole('button', { name: 'Marcar completada' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/appointments/a1/complete' }));
    expect(await d.findByText('Cita completada')).toBeInTheDocument();
  });
});
