import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, DryRun, Run } from '../src/features/automations/useAutomations';
import { authed, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-10-27T15:00:00.000Z';
const RULE: Automation = {
  id: 'a1', name: 'Etiquetar a los que llegan por el anuncio', description: null, status: 'draft',
  trigger: { type: 'contact_created', filter: { source: 'meta_ctwa' } },
  conditions: [{ field: 'consent', op: 'eq', value: 'unknown' }],
  actions: [{ type: 'add_tag', tag_id: 't1' }, { type: 'create_task', title: 'Llamar a {{primer_nombre}}', due_in_hours: 2, assignee: 'owner' }],
  version: 1, recent: { done: 0, skipped: 0, failed: 0, queued: 0 }, created_at: AT, updated_at: AT,
};
const RUN: Run = {
  id: 'r1', at: AT, status: 'failed', reason: '1 acción falló', event_type: 'contact_created', depth: 1, contact: { id: 'c1', name: 'Lucía Paredes' },
  steps: [{ position: 1, action: 'add_tag', label: 'Poner una etiqueta', outcome: 'done', detail: 'Etiqueta «Nuevo» puesta' }, { position: 2, action: 'create_task', label: 'Crear una tarea', outcome: 'failed', detail: 'Esa persona ya no puede recibir trabajo en la empresa' }],
};
const DRY: DryRun = {
  contact: { id: 'c1', name: 'Lucía Paredes' }, conditions: [{ index: 0, met: true }], meets: true,
  actions: [{ position: 1, action: 'add_tag', label: 'Poner una etiqueta', would: 'do', detail: 'Pondría la etiqueta «Nuevo»' }, { position: 2, action: 'create_task', label: 'Crear una tarea', would: 'skip', detail: 'El contacto no tiene responsable a quien asignarle la tarea' }],
};

interface World { rule: Automation | null; calls: Record<string, Call[]>; runs: Run[]; dry: DryRun; fail?: Record<string, () => ReturnType<Handler>> }
const world = (over: Partial<World> = {}): World => ({ rule: RULE, calls: {}, runs: [], dry: DRY, ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };

function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  const guard = (k: string, h: Handler): Handler => (c) => { rec(w, k, c); return w.fail?.[k]?.() ?? h(c); };
  return {
    ...authed(me),
    'GET /custom-fields': () => ({ body: { items: [{ id: 'cf1', entity: 'contact', name: 'Ciudad', key: 'ciudad', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: AT }], access: { manage: me.role === 'client_admin' } } }),
    'GET /tags': () => ({ body: { items: [{ id: 't0', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true }, { id: 't1', name: 'Nuevo', color: '#aa3366', system_key: null, is_system: false }], access: { manage: true } } }),
    'GET /pipelines': () => ({ body: { items: [{ id: 'p1', name: 'Ventas', position: 0, appointment_stage_id: null, opportunity_count: 0, stages: [{ id: 's1', name: 'Nuevo lead', position: 0, kind: 'open', is_hidden: false, color: 'violet', opportunity_count: 0 }, { id: 's2', name: 'Ganada', position: 1, kind: 'won', is_hidden: false, color: 'green', opportunity_count: 0 }] }], access: { manage: true, write: true, view_all: true } } as never }),
    'GET /queues': () => ({ body: { items: [{ id: 'q1', name: 'Captación' }], limits: { max_queues: 20 } } as never }),
    'GET /channels': () => ({ body: { items: [{ id: 'c1', provider: 'meta_cloud', is_official: true, name: 'WhatsApp Norte', status: 'active' }], vault: { available: true } } as never }),
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u1', name: 'Ana Pérez', email: 'ana@empresa.test', role: 'client_admin' }, { id: 'u9', name: 'Carolina Vera', email: 'caro@empresa.test', role: 'advisor' }] } }),
    'GET /channels/c1/templates': () => ({ body: { items: [{ id: 'tp1', channel_id: 'c1', name: 'seguimiento', language: 'es', category: 'utility', status: 'approved', parameter_format: 'named', header: null, body: 'Hola {{nombre}}, ¿pudiste revisar la propuesta?', footer: null, buttons: [], variables: [{ id: 'body:nombre', part: 'body', key: 'nombre', buttonIndex: null, example: 'Ana' }], sendable: true, unsupported_reason: null, rejected_reason: null, synced_at: AT }], synced_at: AT, sync_error: null } }),
    'GET /contacts': guard('contacts', () => ({ body: { items: [{ id: 'c1', name: 'Lucía Paredes', email: null, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies: [] }], next_cursor: null, total: null, access: {} } as never })),
    'GET /automations': guard('list', () => ({ body: { items: w.rule ? [w.rule] : [], limits: { max_automations: 50 } } })),
    'POST /automations': guard('create', (c) => {
      const b = c.body as Pick<Automation, 'name' | 'description' | 'trigger' | 'conditions' | 'actions'>;
      w.rule = { ...RULE, id: 'a2', status: 'draft', ...b };
      return { status: 201, body: w.rule };
    }),
    'PATCH /automations/a1': guard('patch', (c) => {
      w.rule = { ...w.rule!, ...(c.body as Partial<Automation>), version: w.rule!.version + 1 };
      return { body: w.rule };
    }),
    'POST /automations/a1/activate': guard('activate', () => {
      w.rule = { ...w.rule!, status: 'active' };
      return { body: w.rule };
    }),
    'POST /automations/a1/pause': guard('pause', () => {
      w.rule = { ...w.rule!, status: 'paused' };
      return { body: w.rule };
    }),
    'DELETE /automations/a1': guard('remove', () => {
      w.rule = null;
      return { body: { id: 'a1', deleted: true } };
    }),
    'POST /automations/a1/test': guard('test', () => ({ body: w.dry })),
    'GET /automations/a1/runs': guard('runs', () => ({ body: { items: w.runs, next_cursor: null } })),
  };
}
const NAME = 'Etiquetar a los que llegan por el anuncio';

describe('Automatizaciones · menú y lista', () => {
  it('el administrador ve «Automatizaciones» en «IA y automatización»; el asesor no', async () => {
    mockApi(server(world()));
    renderApp('/automations');
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    expect(await within(nav).findByRole('link', { name: 'Automatizaciones' })).toHaveAttribute('href', '/automations');
    expect(within(nav).getByText('IA y automatización')).toBeInTheDocument();
  });

  it('un asesor no tiene el enlace en el menú', async () => {
    mockApi(server(world(), ME_ADVISOR));
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Secciones' });
    expect(screen.queryByRole('link', { name: 'Automatizaciones' })).not.toBeInTheDocument();
  });

  it('lista cada regla con su estado, su resumen y cómo le ha ido; sin reglas invita a crear la primera', async () => {
    mockApi(server(world({ rule: { ...RULE, status: 'active', recent: { done: 12, failed: 1, skipped: 2, queued: 0 } } })));
    renderApp('/automations');
    const row = within((await screen.findByText(NAME)).closest('li')!);
    expect(row.getByText('Activa')).toBeInTheDocument();
    expect(row.getByText(/Se crea un contacto · 1 condición · 2 acciones/)).toBeInTheDocument();
    expect(row.getByText(/12 hechas · 1 con fallos · 2 omitidas en 7 días/)).toBeInTheDocument();
  });

  it('sin reglas dice cómo empezar', async () => {
    mockApi(server(world({ rule: null })));
    renderApp('/automations');
    expect(await screen.findByText(/Aún no tienes automatizaciones/)).toBeInTheDocument();
  });

  it('activar y pausar desde la lista', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations');
    await userEvent.click(await screen.findByRole('button', { name: `Activar ${NAME}` }));
    await waitFor(() => expect(w.calls['activate']).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: `Pausar ${NAME}` }));
    await waitFor(() => expect(w.calls['pause']).toHaveLength(1));
    expect(await screen.findByRole('button', { name: `Reactivar ${NAME}` })).toBeInTheDocument();
  });

  it('si el servidor no deja activar muestra el motivo', async () => {
    const w = world({ fail: { activate: () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'actions', code: 'required', message: 'Agrega al menos una acción para activar la automatización' }] } } }) } });
    mockApi(server(w));
    renderApp('/automations');
    await userEvent.click(await screen.findByRole('button', { name: `Activar ${NAME}` }));
    expect(await screen.findByText('Agrega al menos una acción para activar la automatización')).toBeInTheDocument();
  });
});

