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
  calendar: { state: 'none' },
};
const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'a1', contact: { id: 'k1', name: 'Ana Torres' }, conversation_id: 'c1', owner: { id: 'u2', name: 'Luis Navas' }, starts_at: new Date(Date.now() + 3 * HOUR).toISOString(),
  ends_at: new Date(Date.now() + 3.5 * HOUR).toISOString(), duration_minutes: 30, kind: 'Corte', notes: null, status: 'scheduled', cancel_reason: null, created_at: NOW,
  reminders: [
    { id: 'r1', offset_minutes: 60, send_at: new Date(Date.now() + 2 * HOUR).toISOString(), status: 'sent', via: 'text', reason: null, delivery: 'delivered' },
    { id: 'r2', offset_minutes: 10, send_at: new Date(Date.now() + 2.8 * HOUR).toISOString(), status: 'skipped', via: null, reason: 'window_closed', delivery: null },
  ],
  reminder_offsets: [60, 10], reminder_template: null, can: { edit: true, cancel: true, complete: true }, calendar: { enabled: true, state: 'synced' }, ...over,
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
    'PATCH /appointments/a1': (c) => { record(c); const b = c.body as { starts_at?: string; calendar_event?: boolean }; w.appt = appt({ ...(b.starts_at ? { starts_at: b.starts_at } : {}), ...(b.calendar_event !== undefined ? { calendar: { enabled: b.calendar_event, state: b.calendar_event ? 'pending' : 'off' } } : {}) }); return { body: w.appt }; },
    'POST /appointments/a1/cancel': (c) => { record(c); w.appt = appt({ status: 'cancelled', cancel_reason: (c.body as { reason: string }).reason, can: { edit: false, cancel: false, complete: false } }); return { body: w.appt }; },
    'POST /appointments/a1/complete': (c) => { record(c); w.appt = appt({ status: 'completed', can: { edit: false, cancel: false, complete: false } }); return { body: w.appt }; },
  };
}

const tomorrow = (): string => addDays(todayIn(TZ), 1);
const openDialog = async () => {
  // v13 S2.2: «Agendar» es un icono de la cabecera del chat (también sigue en la ficha del contacto)
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
    await userEvent.selectOptions(d.getByLabelText('Tipo de cita'), 'Otro (escribir)…');
    await userEvent.type(d.getByLabelText('Escribe el tipo de cita'), 'Corte y barba');
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
    await fillWhen(d, addDays(todayIn(TZ), -1), '12:00'); // ayer: siempre es pasado (con «hoy 00:01» la prueba fallaba en el primer minuto del día de la empresa)
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
    await userEvent.click(await screen.findByRole('button', { name: 'Datos del contacto' }));
    await screen.findByRole('complementary', { name: 'Datos del contacto' });
    expect(screen.queryByRole('button', { name: 'Agendar' })).toBeNull();
  });
});

/** Abre la cita de Ana desde el calendario (siempre está en el mes que se ve, sin importar la hora del día en que corra la prueba). */
const openAna = async (): Promise<void> => { await userEvent.click((await screen.findAllByRole('button', { name: /^Abrir la cita de Ana Torres/ }))[0]!); };

