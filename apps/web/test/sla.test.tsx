import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAYS, summarizeWeek, validateWeek, defaultWeek, emptyWeek } from '../src/features/sla/hours';
import type { Holiday, SlaSettings, WeekHours } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const settings = (over: Partial<SlaSettings> = {}): SlaSettings => ({ policy: { target_minutes: 15, risk_minutes: 3 }, hours: null, holidays: [], time_zone: 'America/Guayaquil', open_now: true, ...over });
const holiday = (id: string, date: string, name: string, yearly = false): Holiday => ({ id, date, name, yearly });
/** Como lo devuelve la API: siempre los siete días. */
const full = (days: Partial<WeekHours>): WeekHours => ({ ...emptyWeek(), ...days });
const barber = (): WeekHours => full({ mon: [['08:30', '18:00']], tue: [['08:30', '18:00']], wed: [['08:30', '18:00']], thu: [['08:30', '18:00']], fri: [['08:30', '18:00']], sat: [['08:30', '13:00']] });

interface Calls { policy: unknown[]; hours: unknown[]; adds: unknown[]; removes: string[] }

/** Servidor del SLA con estado. mockApi no admite rutas con parámetros: los feriados se enrutan uno a uno (h1, h2, h3). */
function server(initial: SlaSettings, o: { add?: () => ReturnType<Handler>; forbidden?: boolean } = {}) {
  const st = { s: initial, calls: { policy: [], hours: [], adds: [], removes: [] } as Calls };
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /sla': () => (o.forbidden ? err(403, 'FORBIDDEN', 'No tienes permiso') : { body: structuredClone(st.s) }),
    'PUT /sla/policy': ({ body }) => {
      st.calls.policy.push(body);
      const b = body as { target_minutes: number; risk_minutes: number };
      st.s = { ...st.s, policy: b };
      return { body: st.s };
    },
    'PUT /sla/hours': ({ body }) => {
      st.calls.hours.push(body);
      const days = (body as { days: WeekHours | null }).days;
      st.s = { ...st.s, hours: days ? full(days) : null };
      return { body: st.s };
    },
    'POST /sla/holidays': (call) => {
      st.calls.adds.push(call.body);
      if (o.add) return o.add();
      const b = call.body as { date: string; name: string; yearly: boolean };
      const created = holiday(`h${st.s.holidays.length + 1}`, b.date, b.name, b.yearly);
      st.s = { ...st.s, holidays: [...st.s.holidays, created].sort((a, c) => a.date.localeCompare(c.date)) };
      return { status: 201, body: created };
    },
  };
  for (const id of ['h1', 'h2', 'h3']) {
    routes[`DELETE /sla/holidays/${id}`] = () => {
      st.calls.removes.push(id);
      st.s = { ...st.s, holidays: st.s.holidays.filter((h) => h.id !== id) };
      return { body: { id, removed: true } };
    };
  }
  return { st, routes };
}

const card = async (name: string) => within(await screen.findByRole('region', { name }));

