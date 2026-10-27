import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormCard, FormDetail, FormField, FormSubmission } from '../src/features/forms/useForms';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-10-27T15:00:00.000Z';
const FIELDS: FormField[] = [
  { id: 'x1', key: 'nombre', kind: 'text', label: 'Nombre', maps_to: 'name', required: true, options: null, placeholder: 'Tu nombre' },
  { id: 'x2', key: 'whatsapp', kind: 'phone', label: 'WhatsApp', maps_to: 'phone', required: true, options: null, placeholder: null },
  { id: 'x3', key: 'correo', kind: 'email', label: 'Correo', maps_to: 'email', required: false, options: null, placeholder: null },
];
const detail = (over: Partial<FormDetail> = {}): FormDetail => ({
  id: 'f1', name: 'Landing de cursos', description: null, status: 'draft', field_count: 3, submissions: 0, last_submission_at: null, public_token: '8a1d2e3f-0000-4000-8000-000000000001', created_at: AT,
  queue_id: null, pipeline_id: null, stage_id: null, extra_tag_id: null, consent_text: 'Acepto que me contacten por WhatsApp y por teléfono para atender mi solicitud.', thanks_message: '¡Gracias! Recibimos tus datos y te contactaremos en breve.', redirect_url: null,
  allowed_domains: [], phone_prefix: '+593', follow_up: { task: true, channel_id: null, template_id: null, params: {} }, fields: FIELDS, missing: ['autoriza al menos un dominio desde el que se enviará (por ejemplo «mi-sitio.com»)'], ...over,
});
const card = (d: FormDetail): FormCard => ({ id: d.id, name: d.name, description: d.description, status: d.status, field_count: d.fields.length, submissions: d.submissions, last_submission_at: d.last_submission_at, public_token: d.public_token, created_at: d.created_at });