describe('Automatizaciones · editor', () => {
  it('crea una automatización nueva por pasos: disparador, condición y acción; el cuerpo es el que espera el servidor', async () => {
    const w = world({ rule: null });
    mockApi(server(w));
    renderApp('/automations/new');
    await userEvent.type(await screen.findByLabelText(/^Nombre/), 'Responder a los nuevos');
    await userEvent.selectOptions(screen.getByLabelText('Cuando ocurre'), 'Llega un mensaje del cliente');
    await userEvent.selectOptions(await screen.findByLabelText('Conexión (opcional)'), 'WhatsApp Norte');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar condición' }));
    await userEvent.selectOptions(screen.getByLabelText('Condición 1: campo'), 'Etiquetas');
    await userEvent.selectOptions(screen.getByLabelText('Condición 1: comparación'), 'no tiene');
    await userEvent.selectOptions(screen.getByLabelText('Condición 1: etiqueta'), 'Nuevo');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar acción' }));
    await userEvent.selectOptions(screen.getByLabelText('Acción 1: qué hacer'), 'Poner una etiqueta');
    // las etiquetas del sistema no se ofrecen en las acciones
    expect(within(screen.getByLabelText('Acción 1: etiqueta')).queryByRole('option', { name: 'Lead' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Acción 1: etiqueta'), 'Nuevo');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar como borrador' }));
    await waitFor(() => expect(w.calls['create']).toHaveLength(1));
    expect(w.calls['create']![0]!.body).toEqual({
      name: 'Responder a los nuevos',
      description: null,
      trigger: { type: 'message_received', filter: { channel_id: 'c1' } },
      conditions: [{ field: 'tag', op: 'not_has', value: 't1' }],
      actions: [{ type: 'add_tag', tag_id: 't1' }],
    });
    // queda abierta la regla guardada, con sus pestañas
    expect(await screen.findByRole('tab', { name: 'Historial' })).toBeInTheDocument();
  });

  it('el nombre es obligatorio y no se manda nada al servidor sin él', async () => {
    const w = world({ rule: null });
    mockApi(server(w));
    renderApp('/automations/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Guardar como borrador' }));
    expect(await screen.findByText('Ponle un nombre a la automatización.')).toBeInTheDocument();
    expect(w.calls['create']).toBeUndefined();
  });

  it('muestra el detalle que da el servidor cuando algo de lo que nombra ya no existe', async () => {
    const w = world({ rule: null, fail: { create: () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'actions.0.tag_id', code: 'not_found', message: 'La etiqueta no existe' }] } } }) } });
    mockApi(server(w));
    renderApp('/automations/new');
    await userEvent.type(await screen.findByLabelText(/^Nombre/), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar como borrador' }));
    expect(await screen.findByText('La etiqueta no existe')).toBeInTheDocument();
  });

  it('abre una regla guardada, edita una acción y guarda solo lo que cambió; «Guardar» está apagado sin cambios', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations/a1');
    const save = await screen.findByRole('button', { name: 'Guardar cambios' });
    expect(save).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('Acción 1: etiqueta')).toHaveValue('t1'));
    expect(screen.getByLabelText('Acción 2: título de la tarea')).toHaveValue('Llamar a {{primer_nombre}}');
    await userEvent.clear(screen.getByLabelText('Acción 2: título de la tarea'));
    await userEvent.type(screen.getByLabelText('Acción 2: título de la tarea'), 'Escribir a todos');
    expect(await screen.findByText('Cambios sin guardar')).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(w.calls['patch']).toHaveLength(1));
    const sent = w.calls['patch']![0]!.body as { actions: Array<Record<string, unknown>> };
    expect(sent.actions[1]).toEqual({ type: 'create_task', title: 'Escribir a todos', due_in_hours: 2, assignee: 'owner' });
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('reordena y quita acciones', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('button', { name: 'Bajar la acción 1' }));
    await waitFor(() => expect(screen.getByLabelText('Acción 2: etiqueta')).toHaveValue('t1'));
    await userEvent.click(screen.getByRole('button', { name: 'Quitar la acción 1' }));
    expect(screen.queryByLabelText('Acción 2: etiqueta')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Acción 1: etiqueta')).toBeInTheDocument();
  });

  it('una plantilla pide los valores de sus variables y propone el primer nombre en la primera', async () => {
    const w = world({ rule: { ...RULE, actions: [{ type: 'add_tag', tag_id: 't1' }] } });
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.selectOptions(await screen.findByLabelText('Acción 1: qué hacer'), 'Enviar una plantilla de WhatsApp');
    await userEvent.selectOptions(screen.getByLabelText('Acción 1: conexión'), 'WhatsApp Norte');
    await userEvent.selectOptions(await screen.findByLabelText('Acción 1: plantilla'), 'seguimiento');
    expect(await screen.findByLabelText('Valor de {{nombre}}')).toHaveValue('{{primer_nombre}}');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(w.calls['patch']).toHaveLength(1));
    expect((w.calls['patch']![0]!.body as { actions: unknown[] }).actions).toEqual([{ type: 'send_template', channel_id: 'c1', template_id: 'tp1', params: { 'body:nombre': '{{primer_nombre}}' } }]);
  });

  it('activar una regla con cambios los guarda primero; pausar la deja en pausa', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.type(await screen.findByLabelText(/^Descripción/), 'Para el anuncio');
    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(w.calls['activate']).toHaveLength(1));
    expect(w.calls['patch']).toHaveLength(1);
    expect(await screen.findByText(/Automatización activa/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(w.calls['pause']).toHaveLength(1));
    expect(await screen.findByText(/Automatización en pausa/)).toBeInTheDocument();
  });

  it('borrar pide confirmación', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('button', { name: 'Borrar' }));
    expect(w.calls['remove']).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['remove']).toHaveLength(1));
    expect(await screen.findByText(/Aún no tienes automatizaciones/)).toBeInTheDocument();
  });

  it('una regla que ya no existe lo dice', async () => {
    mockApi(server(world({ rule: null })));
    renderApp('/automations/a1');
    expect(await screen.findByText(/No encontramos esa automatización/)).toBeInTheDocument();
  });
});