describe('Agenda', () => {

  it('la sección está en el menú; muestra SIEMPRE un calendario del mes con la cita y, al elegir su día, la lista con sus datos, en la hora de la empresa', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    expect(await screen.findByRole('link', { name: 'Agenda' })).toHaveAttribute('href', '/agenda');
    const grid = await screen.findByRole('grid', { name: /^Calendario de / });
    expect(screen.getByRole('button', { name: 'Mes' })).toHaveAttribute('aria-pressed', 'true');
    // el día de la cita queda marcado: lo dice su nombre accesible
    const day = await within(grid).findByRole('button', { name: /, 1 cita$/ });
    await userEvent.click(day);
    const item = await screen.findByRole('button', { name: 'Abrir la cita de Ana Torres' });
    expect(item).toHaveTextContent('Corte');
    expect(item).toHaveTextContent('1/2 recordatorios enviados');
    expect(screen.getByText(/Hora de la empresa: America\/Guayaquil/)).toBeInTheDocument();
    const [from, to] = w.agendaQueries.at(-1)!.split('|') as [string, string];
    expect(Date.parse(to) - Date.parse(from)).toBe(42 * 24 * HOUR); // seis semanas completas
    expect(isoToZoned(from, TZ).time).toBe('00:00'); // empieza a las 00:00 de la empresa
  });

  const CONNECTION = { configured: true, available: true, unavailable_reason: null, mode: 'own', calendar_name: 'Sales Smart · Growth', account: 'j***@g***.com', scopes: [], last_error: null, connected_at: NOW };
  const cases = [
    ['connected', /Conectado a Google Calendar · Sales Smart · Growth/, 'Ver conexión'],
    ['needs_reconnect', /necesita volver a conectarse/, 'Reconectar'],
    ['pending_calendar', /Falta elegir el calendario/, 'Elegir calendario'],
    [null, /Aún no hay ningún calendario conectado/, 'Conectar calendario'],
  ] as const;
  for (const [status, text, link] of cases) {
    it(`el aviso de la agenda sigue la conexión real de Google (${status ?? 'sin conexión'}) y lleva a Configuración › Google Calendar`, async () => {
      mockApi({ ...server(world(), ME_ADMIN), 'GET /calendar/connection': () => ({ body: { ...CONNECTION, status } }) });
      renderApp('/agenda');
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: link })).toHaveAttribute('href', '/settings/calendar');
    });
  }

  it('el asesor no ve el aviso del calendario ni consulta la conexión (es del administrador)', async () => {
    let asked = false;
    mockApi({ ...server(world()), 'GET /calendar/connection': () => { asked = true; return err(403, 'FORBIDDEN', 'Sin permiso'); } });
    renderApp('/agenda');
    await screen.findByRole('grid', { name: /^Calendario de / });
    expect(screen.queryByRole('link', { name: /Ver conexión|Reconectar|Elegir calendario|Conectar calendario/ })).not.toBeInTheDocument();
    expect(asked).toBe(false);
  });

  it('si no se puede consultar la conexión no afirma que no esté conectada', async () => {
    mockApi({ ...server(world(), ME_ADMIN), 'GET /calendar/connection': () => err(500, 'INTERNAL_ERROR', 'Error') });
    renderApp('/agenda');
    await screen.findByRole('grid', { name: /^Calendario de / });
    expect(screen.queryByText(/Aún no hay ningún calendario conectado/)).not.toBeInTheDocument();
  });

  it('cambia entre mes y semana, y navega por periodos', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    await screen.findByRole('grid', { name: /^Calendario de / });
    await userEvent.click(screen.getByRole('button', { name: 'Semana' }));
    await waitFor(() => {
      const [f0, t0] = w.agendaQueries.at(-1)!.split('|') as [string, string];
      expect(Date.parse(t0) - Date.parse(f0)).toBe(7 * 24 * HOUR);
    });
    const before = w.agendaQueries.at(-1)!;
    await userEvent.click(screen.getByRole('button', { name: 'Semana siguiente' }));
    await waitFor(() => expect(w.agendaQueries.at(-1)).not.toBe(before));
    const [f0] = before.split('|') as [string];
    const [f1] = w.agendaQueries.at(-1)!.split('|') as [string];
    expect(Date.parse(f1) - Date.parse(f0)).toBe(7 * 24 * HOUR);
    expect(screen.getByRole('button', { name: 'Hoy' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mes' }));
    expect(await screen.findByRole('button', { name: 'Mes siguiente' })).toBeInTheDocument();
  });

  it('el detalle muestra cada recordatorio con su estado, su entrega y por qué no salió', async () => {
    mockApi(server(world()));
    renderApp('/agenda');
    await openAna();
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
    await openAna();
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
    await openAna();
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    await userEvent.click(await d.findByRole('button', { name: 'Marcar completada' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/appointments/a1/complete' }));
    expect(await d.findByText('Cita completada')).toBeInTheDocument();
  });
});

describe('Agendar · canales sin ventana de 24 h (QR y GoHighLevel)', () => {
  it('con la ventana abierta y sin fecha de cierre, los recordatorios NO piden plantilla y la cita sale sin ella', async () => {
    const w = world({ options: { ...OPTIONS, max_reminders: 5, window: { open: true, expires_at: null }, templates: [] } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:30');
    await userEvent.click(d.getByRole('checkbox', { name: '2 días antes' }));
    expect(d.queryByText(/solo se puede enviar con una plantilla aprobada/)).not.toBeInTheDocument();
    expect(d.queryByLabelText('Plantilla')).not.toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).not.toHaveProperty('reminder_template_id');
    expect((w.posts[0]!.body as { reminders: number[] }).reminders).toContain(2880);
  });

  it('con la ventana CERRADA (WhatsApp oficial) los recordatorios sí piden plantilla', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: false, expires_at: null } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:30');
    expect(await d.findByText(/solo se puede enviar con una plantilla aprobada/)).toBeInTheDocument();
  });
});

describe('Agendar · tipo de cita: lista o texto libre (67c)', () => {
  it('ofrece la lista, y elegir un tipo de la lista lo manda tal cual', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: true, expires_at: new Date(Date.now() + 60 * HOUR).toISOString() } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    const select = d.getByLabelText('Tipo de cita') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Cita', 'Visita al local', 'Llamada de cierre', 'Reunión virtual', 'Entrega de propuesta', 'Consulta', 'Seguimiento', 'Otro (escribir)…']);
    expect(select.value).toBe('Cita');
    expect(d.queryByLabelText('Escribe el tipo de cita')).not.toBeInTheDocument();
    await fillWhen(d, tomorrow(), '10:30');
    await userEvent.selectOptions(select, 'Visita al local');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect((w.posts[0]!.body as { kind: string }).kind).toBe('Visita al local');
  });

  it('«Otro» abre un campo para escribir el tipo, que es obligatorio; al volver a la lista desaparece', async () => {
    const w = world({ options: { ...OPTIONS, window: { open: true, expires_at: new Date(Date.now() + 60 * HOUR).toISOString() } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await fillWhen(d, tomorrow(), '10:30');
    await userEvent.selectOptions(d.getByLabelText('Tipo de cita'), 'Otro (escribir)…');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    expect(await d.findByText('Escribe el tipo de cita', { selector: 'span' })).toBeInTheDocument();
    expect(w.posts).toEqual([]);
    await userEvent.selectOptions(d.getByLabelText('Tipo de cita'), 'Consulta');
    expect(d.queryByLabelText('Escribe el tipo de cita')).not.toBeInTheDocument();
  });
});

describe('Agendar · interruptor «Crear evento en Google Calendar» (67c)', () => {
  const open60 = { window: { open: true, expires_at: new Date(Date.now() + 60 * HOUR).toISOString() } };

  it('con el calendario conectado está encendido por omisión y manda calendar_event; apagado manda false', async () => {
    const w = world({ options: { ...OPTIONS, ...open60, calendar: { state: 'connected' } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    const sw = d.getByRole('switch', { name: /Crear evento en Google Calendar/ });
    expect(sw).toBeChecked();
    await fillWhen(d, tomorrow(), '10:30');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect((w.posts[0]!.body as { calendar_event?: boolean }).calendar_event).toBe(true);
  });

  it('apagarlo manda calendar_event: false', async () => {
    const w = world({ options: { ...OPTIONS, ...open60, calendar: { state: 'connected' } } });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.click(d.getByRole('switch', { name: /Crear evento en Google Calendar/ }));
    await fillWhen(d, tomorrow(), '10:30');
    await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect((w.posts[0]!.body as { calendar_event?: boolean }).calendar_event).toBe(false);
  });

  for (const [state, text] of [['none', /No hay un calendario de Google conectado/], ['needs_reconnect', /necesita volver a conectarse/], ['pending_calendar', /Falta elegir el calendario/]] as const) {
    it(`calendario «${state}»: el interruptor queda apagado y bloqueado, explica por qué y lleva a Configuración; no manda el campo`, async () => {
      const w = world({ options: { ...OPTIONS, ...open60, calendar: { state } } });
      mockApi(server(w));
      renderApp('/inbox/c1');
      const d = await openDialog();
      const sw = d.getByRole('switch', { name: /Crear evento en Google Calendar/ });
      expect(sw).toBeDisabled();
      expect(sw).not.toBeChecked();
      expect(d.getByText(text)).toBeInTheDocument();
      expect(d.getByRole('link', { name: /Ir a Configuración › Google Calendar/ })).toHaveAttribute('href', '/settings/calendar');
      await fillWhen(d, tomorrow(), '10:30');
      await userEvent.click(d.getByRole('button', { name: 'Agendar' }));
      await waitFor(() => expect(w.posts).toHaveLength(1));
      expect(w.posts[0]!.body).not.toHaveProperty('calendar_event');
    });
  }
});

describe('Agenda · marca y cambio de Google Calendar por cita (67c)', () => {
  it('el detalle muestra cómo va el evento en Google; sin estado no muestra marca', async () => {
    mockApi(server(world({ appt: appt({ calendar: { enabled: true, state: 'failed' } }) })));
    renderApp('/agenda');
    await openAna();
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    expect(await d.findByText('No se pudo enviar a Google')).toBeInTheDocument();
  });

  it('una cita ya sincronizada se puede quitar de Google Calendar y volver a enviar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agenda');
    await openAna();
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    expect(await d.findByText('En Google Calendar')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Quitar de Google Calendar' }));
    await waitFor(() => expect(w.posts.some((p) => p.path.includes('/appointments/a1') && (p.body as { calendar_event?: boolean }).calendar_event === false)).toBe(true));
    expect(await d.findByText('Sin Google Calendar')).toBeInTheDocument();
    await userEvent.click(await d.findByRole('button', { name: 'Enviar a Google Calendar' }));
    await waitFor(() => expect(w.posts.some((p) => (p.body as { calendar_event?: boolean }).calendar_event === true)).toBe(true));
    expect(await d.findByText('Enviando a Google')).toBeInTheDocument();
  });

  it('una cita cerrada o sin permiso de edición no ofrece cambiarlo', async () => {
    mockApi(server(world({ appt: appt({ can: { edit: false, cancel: false, complete: false } }) })));
    renderApp('/agenda');
    await openAna();
    const d = within(await screen.findByRole('dialog', { name: 'Cita' }));
    await d.findByText('En Google Calendar');
    expect(d.queryByRole('button', { name: 'Quitar de Google Calendar' })).not.toBeInTheDocument();
  });
});
