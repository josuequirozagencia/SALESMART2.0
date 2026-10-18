import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pipeline, PipelineStage } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const stage = (id: string, name: string, over: Partial<PipelineStage> = {}): PipelineStage => ({ id, name, position: 0, kind: 'open', is_hidden: false, color: 'blue', opportunity_count: 0, ...over });
const renumber = (stages: PipelineStage[]): PipelineStage[] => stages.map((s, i) => ({ ...s, position: i }));
const VENTAS = (): Pipeline => ({
  id: 'p1', name: 'Ventas', position: 0, appointment_stage_id: null, opportunity_count: 3,
  stages: renumber([stage('s1', 'Nuevo', { opportunity_count: 2 }), stage('s2', 'Contactado', { color: 'teal', opportunity_count: 1 }), stage('s3', 'Calificado', { color: 'violet', is_hidden: true }), stage('s4', 'Ganado', { kind: 'won', color: 'green' })]),
});
const CURSOS = (): Pipeline => ({ id: 'p2', name: 'Cursos', position: 1, appointment_stage_id: null, opportunity_count: 0, stages: renumber([stage('c1', 'Interesado'), stage('c2', 'Inscrito', { kind: 'won', color: 'green' })]) });

interface World { routes: Record<string, Handler>; pipelines: Pipeline[]; calls: Record<string, Call[]> }
const rec = (w: World, key: string, c: Call): void => { (w.calls[key] ??= []).push(c); };

/** Servidor de pipelines que aplica los cambios en memoria. mockApi no admite rutas con parámetros: se enrutan por los ids conocidos. */
function world(manage = true, initial: Pipeline[] = [VENTAS()]): World {
  const w: World = { routes: {}, pipelines: initial, calls: {} };
  const find = (id: string): Pipeline => w.pipelines.find((p) => p.id === id)!;
  const stageIds = ['s1', 's2', 's3', 's4', 'c1', 'c2', 'n1', 'n2', 'n3', 'x2', 'x3', 'x4', 'x5'];
  w.routes = {
    ...authed(manage ? ME_ADMIN : ME_ADVISOR),
    'GET /pipelines': () => ({ body: { items: w.pipelines, access: { manage, write: manage } } }),
    'POST /pipelines': (call) => {
      rec(w, 'createPipeline', call);
      const name = (call.body as { name: string }).name;
      if (w.pipelines.some((p) => p.name.toLowerCase() === name.toLowerCase())) return err(409, 'PIPELINE_EXISTS', 'Ya existe un pipeline con ese nombre');
      const made: Pipeline = { id: 'p3', name, position: w.pipelines.length, appointment_stage_id: null, opportunity_count: 0, stages: renumber([stage('n1', 'Nuevo'), stage('n2', 'En seguimiento', { color: 'violet' }), stage('n3', 'Ganado', { kind: 'won', color: 'green' })]) };
      w.pipelines = [...w.pipelines, made];
      return { status: 201, body: made };
    },
  };
  for (const p of ['p1', 'p2', 'p3']) {
    w.routes[`PATCH /pipelines/${p}`] = (call) => {
      rec(w, 'patchPipeline', call);
      Object.assign(find(p), call.body);
      return { body: find(p) };
    };
    w.routes[`DELETE /pipelines/${p}`] = (call) => {
      rec(w, 'deletePipeline', call);
      if (find(p).opportunity_count > 0) return err(409, 'PIPELINE_HAS_OPPORTUNITIES', 'Este pipeline tiene oportunidades. Muévelas o bórralas antes de borrarlo');
      w.pipelines = w.pipelines.filter((x) => x.id !== p);
      return { body: { id: p, deleted: true } };
    };
    w.routes[`POST /pipelines/${p}/stages`] = (call) => {
      rec(w, 'createStage', call);
      const b = call.body as { name: string; kind?: 'open' | 'lost' };
      const pipe = find(p);
      const made = stage(`x${pipe.stages.length}`, b.name, { kind: b.kind ?? 'open', color: b.kind === 'lost' ? 'red' : 'blue' });
      const wonAt = pipe.stages.findIndex((s) => s.kind === 'won');
      const next = [...pipe.stages];
      next.splice(b.kind === 'lost' || wonAt < 0 ? next.length : wonAt, 0, made);
      pipe.stages = renumber(next);
      return { status: 201, body: pipe };
    };
    w.routes[`PUT /pipelines/${p}/stages/order`] = (call) => {
      rec(w, 'reorder', call);
      const pipe = find(p);
      pipe.stages = renumber((call.body as { ids: string[] }).ids.map((id) => pipe.stages.find((s) => s.id === id)!));
      return { body: pipe };
    };
  }
  for (const id of stageIds) {
    const owner = (): Pipeline => w.pipelines.find((p) => p.stages.some((s) => s.id === id))!;
    w.routes[`PATCH /pipeline-stages/${id}`] = (call) => {
      rec(w, 'patchStage', call);
      const pipe = owner();
      const patch = call.body as Partial<PipelineStage>;
      pipe.stages = pipe.stages.map((s) => (s.id === id ? { ...s, ...patch } : s));
      return { body: pipe };
    };
    w.routes[`DELETE /pipeline-stages/${id}`] = (call) => {
      rec(w, 'deleteStage', call);
      const pipe = owner();
      const cur = pipe.stages.find((s) => s.id === id)!;
      if (cur.kind === 'won') return err(409, 'STAGE_WON_REQUIRED', 'No se puede eliminar la etapa ganada. Marca otra etapa como ganada primero');
      pipe.stages = renumber(pipe.stages.filter((s) => s.id !== id));
      return { body: pipe };
    };
  }
  return w;
}

