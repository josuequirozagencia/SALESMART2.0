import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, Opportunity, OpportunityDetail, Pipeline, PipelineStage } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const stage = (id: string, name: string, position: number, over: Partial<PipelineStage> = {}): PipelineStage => ({ id, name, position, kind: 'open', is_hidden: false, color: 'blue', opportunity_count: 0, ...over });
const PIPELINE = (): Pipeline => ({
  id: 'p1', name: 'Ventas', position: 0, appointment_stage_id: null, opportunity_count: 3,
  stages: [stage('s1', 'Nuevo', 0), stage('s2', 'Contactado', 1, { color: 'teal' }), stage('s3', 'Propuesta', 2, { color: 'amber' }), stage('s4', 'Ganado', 3, { kind: 'won', color: 'green' }), stage('s5', 'Perdido', 4, { kind: 'lost', color: 'red' })],
});
const opp = (id: string, name: string, stageId: string, amount: string, over: Partial<Opportunity> = {}): Opportunity => ({
  id, pipeline_id: 'p1', stage_id: stageId, status: 'open', amount, currency: 'USD', owner: null, lost_reason: null, closed_at: null,
  stage_entered_at: '2026-10-10T15:00:00.000Z', created_at: '2026-10-10T15:00:00.000Z',
  contact: { id: `c-${id}`, name, email: `${id}@x.test`, phone: '+593984217730', source: 'manual', tags: [] }, ...over,
});
const CAROLINA = { id: 'u9', name: 'Carolina Vera' };
const initial = (): Opportunity[] => [opp('o1', 'Ana Torres', 's1', '1500.00'), opp('o2', 'Beto Luna', 's1', '500.00', { owner: CAROLINA }), opp('o3', 'Carla Mora', 's3', '2000.00', { contact: { id: 'c-o3', name: 'Carla Mora', email: null, phone: null, source: 'meta_ctwa', tags: [{ id: 't1', name: 'VIP', color: '#6a44f2', system_key: null, is_system: false }] } })];

interface World { routes: Record<string, Handler>; opps: Opportunity[]; calls: Record<string, Call[]> }
const rec = (w: World, key: string, c: Call): void => { (w.calls[key] ??= []).push(c); };