interface World { form: FormDetail | null; calls: Record<string, Call[]>; submissions: FormSubmission[]; fail?: Record<string, () => ReturnType<Handler>> }
const world = (over: Partial<World> = {}): World => ({ form: detail(), calls: {}, submissions: [], ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };

function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  const guard = (k: string, h: Handler): Handler => (c) => { rec(w, k, c); return w.fail?.[k]?.() ?? h(c); };
  return {
    ...authed(me),
    'GET /custom-fields': () => ({ body: { items: [{ id: 'cf1', entity: 'contact', name: 'Ciudad', key: 'ciudad', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: AT }], access: { manage: me.role === 'client_admin' } } }),
    'GET /queues': () => ({ body: { items: [{ id: 'q1', name: 'Captación' }, { id: 'q2', name: 'Soporte' }], access: { manage: true } } as never }),
    'GET /pipelines': () => ({ body: { items: [{ id: 'p1', name: 'Ventas', position: 0, appointment_stage_id: null, opportunity_count: 0, stages: [{ id: 's1', name: 'Nuevo lead', position: 0, kind: 'open', is_hidden: false, color: 'violet', opportunity_count: 0 }, { id: 's2', name: 'Ganada', position: 1, kind: 'won', is_hidden: false, color: 'green', opportunity_count: 0 }] }], access: { manage: true, write: true, view_all: true } } as never }),
    'GET /channels': () => ({ body: { items: [{ id: 'c1', provider: 'meta_cloud', is_official: true, name: 'WhatsApp Norte', status: 'active' }, { id: 'c2', provider: 'meta_cloud', is_official: true, name: 'Apagada', status: 'disabled' }], access: { manage: true } } as never }),
    'GET /channels/c1/templates': () => ({
      body: {
        items: [
          { id: 'tp1', channel_id: 'c1', name: 'seguimiento_nombrado', language: 'es', category: 'utility', status: 'approved', parameter_format: 'named', header: null, body: 'Hola {{nombre}}, ¿pudiste revisar la propuesta de {{servicio}}?', footer: null, buttons: [], variables: [{ id: 'body:nombre', part: 'body', key: 'nombre', buttonIndex: null, example: 'Ana' }, { id: 'body:servicio', part: 'body', key: 'servicio', buttonIndex: null, example: null }], sendable: true, unsupported_reason: null, rejected_reason: null, synced_at: AT },
          { id: 'tp2', channel_id: 'c1', name: 'bienvenida', language: 'es', category: 'utility', status: 'approved', parameter_format: 'positional', header: null, body: 'Hola, gracias por escribirnos.', footer: null, buttons: [], variables: [], sendable: true, unsupported_reason: null, rejected_reason: null, synced_at: AT },
          { id: 'tp3', channel_id: 'c1', name: 'en_revision', language: 'es', category: 'utility', status: 'pending', parameter_format: 'positional', header: null, body: 'Tu pedido {{1}}', footer: null, buttons: [], variables: [{ id: 'body:1', part: 'body', key: '1', buttonIndex: null, example: null }], sendable: false, unsupported_reason: 'Meta todavía la está revisando', rejected_reason: null, synced_at: AT },
        ],
        synced_at: AT,
        sync_error: null,
      },
    }),
    'GET /tags': () => ({ body: { items: [{ id: 't0', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true }, { id: 't1', name: 'Curso de uñas', color: '#aa3366', system_key: null, is_system: false }], access: { manage: true } } }),
    'GET /forms': guard('list', () => ({ body: { items: w.form ? [card(w.form)] : [], limits: { max_forms: 50 } } })),
    'POST /forms': guard('create', (c) => {
      w.form = detail({ name: (c.body as { name: string }).name });
      return { status: 201, body: w.form };
    }),
    'GET /forms/f1': guard('get', () => (w.form ? { body: w.form } : err(404, 'NOT_FOUND', 'x'))),
    'PATCH /forms/f1': guard('patch', (c) => {
      const p = c.body as Record<string, unknown>;
      w.form = { ...w.form!, ...(p as Partial<FormDetail>) };
      return { body: w.form };
    }),
    'PUT /forms/f1/fields': guard('fields', (c) => {
      const f = (c.body as { fields: FormField[] }).fields;
      w.form = { ...w.form!, field_count: f.length, fields: f.map((x, i) => ({ ...x, id: `n${i}`, key: x.key ?? `k${i}` })) };
      return { body: w.form };
    }),
    'POST /forms/f1/publish': guard('publish', () => {
      w.form = { ...w.form!, status: 'published', missing: [] };
      return { body: w.form };
    }),
    'POST /forms/f1/pause': guard('pause', () => {
      w.form = { ...w.form!, status: 'paused' };
      return { body: w.form };
    }),
    'DELETE /forms/f1': guard('remove', () => {
      w.form = null;
      return { body: { id: 'f1', deleted: true } };
    }),
    'GET /forms/f1/submissions': guard('subs', () => ({ body: { items: w.submissions, next_cursor: null } })),
  };
}
const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Abrir el formulario Landing de cursos' }));
  return within(await screen.findByRole('dialog', { name: 'Landing de cursos' }));
};
const goTab = (d: ReturnType<typeof within>, name: string) => userEvent.click(d.getByRole('tab', { name }));

describe('Formularios · menú y lista', () => {
  it('el administrador ve «Formularios» en «Captación» y lleva a /forms; el asesor no lo ve', async () => {
    mockApi(server(world()));
    renderApp('/forms');
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    expect(await within(nav).findByRole('link', { name: 'Formularios' })).toHaveAttribute('href', '/forms');
    expect(within(nav).getByText('Captación')).toBeInTheDocument();
  });

  it('un asesor no tiene el enlace en el menú', async () => {
    mockApi(server(world(), ME_ADVISOR));
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Secciones' });
    expect(screen.queryByRole('link', { name: 'Formularios' })).not.toBeInTheDocument();
  });

  it('lista los formularios con su estado y cifras; sin formularios invita a crear el primero', async () => {
    const w = world({ form: detail({ status: 'published', submissions: 3, last_submission_at: AT }) });
    mockApi(server(w));
    renderApp('/forms');
    const row = within(await screen.findByRole('button', { name: 'Abrir el formulario Landing de cursos' }));
    expect(row.getByText('Publicado')).toBeInTheDocument();
    expect(row.getByText(/3 campos · 3 envíos/)).toBeInTheDocument();
  });

  it('sin formularios dice cómo empezar y «Nuevo formulario» crea y abre el formulario', async () => {
    const w = world({ form: null });
    mockApi(server(w));
    renderApp('/forms');
    expect(await screen.findByText(/Aún no tienes formularios/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo formulario' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo formulario' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Crear formulario' }));
    expect(await dlg.findByText('Escribe el nombre del formulario.')).toBeInTheDocument();
    await userEvent.type(dlg.getByLabelText(/Nombre/), 'Landing de cursos');
    await userEvent.click(dlg.getByRole('button', { name: 'Crear formulario' }));
    await waitFor(() => expect(w.calls['create']![0]!.body).toEqual({ name: 'Landing de cursos' }));
    expect(await screen.findByRole('dialog', { name: 'Landing de cursos' })).toBeInTheDocument();
  });

  it('un nombre repetido muestra el motivo del servidor', async () => {
    const w = world({ form: null, fail: { create: () => err(409, 'FORM_EXISTS', 'Ya tienes un formulario con ese nombre') } });
    mockApi(server(w));
    renderApp('/forms');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo formulario' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo formulario' }));
    await userEvent.type(dlg.getByLabelText(/Nombre/), 'Repetido');
    await userEvent.click(dlg.getByRole('button', { name: 'Crear formulario' }));
    expect(await dlg.findByText(/Ya tienes un formulario con ese nombre/)).toBeInTheDocument();
  });
});

