// F2 (ADR-58): tareas que se repiten y avisos de tareas en la campana.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeRecurrence } from '../src/lib/recurrence';
import type { AppNotification, Task, TaskRecurrence } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();
const RULE: TaskRecurrence = { freq: 'weekly', interval: 1, weekdays: [1, 3], day_of_month: null, ends: { kind: 'never' }, occurrence_no: 1, occurrences_created: 1 };
const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id, title, description: null, due_at: null, status: 'open', completed_at: null, assignee: { id: 'u1', name: 'Ana Pérez' }, contact: null, company: null, created_by: 'u1', remind_before_minutes: null, recurrence: null,
  overdue: false, can_edit: true, can_complete: true, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});

describe('describeRecurrence', () => {
  it('dice la regla en palabras', () => {
    const d = (over: Partial<TaskRecurrence>): string => describeRecurrence({ ...RULE, ...over });
    expect(d({ freq: 'daily', weekdays: null })).toBe('Cada día');
    expect(d({ freq: 'daily', weekdays: null, interval: 2 })).toBe('Cada 2 días');
    expect(d({})).toBe('Cada semana: lun, mié');
    expect(d({ weekdays: [0, 5, 1] })).toBe('Cada semana: lun, vie, dom'); // lunes primero
    expect(d({ interval: 2, weekdays: [1] })).toBe('Cada 2 semanas: lun');
    expect(d({ freq: 'monthly', weekdays: null, day_of_month: 31 })).toBe('Cada mes, el día 31');
    expect(d({ freq: 'monthly', weekdays: null, interval: 3, day_of_month: 15 })).toBe('Cada 3 meses, el día 15');
    expect(d({ ends: { kind: 'on', date: '2030-02-12' } })).toBe('Cada semana: lun, mié, hasta el 12/02/2030');
    expect(d({ ends: { kind: 'after', count: 5 } })).toBe('Cada semana: lun, mié, 5 veces en total');
  });
});

interface World { routes: Record<string, Handler>; calls: Record<string, Call[]>; tasks: Task[] }
function world(tasks: Task[], extra: Record<string, Handler> = {}): World {
  const w: World = { routes: {}, calls: {}, tasks };
  const rec = (k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };
  w.routes = {
    ...authed(ME_ADMIN),
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u9', name: 'Carolina Vera', email: 'c@x.test', role: 'advisor' }] } }),
    'GET /tasks': (c) => { rec('list', c); return { body: { items: w.tasks, next_cursor: null, total: w.tasks.length, access: { view_all: true, write: true } } }; },
    'POST /tasks': (c) => { rec('create', c); return { status: 201, body: task('tn', 'Nueva') }; },
    'PATCH /tasks/t1': (c) => { rec('edit', c); return { body: w.tasks[0] }; },
    'POST /tasks/t1/complete': (c) => { rec('complete', c); return { body: { ...w.tasks[0], status: 'done' } }; },
    ...extra,
  };
  return w;
}

