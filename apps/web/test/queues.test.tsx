import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue, QueueMember, QueueSimulation, WeekHours } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const member = (user_id: string, name: string, over: Partial<QueueMember> = {}): QueueMember => ({ user_id, name, role: 'advisor', active: false, weight: 1, open_count: 0, today_count: 0, ...over });
const people = (): QueueMember[] => [member('u1', 'Alicia Torres', { role: 'client_admin' }), member('u2', 'Carolina Vera'), member('u3', 'Eva Mora')];
const queue = (over: Partial<Queue> = {}): Queue => ({
  id: 'q1', name: 'Ventas', color: '#7c5cfa', distribution_on: false, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3, hours: null, open_now: true, members: people(), channels: [], unassigned_count: 0,
  created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z', ...over,
});

interface Calls { patches: unknown[]; puts: unknown[]; posts: unknown[]; sims: unknown[]; deletes: string[]; distributes: string[]; hours: unknown[] }

/** Servidor de colas con estado. mockApi no admite rutas con parámetros: se enrutan una a una (q1, q2). */
function server(initial: Queue[], o: { max?: number; sim?: QueueSimulation; distribute?: { assigned: number; remaining: number }; del?: () => ReturnType<Handler> } = {}) {
  const st = { items: initial, calls: { patches: [], puts: [], posts: [], sims: [], deletes: [], distributes: [], hours: [] } as Calls, clock: 0 };
  const touch = (q: Queue): Queue => ({ ...q, updated_at: new Date(Date.UTC(2026, 9, 19, 12, 0, ++st.clock)).toISOString() });
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /queues': () => ({ body: { items: structuredClone(st.items), limits: { max_queues: o.max ?? 20 } } }),
    'POST /queues': ({ body }) => {
      st.calls.posts.push(body);
      const b = body as { name: string; color?: string };
      const created = queue({ id: `q${st.items.length + 1}`, name: b.name, color: b.color ?? '#7c5cfa' });
      st.items = [...st.items, created];
      return { status: 201, body: created };
    },
  };
  for (const id of ['q1', 'q2', 'q3']) {
    routes[`PATCH /queues/${id}`] = ({ body }) => {
      st.calls.patches.push(body);
      const b = body as Partial<Queue>;
      st.items = st.items.map((q) => (q.id === id ? touch({ ...q, ...b }) : q));
      return { body: st.items.find((q) => q.id === id) };
    };
    routes[`PUT /queues/${id}/members`] = ({ body }) => {
      st.calls.puts.push(body);
      const list = (body as { members: Array<{ user_id: string; active: boolean; weight: number }> }).members;
      st.items = st.items.map((q) => (q.id === id ? touch({ ...q, members: q.members.map((m) => ({ ...m, ...(list.find((x) => x.user_id === m.user_id) ?? {}) })) }) : q));
      return { body: st.items.find((q) => q.id === id) };
    };
    routes[`PUT /queues/${id}/hours`] = ({ body }) => {
      st.calls.hours.push(body);
      const days = (body as { days: WeekHours | null }).days;
      st.items = st.items.map((q) => (q.id === id ? touch({ ...q, hours: days }) : q));
      return { body: st.items.find((q) => q.id === id) };
    };
    routes[`DELETE /queues/${id}`] = o.del ?? (() => { st.calls.deletes.push(id); st.items = st.items.filter((q) => q.id !== id); return { body: { id, archived: true } }; });
    routes[`POST /queues/${id}/simulate`] = ({ body }) => { st.calls.sims.push(body); return { body: o.sim ?? { sequence: [], counts: [], stopped_early: true } }; };
    routes[`POST /queues/${id}/distribute`] = () => { st.calls.distributes.push(id); return { body: o.distribute ?? { assigned: 0, remaining: 0 } }; };
  }
  return { st, routes };
}