describe('Formularios · campos', () => {
  it('el nombre y el WhatsApp son fijos: no se quitan ni se cambia su destino', async () => {
    mockApi(server(world()));
    renderApp('/forms');
    const d = await open();
    expect(d.getByRole('button', { name: 'Quitar «Nombre»' })).toBeDisabled();
    expect(d.getByRole('button', { name: 'Quitar «WhatsApp»' })).toBeDisabled();
    expect(d.getByRole('button', { name: 'Quitar «Correo»' })).toBeEnabled();
    expect(d.getAllByLabelText('Obligatorio')[0]).toBeDisabled();
  });

  it('agregar, ordenar y quitar campos; guardar manda todos con sus claves (los nuevos sin clave) y el campo personalizado elegido', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await userEvent.click(d.getByRole('button', { name: 'Agregar campo' }));
    const items = within(d.getByRole('list', { name: 'Campos del formulario' })).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const last = within(items[3]!);
    const label = last.getByLabelText('Etiqueta');
    await userEvent.clear(label);
    await userEvent.type(label, 'Tu ciudad');
    await userEvent.selectOptions(last.getByLabelText('Se guarda en'), 'custom:ciudad');
    await userEvent.click(last.getByLabelText('Obligatorio'));
    await userEvent.click(d.getByRole('button', { name: 'Subir «Tu ciudad»' }));
    await userEvent.click(d.getByRole('button', { name: 'Subir «Tu ciudad»' }));
    await userEvent.click(d.getByRole('button', { name: 'Quitar «Correo»' }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar campos' }));
    await waitFor(() => expect(w.calls['fields']).toHaveLength(1));
    const sent = (w.calls['fields']![0]!.body as { fields: Array<Record<string, unknown>> }).fields;
    expect(sent.map((f) => f['label'])).toEqual(['Nombre', 'Tu ciudad', 'WhatsApp']);
    expect(sent[0]).toMatchObject({ key: 'nombre', kind: 'text', maps_to: 'name', required: true });
    expect(sent[1]).toMatchObject({ kind: 'text', maps_to: 'custom:ciudad', required: true, options: null, placeholder: null });
    expect(sent[1]).not.toHaveProperty('key');
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('un campo de lista pide sus opciones (una por línea) y las manda limpias', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await userEvent.click(d.getByRole('button', { name: 'Agregar campo' }));
    const last = within(within(d.getByRole('list', { name: 'Campos del formulario' })).getAllByRole('listitem')[3]!);
    await userEvent.selectOptions(last.getByLabelText('Tipo'), 'select');
    await userEvent.type(last.getByLabelText('Opciones'), 'Uñas{enter}{enter}Pestañas');
    await userEvent.click(d.getByRole('button', { name: 'Guardar campos' }));
    await waitFor(() => expect(w.calls['fields']).toHaveLength(1));
    const sent = (w.calls['fields']![0]!.body as { fields: Array<{ kind: string; options: string[] | null }> }).fields;
    expect(sent[3]).toMatchObject({ kind: 'select', options: ['Uñas', 'Pestañas'] });
  });

  it('un error del servidor al guardar los campos se muestra', async () => {
    const w = world({ fail: { fields: () => err(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r1', details: [{ path: 'fields', code: 'needs_phone', message: 'Falta el campo del teléfono (o hay más de uno)' }] } } }) } });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await userEvent.click(d.getByRole('button', { name: 'Guardar campos' }));
    expect(await d.findByText('Falta el campo del teléfono (o hay más de uno)')).toBeInTheDocument();
  });
});

describe('Formularios · destino', () => {
  it('guarda cola, pipeline, etapa abierta, etiqueta, consentimiento, agradecimiento, redirección y prefijo', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Destino');
    const dest = within(await d.findByRole('region', { name: 'Destino del lead' }));
    await userEvent.selectOptions(await dest.findByLabelText('Cola'), 'q1');
    await userEvent.selectOptions(dest.getByLabelText('Pipeline'), 'p1');
    const stage = dest.getByLabelText('Etapa');
    expect(within(stage).queryByRole('option', { name: 'Ganada' })).not.toBeInTheDocument(); // solo etapas abiertas
    await userEvent.selectOptions(stage, 's1');
    const tagSel = dest.getByLabelText('Etiqueta adicional');
    expect(within(tagSel).queryByRole('option', { name: 'Lead' })).not.toBeInTheDocument(); // las del sistema no se ofrecen
    await userEvent.selectOptions(tagSel, 't1');
    const seen = within(d.getByRole('region', { name: 'Lo que ve quien envía' }));
    await userEvent.type(seen.getByLabelText(/Redirigir/), 'https://landing.test/gracias');
    await userEvent.clear(seen.getByLabelText(/Prefijo/));
    await userEvent.type(seen.getByLabelText(/Prefijo/), '+57');
    await userEvent.click(d.getByRole('button', { name: 'Guardar destino' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toMatchObject({ queue_id: 'q1', pipeline_id: 'p1', stage_id: 's1', extra_tag_id: 't1', redirect_url: 'https://landing.test/gracias', phone_prefix: '+57' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('valida antes de enviar: consentimiento corto o agradecimiento vacío; sin pipeline no manda etapa', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Destino');
    const seen = within(await d.findByRole('region', { name: 'Lo que ve quien envía' }));
    await userEvent.clear(seen.getByLabelText(/Texto del consentimiento/));
    await userEvent.type(seen.getByLabelText(/Texto del consentimiento/), 'corto');
    await userEvent.click(d.getByRole('button', { name: 'Guardar destino' }));
    expect(await d.findByText(/al menos 10 caracteres/)).toBeInTheDocument();
    expect(w.calls['patch']).toBeUndefined();
    await userEvent.clear(seen.getByLabelText(/Texto del consentimiento/));
    await userEvent.type(seen.getByLabelText(/Texto del consentimiento/), 'Acepto que me contacten por WhatsApp.');
    await userEvent.click(d.getByRole('button', { name: 'Guardar destino' }));
    await waitFor(() => expect(w.calls['patch']).toHaveLength(1));
    expect(w.calls['patch']![0]!.body).toMatchObject({ queue_id: null, pipeline_id: null, stage_id: null, extra_tag_id: null });
  });

  it('el motivo del servidor al guardar el destino se muestra', async () => {
    const w = world({ fail: { patch: () => err(400, 'VALIDATION_ERROR', 'La cola no existe') } });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Destino');
    await userEvent.click(await d.findByRole('button', { name: 'Guardar destino' }));
    expect(await d.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Formularios · publicación', () => {
  it('muestra lo que falta para publicar; guardar dominios manda uno por línea; publicar, pausar y la dirección pública', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    expect(await d.findByText(/Para publicarlo: autoriza al menos un dominio/)).toBeInTheDocument();
    expect(d.getByLabelText('Dirección pública del formulario')).toHaveValue(`${window.location.origin}/v1/public/forms/8a1d2e3f-0000-4000-8000-000000000001`);
    await userEvent.type(d.getByLabelText(/Dominios desde los que se acepta/), 'landing.test{enter}*.promo.test{enter}');
    await userEvent.click(d.getByRole('button', { name: 'Guardar dominios' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ allowed_domains: ['landing.test', '*.promo.test'] }));
    await userEvent.click(d.getByRole('button', { name: 'Publicar' }));
    await waitFor(() => expect(w.calls['publish']).toHaveLength(1));
    expect(await d.findByText('Recibe envíos.')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(w.calls['pause']).toHaveLength(1));
    expect(await d.findByText('No recibe envíos.')).toBeInTheDocument();
  });

  it('si el servidor no deja publicar (formulario incompleto) muestra el motivo', async () => {
    const w = world({ fail: { publish: () => err(409, 'FORM_INCOMPLETE', 'Antes de publicar: autoriza al menos un dominio') } });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    await userEvent.click(await d.findByRole('button', { name: 'Publicar' }));
    expect(await d.findByText(/Antes de publicar: autoriza al menos un dominio/)).toBeInTheDocument();
  });

  it('borrar pide confirmación; «No» la cancela y «Sí, borrar» lo borra y cierra', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    await userEvent.click(await d.findByRole('button', { name: 'Borrar formulario' }));
    await userEvent.click(d.getByRole('button', { name: 'No' }));
    expect(w.calls['remove']).toBeUndefined();
    await userEvent.click(d.getByRole('button', { name: 'Borrar formulario' }));
    await userEvent.click(d.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['remove']).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Landing de cursos' })).not.toBeInTheDocument());
  });
});

describe('Formularios · envíos', () => {
  it('lista lo recibido con su contacto, si era nuevo, la página y la campaña; sin envíos lo dice', async () => {
    const w = world({ submissions: [{ id: 'e1', at: AT, contact: { id: 'k1', name: 'Lucía Paredes' }, contact_created: true, source_url: 'https://landing.test/oferta', utm: { utm_source: 'facebook', utm_campaign: 'octubre' }, values: {} }, { id: 'e2', at: AT, contact: { id: 'k2', name: 'Ana Díaz' }, contact_created: false, source_url: null, utm: {}, values: {} }] });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Envíos');
    const list = within(await d.findByRole('list', { name: 'Envíos recibidos' }));
    const first = within(list.getAllByRole('listitem')[0]!);
    expect(first.getByText('Lucía Paredes')).toBeInTheDocument();
    expect(first.getByText('Contacto nuevo')).toBeInTheDocument();
    expect(first.getByText(/Desde https:\/\/landing.test\/oferta/)).toBeInTheDocument();
    expect(first.getByText(/utm_source: facebook · utm_campaign: octubre/)).toBeInTheDocument();
    expect(within(list.getAllByRole('listitem')[1]!).getByText('Ya existía')).toBeInTheDocument();
  });

  it('sin envíos muestra «Todavía no hay envíos»', async () => {
    mockApi(server(world()));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Envíos');
    expect(await d.findByText('Todavía no hay envíos.')).toBeInTheDocument();
  });
});

describe('Formularios · seguimiento', () => {
  it('la tarea para el responsable se activa o apaga y se guarda; sin conexión de WhatsApp lo explica', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Seguimiento');
    const task = await d.findByLabelText(/Crear una tarea para el responsable del lead/);
    expect(task).toBeChecked();
    await userEvent.click(task);
    await userEvent.click(d.getByRole('button', { name: 'Guardar seguimiento' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ follow_up_task: false, follow_up_channel_id: null, follow_up_template_id: null, follow_up_params: {} }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('elige conexión (solo activas) y plantilla (solo enviables), pide el valor de cada variable con sugerencias y lo manda con las claves de la plantilla', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Seguimiento');
    const channel = await d.findByLabelText('Conexión');
    expect(within(channel).queryByRole('option', { name: 'Apagada' })).not.toBeInTheDocument();
    await userEvent.selectOptions(channel, 'c1');
    const tpl = await d.findByLabelText('Plantilla');
    await waitFor(() => expect(within(tpl).getByRole('option', { name: 'seguimiento_nombrado (es)' })).toBeInTheDocument());
    expect(within(tpl).queryByRole('option', { name: /en_revision/ })).not.toBeInTheDocument(); // pendiente de aprobación
    await userEvent.selectOptions(tpl, 'tp1');
    expect(await d.findByText(/Hola \{\{nombre\}\}, ¿pudiste revisar la propuesta de \{\{servicio\}\}\?/)).toBeInTheDocument();
    expect(d.getByLabelText('Variable «nombre»')).toHaveValue('{{primer_nombre}}'); // sugerencia para la primera
    // falta el segundo valor: no se envía
    await userEvent.click(d.getByRole('button', { name: 'Guardar seguimiento' }));
    expect(await d.findByText('Escribe un valor para cada variable de la plantilla.')).toBeInTheDocument();
    expect(w.calls['patch']).toBeUndefined();
    await userEvent.click(d.getByLabelText('Variable «servicio»'));
    await userEvent.paste('cursos de {{formulario}}'); // pegar: «{» tecleado sería una tecla especial
    await userEvent.click(d.getByRole('button', { name: 'Guardar seguimiento' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ follow_up_task: true, follow_up_channel_id: 'c1', follow_up_template_id: 'tp1', follow_up_params: { 'body:nombre': '{{primer_nombre}}', 'body:servicio': 'cursos de {{formulario}}' } }));
  });

  it('una plantilla sin variables no pide valores; volver a «Sin plantilla» manda conexión y plantilla en nulo', async () => {
    const w = world({ form: detail({ follow_up: { task: true, channel_id: 'c1', template_id: 'tp2', params: {} } }) });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Seguimiento');
    expect(await d.findByText('Esta plantilla no lleva variables.')).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText('Conexión'), '');
    await userEvent.click(d.getByRole('button', { name: 'Guardar seguimiento' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toMatchObject({ follow_up_channel_id: null, follow_up_template_id: null, follow_up_params: {} }));
  });

  it('el motivo del servidor al guardar el seguimiento se muestra', async () => {
    const w = world({ fail: { patch: () => err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r1', details: [{ path: 'follow_up_template_id', code: 'not_sendable', message: 'Meta todavía la está revisando' }] } } }) } });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Seguimiento');
    await userEvent.click(await d.findByRole('button', { name: 'Guardar seguimiento' }));
    expect(await d.findByText('Meta todavía la está revisando')).toBeInTheDocument();
  });
});

describe('Formularios · código para la página', () => {
  it('muestra el código para incrustar, el iframe, el enlace directo y el del Pixel, con el token del formulario', async () => {
    mockApi(server(world({ form: detail({ status: 'published', missing: [] }) })));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    const code = within(await d.findByRole('region', { name: 'Código para tu página' }));
    const token = '8a1d2e3f-0000-4000-8000-000000000001';
    expect(code.getByLabelText('Código para incrustar (recomendado)')).toHaveTextContent(`<script src="${window.location.origin}/v1/embed/v1.js" data-form="${token}" async></script>`);
    expect(code.getByLabelText('Código de iframe')).toHaveTextContent(`<iframe src="${window.location.origin}/v1/public/forms/${token}/page"`);
    expect(code.getByLabelText('Enlace directo al formulario')).toHaveValue(`${window.location.origin}/v1/public/forms/${token}/page`);
    expect(code.getByLabelText('Para medir con el Pixel de Meta (opcional)')).toHaveTextContent("fbq('track', 'Lead', {}, { eventID: e.detail.event_id })");
    expect(code.getByRole('button', { name: 'Copiar Código para incrustar (recomendado)' })).toBeInTheDocument();
  });

  it('la vista previa solo aparece con el formulario publicado y usa la página alojada; en borrador avisa que hay que publicar', async () => {
    const w = world({ form: detail({ status: 'published', missing: [] }) });
    mockApi(server(w));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    const frame = await d.findByTitle('Vista previa del formulario');
    expect(frame).toHaveAttribute('src', `${window.location.origin}/v1/public/forms/8a1d2e3f-0000-4000-8000-000000000001/page`);
  });

  it('en borrador no hay vista previa y avisa que hay que publicar', async () => {
    mockApi(server(world()));
    renderApp('/forms');
    const d = await open();
    await goTab(d, 'Publicación');
    expect(await d.findByText(/Publica el formulario para que reciba envíos desde tu página/)).toBeInTheDocument();
    expect(d.queryByTitle('Vista previa del formulario')).not.toBeInTheDocument();
  });
});