/** Servidor de pipelines y oportunidades en memoria. mockApi no admite rutas con parámetros: se enrutan por los ids conocidos. */
function world(role: 'admin' | 'advisor' = 'admin', over: { opps?: Opportunity[]; pageSize?: number } = {}): World {
  const admin = role === 'admin';
  const w: World = { routes: {}, opps: over.opps ?? initial(), calls: {} };
  const pipeline = PIPELINE();
  const match = (o: Opportunity, q: URLSearchParams): boolean => {
    const stageId = q.get('stage');
    const text = q.get('q')?.toLowerCase();
    const min = Number(q.get('min') ?? 0);
    const owner = q.get('owner');
    const contact = q.get('contact');
    return (!stageId || o.stage_id === stageId) && (!text || o.contact.name.toLowerCase().includes(text)) && Number(o.amount) >= min && (!owner || (owner === 'none' ? !o.owner : o.owner?.id === owner)) && (!contact || o.contact.id === contact);
  };
  const detail = (o: Opportunity): OpportunityDetail => ({ ...o, history: [{ id: `h-${o.id}`, at: '2026-10-10T15:00:00.000Z', from_stage: null, to_stage: { id: o.stage_id, name: pipeline.stages.find((s) => s.id === o.stage_id)!.name }, user: { id: 'u1', name: 'Ana Pérez' }, origin: 'manual' }] });
  w.routes = {
    ...authed(admin ? ME_ADMIN : ME_ADVISOR),
    'GET /pipelines': () => ({ body: { items: [{ ...pipeline, opportunity_count: w.opps.length }], access: { manage: admin, write: true, view_all: admin } } }),
    'GET /pipelines/p1/summary': (call) => {
      rec(w, 'summary', call);
      const items = pipeline.stages.flatMap((s) => {
        const mine = w.opps.filter((o) => o.stage_id === s.id && match(o, call.query));
        return mine.length > 0 ? [{ stage_id: s.id, count: mine.length, total: mine.reduce((n, o) => n + Number(o.amount), 0).toFixed(2) }] : [];
      });
      return { body: { items } };
    },
    'GET /opportunities': (call) => {
      rec(w, 'list', call);
      const all = w.opps.filter((o) => match(o, call.query));
      const size = over.pageSize ?? 20;
      const from = Number(call.query.get('cursor') ?? 0);
      const page = all.slice(from, from + size);
      return { body: { items: page, next_cursor: from + size < all.length ? String(from + size) : null, access: { write: true, view_all: admin } } };
    },
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u9', name: 'Carolina Vera', email: 'c@x.test', role: 'advisor' }] } }),
    'GET /tags': () => ({ body: { items: [{ id: 't1', name: 'VIP', color: '#6a44f2', system_key: null, is_system: false }], access: { manage: true } } }),
    'GET /contacts': (call) => {
      rec(w, 'contacts', call);
      return { body: { items: [CONTACT], next_cursor: null, total: 1, access: { view_all: admin, write: true, delete: admin, import: admin, export: admin } } };
    },
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: [] } }),
    'POST /opportunities': (call) => {
      rec(w, 'create', call);
      const b = call.body as { contact_id: string; stage_id?: string; amount?: string };
      if (b.contact_id === 'dup') return err(409, 'OPPORTUNITY_OPEN_EXISTS', 'Este contacto ya tiene una oportunidad abierta en ese pipeline');
      const made = opp('o9', 'Dani Rojas', b.stage_id ?? 's1', b.amount ?? '0.00', { contact: { id: b.contact_id, name: 'Dani Rojas', email: null, phone: null, source: 'manual', tags: [] } });
      w.opps = [made, ...w.opps];
      return { status: 201, body: detail(made) };
    },
  };
  for (const id of ['o1', 'o2', 'o3', 'o9']) {
    const cur = () => w.opps.find((o) => o.id === id)!;
    w.routes[`GET /opportunities/${id}`] = () => ({ body: detail(cur()) });
    w.routes[`PATCH /opportunities/${id}`] = (call) => {
      rec(w, 'patch', call);
      const p = call.body as { amount?: string; owner_id?: string | null };
      w.opps = w.opps.map((o) => (o.id === id ? { ...o, ...(p.amount !== undefined ? { amount: p.amount } : {}), ...(p.owner_id !== undefined ? { owner: p.owner_id ? CAROLINA : null } : {}) } : o));
      return { body: detail(cur()) };
    };
    w.routes[`DELETE /opportunities/${id}`] = (call) => {
      rec(w, 'delete', call);
      w.opps = w.opps.filter((o) => o.id !== id);
      return { body: { id, deleted: true } };
    };
    w.routes[`POST /opportunities/${id}/move`] = (call) => {
      rec(w, 'move', call);
      const b = call.body as { stage_id: string; lost_reason?: string };
      const target = pipeline.stages.find((s) => s.id === b.stage_id)!;
      if (target.kind === 'lost' && !b.lost_reason) return err(400, 'VALIDATION_ERROR', 'x');
      w.opps = w.opps.map((o) => (o.id === id ? { ...o, stage_id: target.id, status: target.kind, lost_reason: target.kind === 'lost' ? b.lost_reason! : null } : o));
      return { body: detail(cur()) };
    };
  }
  return w;
}
const CONTACT: Contact = {
  id: 'c-new', name: 'Dani Rojas', email: 'dani@x.test', phones: [{ e164: '+593991112233', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies: [], attribution: null,
  created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z',
};

const col = (name: string) => within(screen.getByRole('list', { name: /Etapas del pipeline/ })).getByRole('listitem', { name: `Etapa ${name}` });
const card = (name: string) => within(screen.getByRole('list', { name: /Etapas del pipeline/ })).getByRole('article', { name: `Oportunidad de ${name}` });
async function open(role: 'admin' | 'advisor' = 'admin', over: Parameters<typeof world>[1] = {}) {
  const w = world(role, over);
  mockApi(w.routes);
  renderApp('/opportunities');
  await screen.findByRole('article', { name: 'Oportunidad de Ana Torres' });
  return w;
}

describe('Oportunidades · tarjetas', () => {
  it('cada columna muestra sus tarjetas con monto, origen y responsable, y el resumen de la etapa', async () => {
    await open();
    expect(within(col('Nuevo')).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Oportunidad de Ana Torres', 'Oportunidad de Beto Luna']);
    expect(within(col('Nuevo')).getByText(/2 oportunidades/)).toBeInTheDocument();
    expect(await within(col('Nuevo')).findByText(/2\.000,00|2,000\.00|2000,00|\$\s?2[.,]?000/)).toBeInTheDocument(); // total de la etapa (1 500 + 500)
    expect(within(card('Ana Torres')).getByText(/1[.,\s]?500/)).toBeInTheDocument();
    expect(within(card('Carla Mora')).getByText('Anuncio de Meta')).toBeInTheDocument();
    expect(within(card('Carla Mora')).getByText('1 etiqueta')).toBeInTheDocument();
    expect(within(card('Beto Luna')).getByTitle('Responsable: Carolina Vera')).toHaveTextContent('CV');
    expect(within(card('Ana Torres')).getByTitle('Sin asignar')).toBeInTheDocument();
    expect(await within(col('Contactado')).findByText('Sin oportunidades')).toBeInTheDocument();
  });

  it('«Cargar más» pide la siguiente página de esa columna con el cursor', async () => {
    const many = Array.from({ length: 3 }, (_, i) => opp(`o${i + 1}`, `Contacto ${i + 1}`, 's1', '100.00'));
    const w = world('admin', { opps: many, pageSize: 2 });
    mockApi(w.routes);
    renderApp('/opportunities');
    await screen.findByRole('article', { name: 'Oportunidad de Contacto 1' });
    expect(within(col('Nuevo')).getAllByRole('article')).toHaveLength(2);
    await userEvent.click(within(col('Nuevo')).getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(within(col('Nuevo')).getAllByRole('article')).toHaveLength(3));
    expect(w.calls['list']!.at(-1)!.query.get('cursor')).toBe('2');
  });

  it('plegar una columna oculta sus tarjetas', async () => {
    await open();
    await userEvent.click(within(col('Nuevo')).getByRole('button', { name: 'Plegar la etapa Nuevo' }));
    expect(within(col('Nuevo')).queryAllByRole('article')).toHaveLength(0);
  });
});

describe('Oportunidades · mover', () => {
  it('con el selector «Mover a…» manda la etapa y la tarjeta cambia de columna', async () => {
    const w = await open();
    await userEvent.selectOptions(within(card('Ana Torres')).getByLabelText('Mover a Ana Torres'), 's2');
    await waitFor(() => expect(w.calls['move']![0]!.body).toEqual({ stage_id: 's2' }));
    await waitFor(() => expect(within(col('Contactado')).getByRole('article', { name: 'Oportunidad de Ana Torres' })).toBeInTheDocument());
    expect(within(col('Nuevo')).queryByRole('article', { name: 'Oportunidad de Ana Torres' })).not.toBeInTheDocument();
  });

  it('arrastrar una tarjeta a otra columna la mueve; soltarla donde ya está no hace nada', async () => {
    const w = await open();
    const dataTransfer = { setData: vi.fn(), getData: () => '', effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card('Carla Mora'), { dataTransfer });
    fireEvent.dragOver(col('Propuesta'), { dataTransfer });
    fireEvent.drop(col('Propuesta'), { dataTransfer }); // la misma columna
    expect(w.calls['move']).toBeUndefined();
    fireEvent.dragStart(card('Carla Mora'), { dataTransfer });
    const target = col('Ganado');
    fireEvent(target, createEvent.dragOver(target, { dataTransfer }));
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(w.calls['move']![0]!.body).toEqual({ stage_id: 's4' }));
    await waitFor(() => expect(within(col('Ganado')).getByRole('article', { name: 'Oportunidad de Carla Mora' })).toBeInTheDocument());
  });

  it('moverla a la etapa «perdida» pide el motivo: sin motivo no se envía, con motivo sí; cancelar no mueve', async () => {
    const w = await open();
    await userEvent.selectOptions(within(card('Ana Torres')).getByLabelText('Mover a Ana Torres'), 's5');
    let dlg = screen.getByRole('dialog', { name: 'Motivo de la pérdida' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Marcar como perdida' }));
    expect(await within(dlg).findByText('Escribe el motivo')).toBeInTheDocument();
    expect(w.calls['move']).toBeUndefined();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancelar' }));
    expect(w.calls['move']).toBeUndefined();

    await userEvent.selectOptions(within(card('Ana Torres')).getByLabelText('Mover a Ana Torres'), 's5');
    dlg = screen.getByRole('dialog', { name: 'Motivo de la pérdida' });
    await userEvent.type(within(dlg).getByLabelText('Motivo'), 'No contestó');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Marcar como perdida' }));
    await waitFor(() => expect(w.calls['move']![0]!.body).toEqual({ stage_id: 's5', lost_reason: 'No contestó' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(col('Perdido')).getByRole('article', { name: 'Oportunidad de Ana Torres' })).toBeInTheDocument());
  });

  it('un error del servidor al mover se muestra', async () => {
    const w = await open();
    w.routes['POST /opportunities/o1/move'] = () => err(409, 'OPPORTUNITY_OPEN_EXISTS', 'Este contacto ya tiene una oportunidad abierta en ese pipeline');
    await userEvent.selectOptions(within(card('Ana Torres')).getByLabelText('Mover a Ana Torres'), 's2');
    expect(await screen.findByText(/ya tiene una oportunidad abierta/)).toBeInTheDocument();
  });

  it('el asesor no puede arrastrar ni tiene selector de movimiento si no escribe', async () => {
    const w = world('advisor');
    w.routes['GET /pipelines'] = () => ({ body: { items: [{ ...PIPELINE(), opportunity_count: 3 }], access: { manage: false, write: false, view_all: false } } });
    mockApi(w.routes);
    renderApp('/opportunities');
    await screen.findByRole('article', { name: 'Oportunidad de Ana Torres' });
    expect(card('Ana Torres')).toHaveAttribute('draggable', 'false');
    expect(within(card('Ana Torres')).queryByLabelText('Mover a Ana Torres')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva oportunidad' })).not.toBeInTheDocument();
  });
});

describe('Oportunidades · filtros', () => {
  it('la búsqueda, el valor mínimo y el responsable filtran las columnas y el resumen; se limpian', async () => {
    const w = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    const panel = within(screen.getByRole('group', { name: 'Filtros de oportunidades' }));
    await userEvent.type(panel.getByLabelText('Buscar oportunidades'), 'ana');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('q')).toBe('ana'));
    await waitFor(() => expect(within(col('Nuevo')).queryByRole('article', { name: 'Oportunidad de Beto Luna' })).not.toBeInTheDocument());
    expect(w.calls['summary']!.at(-1)!.query.get('q')).toBe('ana');
    expect(screen.getByRole('button', { name: 'Filtros · 1' })).toBeInTheDocument();
    expect(await screen.findByText(/1 de 3 oportunidades/)).toBeInTheDocument();

    await userEvent.type(panel.getByLabelText('Valor mínimo'), '1000');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('min')).toBe('1000'));
    await userEvent.selectOptions(panel.getByLabelText('Filtrar por responsable'), 'u9');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('owner')).toBe('u9'));
    await userEvent.selectOptions(panel.getByLabelText('Filtrar por origen'), 'meta_ctwa');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('source')).toBe('meta_ctwa'));
    await userEvent.selectOptions(panel.getByLabelText('Filtrar por etiqueta'), 't1');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.getAll('tag')).toEqual(['t1']));

    await userEvent.click(panel.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('q')).toBeNull());
    expect(w.calls['list']!.at(-1)!.query.get('min')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filtros' })).toBeInTheDocument();
  });

  it('el asesor no ve el filtro de responsable', async () => {
    await open('advisor');
    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    expect(screen.queryByLabelText('Filtrar por responsable')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filtrar por origen')).toBeInTheDocument();
  });
});