describe('tareas que se repiten (pantalla Tareas)', () => {
  it('una tarea que se repite lo dice en su fila', async () => {
    mockApi(world([task('t1', 'Reporte semanal', { due_at: inMs(60 * MIN), recurrence: RULE })]).routes);
    renderApp('/tasks');
    expect(await screen.findByText('Cada semana: lun, mié')).toBeInTheDocument();
  });

  it('al completarla avisa cuándo vence la siguiente; si la serie terminó, lo dice; una tarea normal no dice nada', async () => {
    const next = task('t2', 'Reporte semanal', { due_at: '2030-01-09T21:00:00.000Z', recurrence: { ...RULE, occurrence_no: 2, occurrences_created: 2 } });
    const w = world([task('t1', 'Reporte semanal', { due_at: inMs(60 * MIN), recurrence: RULE })], {
      'POST /tasks/t1/complete': () => ({ body: { ...task('t1', 'Reporte semanal', { status: 'done' }), next_task: next } }),
    });
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Marcar «Reporte semanal» como hecha' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Hecha\. Siguiente: \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  });

  it('la serie que llegó a su fin avisa que no hay otra tarea', async () => {
    mockApi(world([task('t1', 'Última', { recurrence: RULE })], { 'POST /tasks/t1/complete': () => ({ body: { ...task('t1', 'Última', { status: 'done' }), next_task: null } }) }).routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Marcar «Última» como hecha' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Hecha. La repetición terminó: no hay otra tarea.');
  });

  it('completar una tarea normal no muestra mensaje', async () => {
    const w = world([task('t1', 'Normal')]);
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Marcar «Normal» como hecha' }));
    await waitFor(() => expect(w.calls['complete']).toHaveLength(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('diálogo de tarea: Repetir y Avisarme', () => {
  async function openNew(w: World) {
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva tarea' }));
    return screen.getByRole('dialog', { name: 'Nueva tarea' });
  }

  it('una tarea que se repite exige vencimiento; con él se manda la regla y el aviso anticipado', async () => {
    const w = world([]);
    const dlg = await openNew(w);
    await userEvent.type(within(dlg).getByLabelText('Título'), 'Seguimiento');
    await userEvent.selectOptions(within(dlg).getByLabelText('Repetir'), 'weekly');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear tarea' }));
    expect(await within(dlg).findByText('Una tarea que se repite necesita fecha de vencimiento')).toBeInTheDocument();
    expect(w.calls['create']).toBeUndefined();

    await userEvent.type(within(dlg).getByLabelText('Vence'), '2030-01-02T21:00');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'lunes' }));
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'miércoles' }));
    await userEvent.selectOptions(within(dlg).getByLabelText('Termina'), 'after');
    await userEvent.clear(within(dlg).getByLabelText('Número de veces'));
    await userEvent.type(within(dlg).getByLabelText('Número de veces'), '5');
    await userEvent.selectOptions(within(dlg).getByLabelText('Avisarme'), '60');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear tarea' }));
    await waitFor(() => expect(w.calls['create']).toHaveLength(1));
    expect(w.calls['create']![0]!.body).toMatchObject({ title: 'Seguimiento', remind_before_minutes: 60, recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 3], ends: { kind: 'after', count: 5 } } });
  });

  it('valida «cada N» y el fin antes de enviar', async () => {
    const w = world([]);
    const dlg = await openNew(w);
    await userEvent.type(within(dlg).getByLabelText('Título'), 'Reporte');
    await userEvent.type(within(dlg).getByLabelText('Vence'), '2030-01-02T21:00');
    await userEvent.selectOptions(within(dlg).getByLabelText('Repetir'), 'daily');
    await userEvent.clear(within(dlg).getByLabelText('Cada'));
    await userEvent.type(within(dlg).getByLabelText('Cada'), '0');
    await userEvent.selectOptions(within(dlg).getByLabelText('Termina'), 'on');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear tarea' }));
    expect(await within(dlg).findByText('Usa un número de 1 a 30')).toBeInTheDocument();
    expect(within(dlg).getByText('Elige la fecha en que termina')).toBeInTheDocument();
    expect(w.calls['create']).toBeUndefined();
  });

  it('sin repetir ni aviso, el cuerpo no lleva ninguno de los dos campos nuevos', async () => {
    const w = world([]);
    const dlg = await openNew(w);
    await userEvent.type(within(dlg).getByLabelText('Título'), 'Normal');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear tarea' }));
    await waitFor(() => expect(w.calls['create']).toHaveLength(1));
    expect(w.calls['create']![0]!.body).toEqual({ title: 'Normal', description: null, due_at: null });
  });

  it('editar una tarea que se repite muestra su regla; dejarla igual no la manda; «No se repite» la detiene; cambiar «Avisarme» manda solo eso', async () => {
    const w = world([task('t1', 'Reporte semanal', { due_at: inMs(60 * MIN), recurrence: RULE })]);
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Reporte semanal' }));
    let dlg = screen.getByRole('dialog', { name: 'Editar tarea' });
    expect(within(dlg).getByLabelText('Repetir')).toHaveValue('weekly');
    expect(within(dlg).getByRole('checkbox', { name: 'lunes' })).toBeChecked();
    expect(within(dlg).getByRole('checkbox', { name: 'martes' })).not.toBeChecked();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['edit']).toHaveLength(1));
    expect(w.calls['edit']![0]!.body).not.toHaveProperty('recurrence');
    expect(w.calls['edit']![0]!.body).not.toHaveProperty('remind_before_minutes');

    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Reporte semanal' }));
    dlg = screen.getByRole('dialog', { name: 'Editar tarea' });
    await userEvent.selectOptions(within(dlg).getByLabelText('Avisarme'), '15');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['edit']).toHaveLength(2));
    expect(w.calls['edit']![1]!.body).toMatchObject({ remind_before_minutes: 15 });
    expect(w.calls['edit']![1]!.body).not.toHaveProperty('recurrence');

    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Reporte semanal' }));
    dlg = screen.getByRole('dialog', { name: 'Editar tarea' });
    await userEvent.selectOptions(within(dlg).getByLabelText('Repetir'), 'none');
    expect(within(dlg).getByText('Al guardar se detiene la repetición; esta tarea queda como única.')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['edit']).toHaveLength(3));
    expect(w.calls['edit']![2]!.body).toMatchObject({ recurrence: null });
  });

  it('quien solo puede completar la tarea ve su repetición en lectura, sin poder cambiarla', async () => {
    mockApi(world([task('t1', 'Ajena', { due_at: inMs(60 * MIN), recurrence: RULE, can_edit: false })]).routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Ajena' }));
    const dlg = screen.getByRole('dialog', { name: 'Tarea' });
    expect(within(dlg).getByText('Se repite:')).toBeInTheDocument();
    expect(within(dlg).getByText('Cada semana: lun, mié')).toBeInTheDocument();
    expect(within(dlg).queryByLabelText('Repetir')).not.toBeInTheDocument();
    expect(within(dlg).queryByLabelText('Avisarme')).not.toBeInTheDocument();
  });

  it('una tarea ya hecha no ofrece cambiar la repetición', async () => {
    mockApi(world([task('t1', 'Hecha', { status: 'done', completed_at: ago(MIN) })]).routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('tab', { name: 'Hechas' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Hecha' }));
    const dlg = screen.getByRole('dialog', { name: 'Editar tarea' });
    expect(within(dlg).queryByLabelText('Repetir')).not.toBeInTheDocument();
  });
});

describe('abrir una tarea desde un aviso (?task=)', () => {
  it('abre el diálogo de esa tarea; si ya no existe, lo explica', async () => {
    mockApi(world([], { 'GET /tasks/t9': () => ({ body: task('t9', 'Llamar al proveedor', { due_at: inMs(MIN * 30) }) }) }).routes);
    renderApp('/tasks?task=t9');
    const dlg = await screen.findByRole('dialog', { name: 'Editar tarea' });
    expect(within(dlg).getByLabelText('Título')).toHaveValue('Llamar al proveedor');
  });

  it('una tarea que ya no es de la persona (404) muestra un aviso en la pantalla', async () => {
    mockApi(world([], { 'GET /tasks/t8': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x', request_id: 'r', details: [] } } }) }).routes);
    renderApp('/tasks?task=t8');
    expect(await screen.findByText(/No encontramos esa tarea/)).toBeInTheDocument();
  });
});

const notice = (over: Partial<AppNotification>): AppNotification => ({
  id: 'n1', type: 'task_assigned', created_at: ago(5 * MIN), read_at: null, actor: { id: 'u3', name: 'Carolina Vera' }, conversation: null, message_id: null, excerpt: null,
  task: { id: 't1', title: 'Preparar la propuesta', due_at: inMs(60 * MIN), status: 'open', contact_id: null }, ...over,
});

describe('campana: avisos de tareas', () => {
  function bell(items: AppNotification[]) {
    const marked: string[] = [];
    mockApi({
      ...authed(ME_ADMIN),
      'GET /notifications': (c) => ({ body: { items, next_cursor: null, unread: c.query.get('unread') ? items.filter((n) => !n.read_at).length : items.filter((n) => !n.read_at).length } }),
      'POST /notifications/n1/read': () => { marked.push('n1'); return { body: { id: 'n1', read_at: new Date().toISOString() } }; },
    });
    return marked;
  }

  it('«te asignaron una tarea», con quién y sin quién (la creó el sistema)', async () => {
    bell([notice({ id: 'n1' }), notice({ id: 'n2', actor: null, task: { id: 't2', title: 'Contactar a Lucía', due_at: null, status: 'open', contact_id: 'c1' } })]);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: /Avisos \(2 sin leer\)/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Avisos' });
    expect(within(dlg).getByText('Carolina Vera te asignó la tarea «Preparar la propuesta»')).toBeInTheDocument();
    expect(within(dlg).getByText('Se te asignó la tarea «Contactar a Lucía»')).toBeInTheDocument();
  });

  it('«tu tarea vence» antes de la hora y «venció» después; enlazan a la tarea y abrirlo la marca como leída', async () => {
    const marked = bell([
      notice({ id: 'n1', type: 'task_due', actor: null, task: { id: 't1', title: 'Reunión con proveedor', due_at: inMs(15 * MIN), status: 'open', contact_id: null } }),
      notice({ id: 'n3', type: 'task_due', actor: null, read_at: ago(MIN), task: { id: 't3', title: 'Enviar factura', due_at: ago(60 * MIN), status: 'open', contact_id: null } }),
    ]);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: /Avisos \(1 sin leer\)/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Avisos' });
    expect(within(dlg).getByText(/^La tarea «Reunión con proveedor» vence \d{1,2}\/\d{1,2} \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(within(dlg).getByText(/^La tarea «Enviar factura» venció \d{1,2}\/\d{1,2} \d{2}:\d{2}$/)).toBeInTheDocument();
    const link = within(dlg).getByRole('link', { name: /Reunión con proveedor/ });
    expect(link).toHaveAttribute('href', '/tasks?task=t1');
    await userEvent.click(link);
    await waitFor(() => expect(marked).toEqual(['n1']));
  });

  it('sin avisos explica de dónde llegan', async () => {
    bell([]);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos' }));
    expect(await screen.findByText(/te asignen una tarea o una tarea tuya esté por vencer/)).toBeInTheDocument();
  });
});