describe('Automatizaciones · probar e historial', () => {
  it('busca un contacto y muestra qué haría cada acción sin escribir nada', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Probar' }));
    await userEvent.type(screen.getByLabelText('Buscar contacto'), 'Luc');
    await userEvent.click(await screen.findByRole('button', { name: 'Probar con Lucía Paredes' }));
    const res = within(await screen.findByRole('region', { name: 'Resultado de la prueba' }));
    expect(w.calls['test']![0]!.body).toEqual({ contact_id: 'c1' });
    expect(res.getByText('Con Lucía Paredes')).toBeInTheDocument();
    expect(res.getByText('Cumple')).toBeInTheDocument();
    expect(res.getByText('Lo haría')).toBeInTheDocument();
    expect(res.getByText('Se omitiría')).toBeInTheDocument();
    expect(res.getByText('El contacto no tiene responsable a quien asignarle la tarea')).toBeInTheDocument();
  });

  it('si el contacto no cumple una condición lo dice y no lista acciones', async () => {
    const w = world({ dry: { contact: { id: 'c1', name: 'Lucía Paredes' }, conditions: [{ index: 0, met: false }], meets: false, actions: [] } });
    mockApi(server(w));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Probar' }));
    await userEvent.type(screen.getByLabelText('Buscar contacto'), 'Luc');
    await userEvent.click(await screen.findByRole('button', { name: 'Probar con Lucía Paredes' }));
    const res = within(await screen.findByRole('region', { name: 'Resultado de la prueba' }));
    expect(res.getByText('No cumple')).toBeInTheDocument();
    expect(res.getByText(/Consentimiento es igual a «unknown»/)).toBeInTheDocument();
    expect(res.getByText(/la regla no se ejecutaría/)).toBeInTheDocument();
    expect(res.queryByRole('list', { name: 'Acciones' })).not.toBeInTheDocument();
  });

  it('el historial muestra cada ejecución con sus pasos y el motivo de lo que falló', async () => {
    mockApi(server(world({ runs: [RUN] })));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Historial' }));
    const row = within((await screen.findByText('Lucía Paredes')).closest('li')!);
    expect(row.getByText('Con fallos')).toBeInTheDocument();
    expect(row.getByText('Encadenada')).toBeInTheDocument();
    expect(row.getByText('Etiqueta «Nuevo» puesta')).toBeInTheDocument();
    expect(row.getByText('Esa persona ya no puede recibir trabajo en la empresa')).toBeInTheDocument();
  });

  it('sin ejecuciones el historial explica cuándo aparecerán', async () => {
    mockApi(server(world()));
    renderApp('/automations/a1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Historial' }));
    expect(await screen.findByText(/Todavía no se ha ejecutado/)).toBeInTheDocument();
  });
});