const open = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Configurar ${name}` }));
  return within(await screen.findByRole('dialog', { name: `Configurar ${name}` }));
};

describe('Configuración › Colas', () => {
  it('sin colas explica qué pasa y ofrece crear la primera; la pestaña lleva a /settings/queues', async () => {
    mockApi(server([]).routes);
    renderApp('/settings/queues');
    expect(await screen.findByText(/Aún no hay colas/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Colas' })).toHaveAttribute('href', '/settings/queues');
    expect(screen.getByRole('button', { name: 'Nueva cola' })).toBeEnabled();
  });

  it('cada cola es una tarjeta: reparto activo o manual, asesores, modo, conexiones y los «sin asignar»', async () => {
    const q1 = queue({ distribution_on: true, mode: 'weighted', members: [member('u1', 'Alicia Torres', { active: true }), member('u2', 'Carolina Vera', { active: true }), member('u3', 'Eva Mora')], channels: [{ id: 'c1', name: 'Ventas WhatsApp' }], unassigned_count: 3 });
    const q2 = queue({ id: 'q2', name: 'Soporte' });
    mockApi(server([q1, q2]).routes);
    renderApp('/settings/queues');
    const a = within(await screen.findByRole('button', { name: 'Configurar Ventas' }));
    expect(a.getByText('Reparto activo')).toBeInTheDocument();
    expect(a.getByText('2 asesores')).toBeInTheDocument();
    expect(a.getByText('Ponderado')).toBeInTheDocument();
    expect(a.getByText('3 sin asignar')).toBeInTheDocument();
    const b = within(screen.getByRole('button', { name: 'Configurar Soporte' }));
    expect(b.getByText('Reparto manual')).toBeInTheDocument();
    expect(b.getByText('Sin asesores activos')).toBeInTheDocument();
    expect(b.queryByText(/sin asignar/)).not.toBeInTheDocument();
  });

  it('crea una cola (valida el nombre) y abre su configuración', async () => {
    const s = server([]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva cola' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva cola' }));
    await userEvent.click(d.getByRole('button', { name: 'Crear cola' }));
    expect(d.getByText('Escribe el nombre de la cola')).toBeInTheDocument();
    expect(s.st.calls.posts).toEqual([]);
    await userEvent.type(d.getByLabelText('Nombre'), '  Ventas ');
    await userEvent.click(d.getByRole('radio', { name: 'Color #0b7a6b' }));
    await userEvent.click(d.getByRole('button', { name: 'Crear cola' }));
    expect(s.st.calls.posts).toEqual([{ name: 'Ventas', color: '#0b7a6b' }]);
    expect(await screen.findByRole('dialog', { name: 'Configurar Ventas' })).toBeInTheDocument();
  });

  it('un error al crear (nombre repetido) se muestra y se puede corregir', async () => {
    const s = server([queue()]);
    s.routes['POST /queues'] = () => err(409, 'QUEUE_EXISTS', 'Ya existe una cola con ese nombre');
    mockApi(s.routes);
    renderApp('/settings/queues');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva cola' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva cola' }));
    await userEvent.type(d.getByLabelText('Nombre'), 'Ventas');
    await userEvent.click(d.getByRole('button', { name: 'Crear cola' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Ya existe una cola con ese nombre');
  });

  it('el botón «Nueva cola» se desactiva al llegar al máximo de colas', async () => {
    mockApi(server([queue(), queue({ id: 'q2', name: 'Soporte' })], { max: 2 }).routes);
    renderApp('/settings/queues');
    await screen.findByRole('button', { name: 'Configurar Ventas' });
    expect(screen.getByRole('button', { name: 'Nueva cola' })).toBeDisabled();
  });
});

describe('Configurar una cola', () => {
  it('enciende el reparto, elige asesores y modo ponderado con pesos y porcentajes, y guarda SOLO lo que cambió (ajustes y asesores por separado)', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByLabelText('Repartir las conversaciones nuevas automáticamente'));
    await userEvent.click(d.getByLabelText('Alicia Torres participa'));
    await userEvent.click(d.getByLabelText('Carolina Vera participa'));
    await userEvent.selectOptions(d.getByLabelText('Cómo repartir'), 'weighted');
    const w1 = d.getByLabelText('Peso de Alicia Torres');
    await userEvent.clear(w1);
    await userEvent.type(w1, '3');
    expect(d.queryByLabelText('Peso de Eva Mora')).not.toBeInTheDocument(); // quien no participa no tiene peso
    expect(d.getByText('75 %')).toBeInTheDocument(); // 3 de 4
    expect(d.getByText('25 %')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(s.st.calls.patches).toEqual([{ distribution_on: true, mode: 'weighted' }]);
    expect(s.st.calls.puts).toEqual([{ members: [{ user_id: 'u1', active: true, weight: 3 }, { user_id: 'u2', active: true, weight: 1 }, { user_id: 'u3', active: false, weight: 1 }] }]);
    // sin cambios no llama al servidor
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('No había cambios que guardar.')).toBeInTheDocument();
    expect(s.st.calls.patches).toHaveLength(1);
    expect(s.st.calls.puts).toHaveLength(1);
  });

  it('solo cambiar los asesores no toca los ajustes, y al revés', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByLabelText('Eva Mora participa'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await d.findByText('Cambios guardados.');
    expect(s.st.calls.patches).toEqual([]);
    expect(s.st.calls.puts).toHaveLength(1);
    const batch = d.getByLabelText('Conversaciones seguidas por asesor');
    await userEvent.clear(batch);
    await userEvent.type(batch, '3');
    await userEvent.click(d.getByLabelText('Aplicar solo a contactos sin dueño'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.st.calls.patches).toHaveLength(1));
    expect(s.st.calls.patches[0]).toEqual({ batch: 3, only_unassigned: false });
    expect(s.st.calls.puts).toHaveLength(1);
  });

  it('valida en pantalla antes de enviar: nombre, lote, tope y pesos', async () => {
    const s = server([queue({ mode: 'weighted', members: [member('u1', 'Alicia Torres', { active: true }), member('u2', 'Carolina Vera')] })]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.clear(d.getByLabelText('Nombre de la cola'));
    await userEvent.clear(d.getByLabelText('Conversaciones seguidas por asesor'));
    await userEvent.type(d.getByLabelText('Conversaciones seguidas por asesor'), '0');
    await userEvent.clear(d.getByLabelText('Tope diario por asesor'));
    await userEvent.type(d.getByLabelText('Tope diario por asesor'), '-1');
    const w = d.getByLabelText('Peso de Alicia Torres');
    await userEvent.clear(w);
    await userEvent.type(w, '0');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(d.getByText('Escribe el nombre de la cola')).toBeInTheDocument();
    expect(d.getByText('Un número entero entre 1 y 50')).toBeInTheDocument();
    expect(d.getByText(/entre 0 y 1000/)).toBeInTheDocument();
    expect(d.getByText(/entre 1 y 100/)).toBeInTheDocument();
    expect(s.st.calls.patches).toEqual([]);
    expect(s.st.calls.puts).toEqual([]);
  });

  it('en el modo «menos conversaciones abiertas» no hay lote ni pesos; se ve la carga de cada asesor', async () => {
    mockApi(server([queue({ mode: 'load', members: [member('u1', 'Alicia Torres', { active: true, open_count: 4, today_count: 2 }), member('u2', 'Carolina Vera')] })]).routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    expect(d.queryByLabelText('Conversaciones seguidas por asesor')).not.toBeInTheDocument();
    expect(d.queryByLabelText('Peso de Alicia Torres')).not.toBeInTheDocument();
    expect(d.getByText('4 abiertas · 2 hoy')).toBeInTheDocument();
  });

  it('un error del servidor al guardar se muestra y no se pierde lo escrito', async () => {
    const s = server([queue()]);
    s.routes['PATCH /queues/q1'] = () => err(409, 'QUEUE_EXISTS', 'Ya existe una cola con ese nombre');
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    const name = d.getByLabelText('Nombre de la cola');
    await userEvent.clear(name);
    await userEvent.type(name, 'Soporte');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Ya existe una cola con ese nombre');
    expect(name).toHaveValue('Soporte');
  });

  it('una actualización de las cifras de fondo (sin asignar, carga) NO borra lo que la persona está escribiendo', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    const a = renderApp('/settings/queues');
    const d = await open('Ventas');
    const name = d.getByLabelText('Nombre de la cola');
    await userEvent.clear(name);
    await userEvent.type(name, 'Escribiendo');
    s.st.items = s.st.items.map((q) => ({ ...q, unassigned_count: 5 })); // cambia el servidor sin cambiar la cola
    await a.qc.invalidateQueries({ queryKey: ['queues'] });
    await d.findByText('Conversaciones sin asignar: 5');
    expect(name).toHaveValue('Escribiendo');
  });
});

const week = (over: Partial<WeekHours> = {}): WeekHours => ({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [], ...over });

describe('Horario y reasignación de una cola (M5.5b)', () => {
  it('muestra los valores por omisión (no respeta el horario, no reasigna, 3 rotaciones, sin horario propio) y la tarjeta avisa si la cola está cerrada', async () => {
    mockApi(server([queue({ open_now: false })]).routes);
    renderApp('/settings/queues');
    expect(within(await screen.findByRole('button', { name: 'Configurar Ventas' })).getByText('Cerrada ahora')).toBeInTheDocument();
    const d = await open('Ventas');
    const sec = within(d.getByRole('region', { name: 'Horario y reasignación' }));
    expect(sec.getByText('Cerrada ahora')).toBeInTheDocument();
    expect(sec.getByLabelText('Respetar el horario al repartir')).not.toBeChecked();
    expect(sec.getByLabelText('Reasignar si nadie responde en (minutos)')).toHaveValue('0');
    expect(sec.getByLabelText('Máximo de reasignaciones')).toHaveValue('3');
    expect(sec.getByLabelText('Esta cola tiene su propio horario')).not.toBeChecked();
    expect(sec.getByText(/Usa el horario de la empresa/)).toBeInTheDocument();
    expect(sec.queryByRole('list', { name: 'Horario semanal' })).not.toBeInTheDocument();
  });

  it('guarda SOLO lo que cambió: respetar el horario, minutos para reasignar y máximo de rotaciones (un PATCH, sin tocar asesores ni horario)', async () => {
    const s = server([queue({ distribution_on: true })]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByLabelText('Respetar el horario al repartir'));
    await userEvent.clear(d.getByLabelText('Reasignar si nadie responde en (minutos)'));
    await userEvent.type(d.getByLabelText('Reasignar si nadie responde en (minutos)'), '10');
    await userEvent.clear(d.getByLabelText('Máximo de reasignaciones'));
    await userEvent.type(d.getByLabelText('Máximo de reasignaciones'), '2');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(s.st.calls.patches).toEqual([{ respect_hours: true, reassign_minutes: 10, max_rotations: 2 }]);
    expect(s.st.calls.puts).toEqual([]);
    expect(s.st.calls.hours).toEqual([]);
  });

  it('valida en pantalla los minutos (0–1440) y las rotaciones (1–10) antes de enviar', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.clear(d.getByLabelText('Reasignar si nadie responde en (minutos)'));
    await userEvent.type(d.getByLabelText('Reasignar si nadie responde en (minutos)'), '1500');
    await userEvent.clear(d.getByLabelText('Máximo de reasignaciones'));
    await userEvent.type(d.getByLabelText('Máximo de reasignaciones'), '0');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Un número entero de minutos entre 0 y 1440 (0 = no reasignar)')).toBeInTheDocument();
    expect(d.getByText('Un número entero entre 1 y 10')).toBeInTheDocument();
    expect(s.st.calls.patches).toEqual([]);
  });

  it('horario propio: al activarlo parte de lunes a viernes 08:30–18:00; se valida y se guarda con su propio PUT, sin tocar los demás ajustes', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByLabelText('Esta cola tiene su propio horario'));
    expect(d.getByLabelText('Lunes tramo 1 desde')).toHaveValue('08:30');
    expect(d.getByLabelText('Sábado abierto')).not.toBeChecked();
    // una hora imposible no se envía
    await userEvent.clear(d.getByLabelText('Lunes tramo 1 hasta'));
    await userEvent.type(d.getByLabelText('Lunes tramo 1 hasta'), '7:00');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText(/Lunes, tramo 1: la hora de fin debe ser HH:MM/)).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([]);
    await userEvent.clear(d.getByLabelText('Lunes tramo 1 hasta'));
    await userEvent.type(d.getByLabelText('Lunes tramo 1 hasta'), '17:00');
    await userEvent.click(d.getByLabelText('Viernes abierto'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([{ days: week({ mon: [['08:30', '17:00']], tue: [['08:30', '18:00']], wed: [['08:30', '18:00']], thu: [['08:30', '18:00']] }) }]);
    expect(s.st.calls.patches).toEqual([]);
    expect(await d.findByText(/Guardado: Lun 08:30–17:00 · Mar a Jue 08:30–18:00/)).toBeInTheDocument();
  });

  it('con horario propio ya guardado se ve en el editor; quitarlo («usa el de la empresa») envía days: null', async () => {
    const own = week({ mon: [['10:00', '12:00']], tue: [['10:00', '12:00']] });
    const s = server([queue({ hours: own })]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    expect(d.getByLabelText('Esta cola tiene su propio horario')).toBeChecked();
    expect(d.getByLabelText('Lunes tramo 1 desde')).toHaveValue('10:00');
    expect(d.getByLabelText('Miércoles abierto')).not.toBeChecked();
    await userEvent.click(d.getByLabelText('Esta cola tiene su propio horario'));
    expect(d.queryByRole('list', { name: 'Horario semanal' })).not.toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([{ days: null }]);
  });

  it('sin cambios no envía nada ni toca el horario', async () => {
    const s = server([queue({ hours: week({ mon: [['10:00', '12:00']] }) })]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('No había cambios que guardar.')).toBeInTheDocument();
    expect([s.st.calls.patches, s.st.calls.puts, s.st.calls.hours]).toEqual([[], [], []]);
  });
});

describe('Simulador y «sin asignar»', () => {
  it('simula con lo que hay en pantalla (sin guardarlo) y muestra el reparto y el orden', async () => {
    const sim: QueueSimulation = { sequence: [{ user_id: 'u1', name: 'Alicia Torres' }, { user_id: 'u2', name: 'Carolina Vera' }, { user_id: 'u1', name: 'Alicia Torres' }], counts: [{ user_id: 'u1', name: 'Alicia Torres', count: 2 }, { user_id: 'u2', name: 'Carolina Vera', count: 1 }], stopped_early: true };
    const s = server([queue()], { sim });
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByLabelText('Alicia Torres participa'));
    await userEvent.click(d.getByLabelText('Carolina Vera participa'));
    await userEvent.selectOptions(d.getByLabelText('Cómo repartir'), 'weighted');
    await userEvent.click(d.getByRole('button', { name: 'Simular 20 conversaciones' }));
    const r = within(await d.findByRole('region', { name: 'Resultado de la simulación' }));
    expect(r.getByText('Alicia Torres: 2 · Carolina Vera: 1')).toBeInTheDocument();
    expect(r.getByLabelText('Orden de asignación').children).toHaveLength(3);
    expect(r.getByText(/Se detuvo en 3/)).toBeInTheDocument();
    expect(s.st.calls.sims).toEqual([{ count: 20, mode: 'weighted', batch: 1, daily_cap: 0, members: [{ user_id: 'u1', active: true, weight: 1 }, { user_id: 'u2', active: true, weight: 1 }] }]);
    expect(s.st.calls.patches).toEqual([]); // nada se guardó
    expect(s.st.calls.puts).toEqual([]);
  });

  it('sin asesores activos la simulación lo dice', async () => {
    mockApi(server([queue()]).routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByRole('button', { name: 'Simular 20 conversaciones' }));
    expect(await d.findByText('No hay a quién asignar: elige al menos un asesor.')).toBeInTheDocument();
  });

  it('«Repartir ahora» solo se puede con el reparto encendido y guardado y conversaciones esperando; informa el resultado', async () => {
    const s = server([queue({ distribution_on: true, unassigned_count: 4, members: [member('u1', 'Alicia Torres', { active: true })] }), queue({ id: 'q2', name: 'Soporte', distribution_on: false, unassigned_count: 2 })], { distribute: { assigned: 3, remaining: 1 } });
    mockApi(s.routes);
    renderApp('/settings/queues');
    let d = await open('Soporte');
    expect(d.getByRole('button', { name: 'Repartir ahora' })).toBeDisabled();
    expect(d.getByText('Enciende y guarda el reparto para poder repartir.')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Cerrar' }));
    d = await open('Ventas');
    await userEvent.click(d.getByRole('button', { name: 'Repartir ahora' }));
    expect(await d.findByText('Se asignaron 3 conversaciones; quedan 1 sin asignar.')).toBeInTheDocument();
    expect(s.st.calls.distributes).toEqual(['q1']);
  });

  it('sin conversaciones esperando, «Repartir ahora» está desactivado', async () => {
    mockApi(server([queue({ distribution_on: true })]).routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    expect(d.getByRole('button', { name: 'Repartir ahora' })).toBeDisabled();
  });
});

describe('Archivar y permisos', () => {
  it('archivar pide confirmación; «No» la cancela; al confirmar la cola desaparece', async () => {
    const s = server([queue()]);
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    await userEvent.click(d.getByRole('button', { name: 'Archivar cola' }));
    expect(d.getByText(/¿Archivar «Ventas»\?/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'No' }));
    expect(s.st.calls.deletes).toEqual([]);
    await userEvent.click(d.getByRole('button', { name: 'Archivar cola' }));
    await userEvent.click(d.getByRole('button', { name: 'Sí, archivar' }));
    expect(await screen.findByText(/Aún no hay colas/)).toBeInTheDocument();
    expect(s.st.calls.deletes).toEqual(['q1']);
  });

  it('si una conexión la usa, el motivo se explica y la cola sigue ahí', async () => {
    const s = server([queue({ channels: [{ id: 'c1', name: 'Ventas WhatsApp' }] })], { del: () => err(409, 'QUEUE_IN_USE', 'Hay conexiones que usan esta cola. Cámbialas de cola en «Conexiones» antes de archivarla') });
    mockApi(s.routes);
    renderApp('/settings/queues');
    const d = await open('Ventas');
    expect(d.getByText('Ventas WhatsApp')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Archivar cola' }));
    await userEvent.click(d.getByRole('button', { name: 'Sí, archivar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Hay conexiones que usan esta cola');
    expect(screen.getByRole('dialog', { name: 'Configurar Ventas' })).toBeInTheDocument();
  });

  it('sin permiso (403) se explica y no se ofrece crear nada', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /queues': () => err(403, 'FORBIDDEN') });
    renderApp('/settings/queues');
    expect(await screen.findByRole('alert')).toHaveTextContent('Solo el administrador de la empresa puede ver y cambiar las colas.');
    expect(screen.queryByRole('button', { name: 'Nueva cola' })).not.toBeInTheDocument();
  });
});