describe('Oportunidades · nueva', () => {
  it('busca el contacto, elige etapa y monto y la crea; abre su panel', async () => {
    const w = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Nueva oportunidad' }));
    const dlg = screen.getByRole('dialog', { name: 'Nueva oportunidad' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear oportunidad' }));
    expect(await within(dlg).findByText('Elige un contacto')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Contacto'), 'dani');
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Elegir a Dani Rojas' }));
    await userEvent.selectOptions(within(dlg).getByLabelText('Etapa'), 's2');
    await userEvent.type(within(dlg).getByLabelText('Monto (USD)'), '99,5');
    await userEvent.selectOptions(within(dlg).getByLabelText('Responsable'), 'u9');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear oportunidad' }));
    await waitFor(() => expect(w.calls['create']![0]!.body).toEqual({ contact_id: 'c-new', pipeline_id: 'p1', stage_id: 's2', amount: '99.50', owner_id: 'u9' }));
    expect(await screen.findByRole('dialog', { name: 'Oportunidad de Dani Rojas' })).toBeInTheDocument();
  });

  it('valida el monto y muestra el error del servidor (ya hay una abierta)', async () => {
    const w = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Nueva oportunidad' }));
    const dlg = screen.getByRole('dialog', { name: 'Nueva oportunidad' });
    await userEvent.type(within(dlg).getByLabelText('Contacto'), 'dani');
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Elegir a Dani Rojas' }));
    await userEvent.type(within(dlg).getByLabelText('Monto (USD)'), '12,345');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear oportunidad' }));
    expect(await within(dlg).findByText(/monto válido/)).toBeInTheDocument();
    expect(w.calls['create']).toBeUndefined();
    w.routes['GET /contacts'] = () => ({ body: { items: [{ ...CONTACT, id: 'dup', name: 'Duplicada Pérez' }], next_cursor: null, total: 1, access: { view_all: true, write: true, delete: true, import: true, export: true } } });
    await userEvent.clear(within(dlg).getByLabelText('Monto (USD)'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cambiar' }));
    await userEvent.type(within(dlg).getByLabelText('Contacto'), 'dup');
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Elegir a Duplicada Pérez' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear oportunidad' }));
    expect(await within(dlg).findByText(/ya tiene una oportunidad abierta/)).toBeInTheDocument();
  });

  it('el asesor no elige responsable', async () => {
    await open('advisor');
    await userEvent.click(screen.getByRole('button', { name: 'Nueva oportunidad' }));
    expect(within(screen.getByRole('dialog', { name: 'Nueva oportunidad' })).queryByLabelText('Responsable')).not.toBeInTheDocument();
  });
});

describe('Oportunidades · panel lateral', () => {
  it('muestra el contacto, la etapa, el monto y el historial; se mueve con la tira de etapas, se cambia el monto y el responsable', async () => {
    const w = await open();
    await userEvent.click(within(card('Ana Torres')).getByRole('button', { name: 'Abrir la oportunidad de Ana Torres' }));
    const drawer = await screen.findByRole('dialog', { name: 'Oportunidad de Ana Torres' });
    expect(await within(drawer).findByText('Historial de etapas')).toBeInTheDocument();
    expect(within(drawer).getByText(/Creada en/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Etapa actual: Nuevo' })).toBeDisabled();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Mover a Contactado' }));
    await waitFor(() => expect(w.calls['move']![0]!.body).toEqual({ stage_id: 's2' }));

    const amount = within(drawer).getByLabelText('Monto (USD)');
    await userEvent.clear(amount);
    await userEvent.type(amount, '2500');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Guardar monto' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ amount: '2500.00' }));
    await userEvent.selectOptions(within(await screen.findByRole('dialog', { name: 'Oportunidad de Ana Torres' })).getByLabelText('Responsable'), 'u9');
    await waitFor(() => expect(w.calls['patch']!.at(-1)!.body).toEqual({ owner_id: 'u9' }));
  });

  it('mover a la etapa perdida desde el panel pide el motivo; se cierra con Escape; borrar pide confirmación', async () => {
    const w = await open();
    await userEvent.click(within(card('Beto Luna')).getByRole('button', { name: 'Abrir la oportunidad de Beto Luna' }));
    const drawer = await screen.findByRole('dialog', { name: 'Oportunidad de Beto Luna' });
    await userEvent.click(await within(drawer).findByRole('button', { name: 'Mover a Perdido' }));
    const reason = screen.getByRole('dialog', { name: 'Motivo de la pérdida' });
    await userEvent.type(within(reason).getByLabelText('Motivo'), 'Precio');
    await userEvent.click(within(reason).getByRole('button', { name: 'Marcar como perdida' }));
    await waitFor(() => expect(w.calls['move']![0]!.body).toEqual({ stage_id: 's5', lost_reason: 'Precio' }));
    expect(await within(await screen.findByRole('dialog', { name: 'Oportunidad de Beto Luna' })).findByText(/Motivo de la pérdida:/)).toBeInTheDocument();

    const d2 = screen.getByRole('dialog', { name: 'Oportunidad de Beto Luna' });
    await userEvent.click(within(d2).getByRole('button', { name: 'Borrar oportunidad' }));
    await userEvent.click(within(d2).getByRole('button', { name: 'No' }));
    expect(w.calls['delete']).toBeUndefined();
    await userEvent.click(within(d2).getByRole('button', { name: 'Borrar oportunidad' }));
    await userEvent.click(within(d2).getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['delete']).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Oportunidad de Beto Luna/ })).not.toBeInTheDocument());

    await userEvent.click(within(card('Ana Torres')).getByRole('button', { name: 'Abrir la oportunidad de Ana Torres' }));
    await screen.findByRole('dialog', { name: 'Oportunidad de Ana Torres' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('en solo lectura el panel no ofrece cambios', async () => {
    const w = world('advisor');
    w.routes['GET /pipelines'] = () => ({ body: { items: [{ ...PIPELINE(), opportunity_count: 3 }], access: { manage: false, write: false, view_all: false } } });
    mockApi(w.routes);
    renderApp('/opportunities');
    await userEvent.click(await within(await screen.findByRole('list', { name: /Etapas del pipeline/ })).findByRole('button', { name: 'Abrir la oportunidad de Ana Torres' }));
    const drawer = await screen.findByRole('dialog', { name: 'Oportunidad de Ana Torres' });
    await within(drawer).findByText('Historial de etapas');
    expect(within(drawer).queryByRole('button', { name: 'Guardar monto' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Borrar oportunidad' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Mover a Contactado' })).toBeDisabled();
  });
});

describe('Ficha del contacto · oportunidades', () => {
  it('lista las oportunidades del contacto con su pipeline y etapa, y permite crear una', async () => {
    const w = world('admin', { opps: [opp('o1', 'Dani Rojas', 's2', '750.00', { contact: { id: 'c-new', name: 'Dani Rojas', email: null, phone: null, source: 'manual', tags: [] } })] });
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Dani Rojas' }));
    const dlg = screen.getByRole('dialog', { name: 'Contacto' });
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Oportunidades' }));
    const section = within(await within(dlg).findByRole('region', { name: 'Oportunidades' }));
    expect(await section.findByText('Contactado', { exact: false })).toBeInTheDocument();
    expect(section.getByText('Abierta')).toBeInTheDocument();
    expect(w.calls['list']!.at(-1)!.query.get('contact')).toBe('c-new');
    await userEvent.click(section.getByRole('button', { name: 'Nueva oportunidad' }));
    const create = screen.getByRole('dialog', { name: 'Nueva oportunidad' });
    expect(within(create).getByText(/Dani Rojas/)).toBeInTheDocument();
    expect(within(create).queryByLabelText('Contacto')).not.toBeInTheDocument(); // el contacto ya está fijado
    await userEvent.click(within(create).getByRole('button', { name: 'Crear oportunidad' }));
    await waitFor(() => expect(w.calls['create']![0]!.body).toMatchObject({ contact_id: 'c-new', pipeline_id: 'p1' }));
  });
});