describe('Configuración › SLA y horario', () => {
  it('la pestaña «SLA y horario» lleva a /settings/sla y muestra los valores por omisión: 15 min, 3 min de aviso, abierta siempre, sin feriados', async () => {
    mockApi(server(settings()).routes);
    renderApp('/settings/sla');
    expect(await screen.findByRole('link', { name: 'SLA y horario' })).toHaveAttribute('href', '/settings/sla');
    const p = await card('Objetivo de respuesta');
    expect(p.getByLabelText('Responder en (minutos)')).toHaveValue('15');
    expect(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)')).toHaveValue('3');
    expect((await card('Horario laboral')).getByRole('radio', { name: 'Abierta siempre' })).toBeChecked();
    expect((await card('Feriados')).getByText('Aún no hay feriados.')).toBeInTheDocument();
  });

  it('política: guarda el objetivo y el aviso; valida enteros y que el aviso no supere al objetivo', async () => {
    const s = server(settings());
    mockApi(s.routes);
    renderApp('/settings/sla');
    const p = await card('Objetivo de respuesta');
    expect(p.getByLabelText('Responder en (minutos)')).toHaveValue('15');
    expect(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)')).toHaveValue('3');
    // el aviso no puede ser mayor que el objetivo; un valor que no es entero se rechaza antes de enviar
    await userEvent.clear(p.getByLabelText('Responder en (minutos)'));
    await userEvent.type(p.getByLabelText('Responder en (minutos)'), '10');
    await userEvent.clear(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)'));
    await userEvent.type(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)'), '12');
    await userEvent.click(p.getByRole('button', { name: 'Guardar objetivo' }));
    expect(await p.findByText('El aviso no puede ser mayor que el objetivo')).toBeInTheDocument();
    await userEvent.clear(p.getByLabelText('Responder en (minutos)'));
    await userEvent.type(p.getByLabelText('Responder en (minutos)'), '1.5');
    await userEvent.click(p.getByRole('button', { name: 'Guardar objetivo' }));
    expect(await p.findByText('Un número entero de minutos entre 1 y 1440')).toBeInTheDocument();
    expect(s.st.calls.policy).toEqual([]);
    // valores buenos
    await userEvent.clear(p.getByLabelText('Responder en (minutos)'));
    await userEvent.type(p.getByLabelText('Responder en (minutos)'), '20');
    await userEvent.clear(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)'));
    await userEvent.type(p.getByLabelText('Avisar «en riesgo» cuando falten (minutos)'), '5');
    await userEvent.click(p.getByRole('button', { name: 'Guardar objetivo' }));
    expect(await p.findByText('Objetivo de respuesta guardado.')).toBeInTheDocument();
    expect(s.st.calls.policy).toEqual([{ target_minutes: 20, risk_minutes: 5 }]);
  });

  it('horario: «Abierta siempre» por omisión; el semanal parte de lunes a viernes 08:30–18:00, se edita, se valida y se guarda', async () => {
    const s = server(settings());
    mockApi(s.routes);
    renderApp('/settings/sla');
    const h = await card('Horario laboral');
    expect(h.getByText('America/Guayaquil')).toBeInTheDocument();
    expect(h.getByText('Abierta ahora')).toBeInTheDocument();
    expect(h.getByRole('radio', { name: 'Abierta siempre' })).toBeChecked();
    expect(h.queryByRole('list', { name: 'Horario semanal' })).not.toBeInTheDocument();
    await userEvent.click(h.getByRole('radio', { name: 'Horario semanal' }));
    expect(h.getByLabelText('Lunes abierto')).toBeChecked();
    expect(h.getByLabelText('Sábado abierto')).not.toBeChecked();
    expect(h.getByLabelText('Lunes tramo 1 desde')).toHaveValue('08:30');
    expect(h.getByLabelText('Lunes tramo 1 hasta')).toHaveValue('18:00');
    // una hora imposible se dice antes de enviar
    await userEvent.clear(h.getByLabelText('Martes tramo 1 desde'));
    await userEvent.type(h.getByLabelText('Martes tramo 1 desde'), '25:00');
    await userEvent.click(h.getByRole('button', { name: 'Guardar horario' }));
    expect(await h.findByText(/Martes, tramo 1: la hora de inicio debe ser HH:MM/)).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([]);
    // se corrige; se abre el sábado por la mañana, se cierra el viernes y el lunes pasa a dos tramos
    await userEvent.clear(h.getByLabelText('Martes tramo 1 desde'));
    await userEvent.type(h.getByLabelText('Martes tramo 1 desde'), '09:00');
    await userEvent.click(h.getByLabelText('Sábado abierto'));
    await userEvent.clear(h.getByLabelText('Sábado tramo 1 hasta'));
    await userEvent.type(h.getByLabelText('Sábado tramo 1 hasta'), '13:00');
    await userEvent.click(h.getByLabelText('Viernes abierto'));
    await userEvent.clear(h.getByLabelText('Lunes tramo 1 hasta'));
    await userEvent.type(h.getByLabelText('Lunes tramo 1 hasta'), '12:00');
    await userEvent.click(h.getByRole('button', { name: 'Agregar un tramo el lunes' }));
    expect(h.getByLabelText('Lunes tramo 2 desde')).toHaveValue('14:00');
    await userEvent.click(h.getByRole('button', { name: 'Guardar horario' }));
    expect(await h.findByText('Horario guardado.')).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([{ days: { mon: [['08:30', '12:00'], ['14:00', '18:00']], tue: [['09:00', '18:00']], wed: [['08:30', '18:00']], thu: [['08:30', '18:00']], fri: [], sat: [['08:30', '13:00']], sun: [] } }]);
    expect(await h.findByText(/Guardado: Lun 08:30–12:00 y 14:00–18:00/)).toBeInTheDocument();
  });

  it('el semanal exige al menos un día abierto, no admite más de tres tramos y se puede volver a «Abierta siempre»', async () => {
    const s = server(settings({ hours: barber(), open_now: false }));
    mockApi(s.routes);
    renderApp('/settings/sla');
    const h = await card('Horario laboral');
    expect(h.getByRole('radio', { name: 'Horario semanal' })).toBeChecked();
    expect(h.getByText('Cerrada ahora')).toBeInTheDocument();
    expect(h.getByLabelText('Sábado tramo 1 hasta')).toHaveValue('13:00');
    expect(h.getByText(/Guardado: Lun a Vie 08:30–18:00 · Sáb 08:30–13:00/)).toBeInTheDocument();
    // tres tramos como máximo
    await userEvent.click(h.getByRole('button', { name: 'Agregar un tramo el lunes' }));
    await userEvent.click(h.getByRole('button', { name: 'Agregar un tramo el lunes' }));
    expect(h.queryByRole('button', { name: 'Agregar un tramo el lunes' })).not.toBeInTheDocument();
    await userEvent.click(h.getByRole('button', { name: 'Quitar el tramo 3 del lunes' }));
    await userEvent.click(h.getByRole('button', { name: 'Quitar el tramo 2 del lunes' }));
    // ningún día abierto
    for (const d of WEEKDAYS) if ((h.getByLabelText(`${d.label} abierto`) as HTMLInputElement).checked) await userEvent.click(h.getByLabelText(`${d.label} abierto`));
    await userEvent.click(h.getByRole('button', { name: 'Guardar horario' }));
    expect(await h.findByText(/Abre al menos un día/)).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([]);
    // «Abierta siempre» quita el horario
    await userEvent.click(h.getByRole('radio', { name: 'Abierta siempre' }));
    await userEvent.click(h.getByRole('button', { name: 'Guardar horario' }));
    expect(await h.findByText('La empresa quedó abierta siempre.')).toBeInTheDocument();
    expect(s.st.calls.hours).toEqual([{ days: null }]);
  });

  it('feriados: se listan con su fecha y si se repiten; se agregan (con validación) y se quitan', async () => {
    const s = server(settings({ holidays: [holiday('h1', '2026-12-25', 'Navidad', true), holiday('h2', '2026-11-02', 'Difuntos')] }));
    mockApi(s.routes);
    renderApp('/settings/sla');
    const f = await card('Feriados');
    const list = within(f.getByRole('list', { name: 'Lista de feriados' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('25/12/2026')).toBeInTheDocument();
    expect(list.getByText('Cada año')).toBeInTheDocument();
    // sin fecha ni nombre no se envía
    await userEvent.click(f.getByRole('button', { name: 'Agregar feriado' }));
    expect(await f.findByText('Elige la fecha del feriado')).toBeInTheDocument();
    expect(f.getByText('Escribe cómo se llama')).toBeInTheDocument();
    expect(s.st.calls.adds).toEqual([]);
    fireEvent.change(f.getByLabelText('Fecha'), { target: { value: '2026-12-31' } });
    await userEvent.type(f.getByLabelText('Nombre'), '  Fin de año ');
    await userEvent.click(f.getByLabelText('Se repite cada año'));
    await userEvent.click(f.getByRole('button', { name: 'Agregar feriado' }));
    expect(await f.findByText('Feriado agregado.')).toBeInTheDocument();
    expect(s.st.calls.adds).toEqual([{ date: '2026-12-31', name: 'Fin de año', yearly: true }]);
    expect(await within(f.getByRole('list', { name: 'Lista de feriados' })).findByText('31/12/2026')).toBeInTheDocument();
    expect(f.getByLabelText('Nombre')).toHaveValue(''); // el formulario queda listo para otro
    // quitar
    await userEvent.click(f.getByRole('button', { name: 'Quitar el feriado Difuntos' }));
    await waitFor(() => expect(s.st.calls.removes).toEqual(['h2']));
    await waitFor(() => expect(f.queryByText('02/11/2026')).not.toBeInTheDocument());
  });

  it('un feriado repetido o el tope de feriados muestran el motivo que da el servidor', async () => {
    const s = server(settings(), { add: () => err(409, 'HOLIDAY_EXISTS', 'Ya hay un feriado en esa fecha') });
    mockApi(s.routes);
    renderApp('/settings/sla');
    const f = await card('Feriados');
    expect(f.getByText('Aún no hay feriados.')).toBeInTheDocument();
    fireEvent.change(f.getByLabelText('Fecha'), { target: { value: '2026-12-25' } });
    await userEvent.type(f.getByLabelText('Nombre'), 'Navidad');
    await userEvent.click(f.getByRole('button', { name: 'Agregar feriado' }));
    expect(await f.findByText('Ya hay un feriado en esa fecha')).toBeInTheDocument();
  });

  it('quien no administra el SLA ve el motivo y no los formularios', async () => {
    mockApi({ ...server(settings(), { forbidden: true }).routes, ...authed(ME_ADVISOR) });
    renderApp('/settings/sla');
    expect(await screen.findByText(/Solo el administrador de la empresa puede ver y cambiar el SLA/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Objetivo de respuesta' })).not.toBeInTheDocument();
  });
});

describe('horario: utilidades', () => {
  it('validateWeek dice el primer problema: formato, fin antes del inicio, tramos cruzados y semana vacía', () => {
    expect(validateWeek(defaultWeek())).toBeNull();
    expect(validateWeek(full({ mon: [['08:30', '24:00']] }))).toBeNull(); // 24:00 solo como fin
    expect(validateWeek(full({ mon: [['24:00', '24:00']] }))).toMatch(/Lunes, tramo 1: la hora de inicio/);
    expect(validateWeek(full({ tue: [['8', '9']] }))).toMatch(/Martes, tramo 1: la hora de inicio/);
    expect(validateWeek(full({ wed: [['08:00', '9:00']] }))).toMatch(/Miércoles, tramo 1: la hora de fin/);
    expect(validateWeek(full({ thu: [['12:00', '08:00']] }))).toMatch(/Jueves, tramo 1: el fin debe ser después del inicio/);
    expect(validateWeek(full({ fri: [['08:00', '12:00'], ['11:00', '13:00']] }))).toMatch(/Viernes, tramo 2: se cruza/);
    expect(validateWeek(emptyWeek())).toMatch(/Abre al menos un día/);
  });

  it('summarizeWeek agrupa los días seguidos con el mismo horario', () => {
    expect(summarizeWeek(barber())).toBe('Lun a Vie 08:30–18:00 · Sáb 08:30–13:00');
    expect(summarizeWeek(full({ mon: [['08:00', '12:00'], ['14:00', '18:00']], wed: [['08:00', '12:00'], ['14:00', '18:00']] }))).toBe('Lun 08:00–12:00 y 14:00–18:00 · Mié 08:00–12:00 y 14:00–18:00');
    expect(summarizeWeek(emptyWeek())).toBe('');
  });
});