const board = () => screen.getByRole('list', { name: /Etapas del pipeline/ });
const column = (name: string) => within(board()).getByRole('listitem', { name: `Etapa ${name}` });

describe('Oportunidades · tablero', () => {
  it('muestra una columna por etapa con su conteo, tipo y color; las etapas ocultas no salen hasta pedirlas', async () => {
    mockApi(world().routes);
    renderApp('/opportunities');
    expect(await screen.findByText(/Pipeline Ventas · 3 oportunidades/)).toBeInTheDocument();
    expect(within(board()).getAllByRole('listitem').map((c) => c.getAttribute('aria-label'))).toEqual(['Etapa Nuevo', 'Etapa Contactado', 'Etapa Ganado']);
    expect(within(column('Nuevo')).getByText('2 oportunidades')).toBeInTheDocument();
    expect(within(column('Contactado')).getByText('1 oportunidad')).toBeInTheDocument();
    expect(within(column('Ganado')).getByText('Ganada')).toBeInTheDocument();
    expect(within(column('Nuevo')).getByText('Sin oportunidades')).toBeInTheDocument();
    expect(screen.getByText('1 etapa oculta')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ver etapas ocultas' }));
    expect(within(board()).getAllByRole('listitem')).toHaveLength(4);
    expect(within(column('Calificado')).getByText('Oculta')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ocultar de nuevo' }));
    expect(within(board()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('pliega y despliega una columna; el selector cambia de pipeline y lo recuerda el navegador', async () => {
    mockApi(world(true, [VENTAS(), CURSOS()]).routes);
    renderApp('/opportunities');
    await screen.findByText(/Pipeline Ventas/);
    await userEvent.click(within(column('Nuevo')).getByRole('button', { name: 'Plegar la etapa Nuevo' }));
    expect(within(column('Nuevo')).queryByText('2 oportunidades')).not.toBeInTheDocument();
    await userEvent.click(within(column('Nuevo')).getByRole('button', { name: 'Desplegar la etapa Nuevo' }));
    expect(within(column('Nuevo')).getByText('2 oportunidades')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Pipeline' }), 'p2');
    expect(await screen.findByText(/Pipeline Cursos · 0 oportunidades/)).toBeInTheDocument();
    expect(within(board()).getAllByRole('listitem').map((c) => c.getAttribute('aria-label'))).toEqual(['Etapa Interesado', 'Etapa Inscrito']);
    expect(window.localStorage.getItem('ss:pipeline')).toBe('p2');
  });

  it('el asesor ve el tablero pero no los botones de configuración', async () => {
    mockApi(world(false).routes);
    renderApp('/opportunities');
    await screen.findByText(/Pipeline Ventas/);
    expect(screen.queryByRole('button', { name: 'Nuevo pipeline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Etapas' })).not.toBeInTheDocument();
  });
});

describe('Oportunidades · configuración de etapas', () => {
  async function openEditor(w = world()) {
    mockApi(w.routes);
    renderApp('/opportunities');
    await userEvent.click(await screen.findByRole('button', { name: 'Etapas' }));
    return { w, dlg: screen.getByRole('dialog', { name: 'Etapas del pipeline' }) };
  }

  it('renombra una etapa al salir del campo, cambia color y tipo, y oculta o muestra', async () => {
    const { w, dlg } = await openEditor();
    const nameBox = within(dlg).getByLabelText('Nombre de la etapa Contactado');
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, 'Primer contacto');
    await userEvent.tab();
    await waitFor(() => expect(w.calls['patchStage']![0]!.body).toEqual({ name: 'Primer contacto' }));
    await userEvent.selectOptions(within(dlg).getByLabelText('Color de «Primer contacto»'), 'pink');
    await waitFor(() => expect(w.calls['patchStage']!.at(-1)!.body).toEqual({ color: 'pink' }));
    await userEvent.selectOptions(within(dlg).getByLabelText('Tipo de «Primer contacto»'), 'lost');
    await waitFor(() => expect(w.calls['patchStage']!.at(-1)!.body).toEqual({ kind: 'lost' }));
    await waitFor(() => expect(within(dlg).getByLabelText('Tipo de «Primer contacto»')).toHaveValue('lost'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Mostrar «Calificado»' }));
    await waitFor(() => expect(w.calls['patchStage']!.at(-1)!.body).toEqual({ is_hidden: false }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Ocultar «Nuevo»' }));
    await waitFor(() => expect(w.calls['patchStage']!.at(-1)!.body).toEqual({ is_hidden: true }));
  });

  it('la ganada no se oculta, ni cambia de tipo, ni se elimina desde su fila; se cambia marcando otra', async () => {
    const { w, dlg } = await openEditor();
    expect(within(dlg).getByRole('button', { name: 'Ocultar «Ganado»' })).toBeDisabled();
    expect(within(dlg).getByRole('button', { name: 'Eliminar «Ganado»' })).toBeDisabled();
    expect(within(dlg).getByLabelText('Tipo de «Ganado»')).toBeDisabled();
    await userEvent.selectOptions(within(dlg).getByLabelText('Tipo de «Calificado»'), 'won');
    await waitFor(() => expect(w.calls['patchStage']![0]!.body).toEqual({ kind: 'won' }));
  });

  it('reordena con las flechas, agrega etapas y elimina con confirmación', async () => {
    const { w, dlg } = await openEditor();
    expect(within(dlg).getByRole('button', { name: 'Subir «Nuevo»' })).toBeDisabled();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Bajar «Nuevo»' }));
    await waitFor(() => expect(w.calls['reorder']![0]!.body).toEqual({ ids: ['s2', 's1', 's3', 's4'] }));

    await userEvent.type(within(dlg).getByLabelText('Nueva etapa'), 'Negociación');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Agregar etapa' }));
    await waitFor(() => expect(w.calls['createStage']![0]!.body).toEqual({ name: 'Negociación', kind: 'open' }));
    expect(await within(dlg).findByLabelText('Nombre de la etapa Negociación')).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole('button', { name: 'Eliminar «Negociación»' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'No' }));
    expect(w.calls['deleteStage']).toBeUndefined();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Eliminar «Negociación»' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sí' }));
    await waitFor(() => expect(w.calls['deleteStage']).toHaveLength(1));
    await waitFor(() => expect(within(dlg).queryByLabelText('Nombre de la etapa Negociación')).not.toBeInTheDocument());
  });

  it('una etapa vacía no se envía; un error del servidor se muestra con su motivo', async () => {
    const w = world();
    w.routes['DELETE /pipeline-stages/s2'] = () => err(409, 'STAGE_LAST_OPEN', 'El pipeline necesita al menos una etapa abierta');
    const { dlg } = await openEditor(w);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Agregar etapa' }));
    expect(await within(dlg).findByText('Escribe el nombre de la etapa')).toBeInTheDocument();
    expect(w.calls['createStage']).toBeUndefined();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Eliminar «Contactado»' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sí' }));
    expect(await within(dlg).findByText('El pipeline necesita al menos una etapa abierta')).toBeInTheDocument();
  });

  it('renombra el pipeline y elige la etapa de cita (solo abiertas)', async () => {
    const { w, dlg } = await openEditor();
    const box = within(dlg).getByLabelText('Nombre del pipeline');
    await userEvent.clear(box);
    await userEvent.type(box, 'Ventas 2026');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(w.calls['patchPipeline']![0]!.body).toEqual({ name: 'Ventas 2026' }));
    const sel = within(dlg).getByLabelText('Etapa de cita');
    expect(within(sel).queryByRole('option', { name: 'Ganado' })).not.toBeInTheDocument();
    await userEvent.selectOptions(sel, 's2');
    await waitFor(() => expect(w.calls['patchPipeline']!.at(-1)!.body).toEqual({ appointment_stage_id: 's2' }));
  });

  it('borrar el pipeline: deshabilitado si es el único; con otros pide confirmación y muestra el motivo si el servidor lo rechaza', async () => {
    const only = await openEditor();
    expect(within(only.dlg).getByRole('button', { name: 'Borrar pipeline' })).toBeDisabled();
  });

  it('con varios pipelines, borrar uno con oportunidades muestra el motivo y uno vacío se borra', async () => {
    const w = world(true, [VENTAS(), CURSOS()]);
    mockApi(w.routes);
    renderApp('/opportunities');
    await userEvent.click(await screen.findByRole('button', { name: 'Etapas' }));
    let dlg = screen.getByRole('dialog', { name: 'Etapas del pipeline' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Borrar pipeline' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sí, borrar' }));
    expect(await within(dlg).findByText(/Este pipeline tiene oportunidades/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Listo' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Pipeline' }), 'p2');
    await userEvent.click(await screen.findByRole('button', { name: 'Etapas' }));
    dlg = screen.getByRole('dialog', { name: 'Etapas del pipeline' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Borrar pipeline' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Pipeline Ventas/)).toBeInTheDocument();
  });

  it('crea un pipeline (un nombre repetido se marca en el campo) y abre sus etapas', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/opportunities');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo pipeline' }));
    const dlg = screen.getByRole('dialog', { name: 'Nuevo pipeline' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear pipeline' }));
    expect(await within(dlg).findByText('Escribe un nombre para el pipeline')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Nombre del pipeline'), 'ventas');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear pipeline' }));
    expect(await within(dlg).findByText('Ya existe un pipeline con ese nombre')).toBeInTheDocument();
    await userEvent.clear(within(dlg).getByLabelText('Nombre del pipeline'));
    await userEvent.type(within(dlg).getByLabelText('Nombre del pipeline'), 'Barbería');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear pipeline' }));
    await waitFor(() => expect(w.calls['createPipeline']).toHaveLength(2));
    expect(w.calls['createPipeline']![1]!.body).toEqual({ name: 'Barbería' });
    const editor = await screen.findByRole('dialog', { name: 'Etapas del pipeline' });
    expect(within(editor).getByLabelText('Nombre del pipeline')).toHaveValue('Barbería');
    expect(within(editor).getByLabelText('Nombre de la etapa En seguimiento')).toBeInTheDocument();
  });
});
