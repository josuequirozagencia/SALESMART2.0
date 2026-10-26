import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentCard, AgentOptions, AgentPreview } from '../src/features/agents/useAgents';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-10-26T15:00:00.000Z';
const card = (over: Partial<AgentCard> = {}): AgentCard => ({ id: 'a1', name: 'Sofía', role: 'Asesora de ventas', photo_url: null, cover: 'violet', active: false, model: 'gpt-4o-mini', channels: [], documents: 0, chunks: 0, created_at: AT, ...over });
const agent = (over: Partial<Agent> = {}): Agent => ({
  ...card(),
  temperature: 0.3,
  max_tokens: 500,
  max_chars: 800,
  personality: 'Cálida y cercana',
  objective: '',
  extra_info: '',
  show_source: false,
  split_enabled: false,
  split_blocks: 2,
  transfer_enabled: true,
  transfer_queue_id: null,
  always_on: true,
  document_ids: [],
  channel_ids: [],
  readiness: { instructions: true, documents: false, channel: false },
  updated_at: AT,
  ...over,
});
const OPTIONS: AgentOptions = {
  models: ['gpt-4o-mini', 'gpt-4.1-mini'],
  covers: ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'slate'],
  limits: { max_agents: 20, max_photo_bytes: 2 * 1024 * 1024, max_chunks: 5000 },
  variables: [{ key: 'primer_nombre', label: 'Primer nombre del contacto', example: 'Ana', kind: 'builtin' }, { key: 'contact.ciudad', label: 'Ciudad', example: '', kind: 'custom' }],
  channels: [{ id: 'c1', name: 'WhatsApp Norte', provider: 'meta_cloud', status: 'active', agent: null }, { id: 'c2', name: 'GoHighLevel', provider: 'ghl', status: 'active', agent: { id: 'a9', name: 'Marcos' } }],
  queues: [{ id: 'q1', name: 'Ventas' }],
  documents: [{ id: 'd1', name: 'horarios.txt', status: 'ready', chunk_count: 3000, active: true }, { id: 'd2', name: 'precios.csv', status: 'ready', chunk_count: 2500, active: true }, { id: 'd3', name: 'nuevo.pdf', status: 'processing', chunk_count: 0, active: true }],
};

interface World { agents: Agent[]; calls: Record<string, Call[]>; options: AgentOptions; preview?: AgentPreview; patchFails?: () => ReturnType<Handler> }
const world = (over: Partial<World> = {}): World => ({ agents: [agent()], calls: {}, options: OPTIONS, ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };
const cards = (w: World): AgentCard[] => w.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, photo_url: a.photo_url, cover: a.cover, active: a.active, model: a.model, channels: a.channels, documents: a.document_ids.length, chunks: a.chunks, created_at: a.created_at }));

function server(w: World): Record<string, Handler> {
  const cur = (): Agent => w.agents[0]!;
  const set = (next: Agent): Agent => { w.agents = [next, ...w.agents.slice(1)]; return next; };
  return {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }), // el menú muestra «Agentes IA» a quien administra
    'GET /agents': () => ({ body: { items: cards(w), limits: { max_agents: 20 } } }),
    'GET /agents/options': () => ({ body: w.options }),
    'POST /agents': (c) => {
      rec(w, 'create', c);
      const b = c.body as { name: string; role?: string | null };
      const a = agent({ id: 'a2', name: b.name, role: b.role ?? null, personality: '', readiness: { instructions: false, documents: false, channel: false } });
      w.agents = [...w.agents, a];
      return { status: 201, body: a };
    },
    'GET /agents/a1': () => ({ body: cur() }),
    'GET /agents/a2': () => ({ body: w.agents.find((x) => x.id === 'a2') }),
    'PATCH /agents/a1': (c) => {
      rec(w, 'patch', c);
      if (w.patchFails) return w.patchFails();
      return { body: set({ ...cur(), ...(c.body as object), updated_at: new Date().toISOString() }) };
    },
    'PUT /agents/a1/documents': (c) => { rec(w, 'documents', c); const ids = (c.body as { document_ids: string[] }).document_ids; return { body: set({ ...cur(), document_ids: ids }) }; },
    'PUT /agents/a1/channels': (c) => { rec(w, 'channels', c); const ids = (c.body as { channel_ids: string[] }).channel_ids; return { body: set({ ...cur(), channel_ids: ids, channels: w.options.channels.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, name: x.name })) }) }; },
    'PUT /agents/a1/photo': (c) => { rec(w, 'photo', c); return { body: set({ ...cur(), photo_url: 'https://fake-storage.test/foto.png' }) }; },
    'DELETE /agents/a1/photo': (c) => { rec(w, 'photoDelete', c); return { body: set({ ...cur(), photo_url: null }) }; },
    'DELETE /agents/a1': (c) => { rec(w, 'delete', c); w.agents = []; return { body: { id: 'a1', deleted: true } }; },
    'POST /agents/preview': (c) => { rec(w, 'preview', c); return { body: w.preview ?? { system: 'Eres Sofía.\n\nREGLAS\n- No inventes', missing: [], unknown: [], contact: null } }; },
    'GET /contacts': (c) => { rec(w, 'contacts', c); return { body: { items: [{ id: 'k1', name: 'Lucía Paredes' }] } }; },
  };
}
const open = async (name = 'Sofía') => {
  await userEvent.click(await screen.findByRole('button', { name: `Abrir el agente ${name}` }));
  return within(await screen.findByRole('dialog', { name: `Agente ${name}` }));
};
const goTab = async (d: ReturnType<typeof within>, name: string) => userEvent.click(d.getByRole('tab', { name }));

describe('Agentes IA · galería', () => {
  it('muestra las tarjetas con estado, conexiones, documentos y modelo; el menú tiene «Agentes IA»', async () => {
    const w = world({ agents: [agent({ active: true, channels: [{ id: 'c1', name: 'WhatsApp Norte' }], document_ids: ['d1', 'd2'] }), agent({ id: 'a3', name: 'Marcos', role: null, channels: [] })] });
    mockApi(server(w));
    renderApp('/agents');
    const list = within(await screen.findByRole('list', { name: 'Agentes' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    const sofia = within(list.getByRole('button', { name: 'Abrir el agente Sofía' }));
    expect(sofia.getByText('Activo')).toBeInTheDocument();
    expect(sofia.getByText('WhatsApp Norte')).toBeInTheDocument();
    expect(sofia.getByText(/2 documentos · gpt-4o-mini/)).toBeInTheDocument();
    const marcos = within(list.getByRole('button', { name: 'Abrir el agente Marcos' }));
    expect(marcos.getByText('Apagado')).toBeInTheDocument();
    expect(marcos.getByText('Sin conexión')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agentes IA' })).toHaveAttribute('href', '/agents');
  });

  it('sin agentes invita a crear el primero; «Nuevo agente» pide nombre, crea y abre sus instrucciones', async () => {
    const w = world({ agents: [] });
    mockApi(server(w));
    renderApp('/agents');
    expect(await screen.findByText(/Aún no tienes agentes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo agente' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo agente' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Crear agente' }));
    expect(await dlg.findByRole('alert')).toHaveTextContent('Escribe el nombre del agente.');
    expect(w.calls['create']).toBeUndefined();
    await userEvent.type(dlg.getByLabelText(/Nombre/), 'Lucía');
    await userEvent.type(dlg.getByLabelText('¿Qué hace?'), 'Soporte');
    await userEvent.click(dlg.getByRole('button', { name: 'Crear agente' }));
    await waitFor(() => expect(w.calls['create']![0]!.body).toEqual({ name: 'Lucía', role: 'Soporte' }));
    const agentDlg = within(await screen.findByRole('dialog', { name: 'Agente Lucía' }));
    expect(await agentDlg.findByLabelText('Personalidad')).toBeInTheDocument(); // un agente recién creado abre en «Instrucciones»
  });

  it('un nombre repetido muestra el motivo del servidor', async () => {
    const w = world({ agents: [] });
    const routes = server(w);
    routes['POST /agents'] = () => err(409, 'AGENT_EXISTS', 'Ya tienes un agente con ese nombre');
    mockApi(routes);
    renderApp('/agents');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo agente' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo agente' }));
    await userEvent.type(dlg.getByLabelText(/Nombre/), 'Sofía');
    await userEvent.click(dlg.getByRole('button', { name: 'Crear agente' }));
    expect(await dlg.findByText('Ya tienes un agente con ese nombre')).toBeInTheDocument();
  });
});

describe('Agentes IA · General', () => {
  it('muestra los ajustes y los pendientes; guardar manda todos los campos; un error del servidor se ve (activar sin instrucciones)', async () => {
    const w = world({ agents: [agent({ personality: '', readiness: { instructions: false, documents: false, channel: false } })] });
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    expect(await d.findByLabelText(/Nombre/)).toHaveValue('Sofía');
    expect(d.getByLabelText('Modelo de IA')).toHaveValue('gpt-4o-mini');
    const status = within(d.getByRole('region', { name: 'Estado del agente' }));
    expect(status.getAllByText('Falta')).toHaveLength(3);
    await userEvent.type(d.getByLabelText(/Nombre/), ' V');
    await userEvent.selectOptions(d.getByLabelText('Modelo de IA'), 'gpt-4.1-mini');
    await userEvent.click(d.getByRole('radio', { name: 'Rosa' }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ name: 'Sofía V', role: 'Asesora de ventas', cover: 'rose', model: 'gpt-4.1-mini', temperature: 0.3, max_tokens: 500, max_chars: 800, active: false }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
    w.patchFails = () => err(409, 'AGENT_INCOMPLETE', 'Escribe la personalidad o el objetivo del agente antes de activarlo');
    await userEvent.click(d.getByLabelText('Agente activo'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('antes de activarlo');
  });

  it('valida antes de enviar: nombre vacío y rangos', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await userEvent.clear(await d.findByLabelText(/Nombre/));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Escribe el nombre del agente.');
    await userEvent.type(d.getByLabelText(/Nombre/), 'Sofía');
    await userEvent.clear(d.getByLabelText('Creatividad (0 a 1,5)'));
    await userEvent.type(d.getByLabelText('Creatividad (0 a 1,5)'), '3');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('entre 0 y 1,5');
    expect(w.calls['patch']).toBeUndefined();
  });

  it('subir la foto manda el archivo tal cual y la tarjeta muestra la imagen; quitarla vuelve a las iniciales', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await userEvent.upload(await d.findByLabelText('Elegir foto'), new File([new Uint8Array(1500)], 'foto.png', { type: 'image/png' }));
    await waitFor(() => expect(w.calls['photo']).toHaveLength(1));
    expect(w.calls['photo']![0]!.body).toEqual({ raw_bytes: 1500 });
    expect(w.calls['photo']![0]!.headers['content-type']).toBe('application/octet-stream');
    expect(await d.findByRole('button', { name: 'Cambiar foto' })).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Quitar foto' }));
    await waitFor(() => expect(w.calls['photoDelete']).toHaveLength(1));
    expect(await d.findByRole('button', { name: 'Subir foto' })).toBeInTheDocument();
  });

  it('una foto rechazada muestra el motivo', async () => {
    const w = world();
    const routes = server(w);
    routes['PUT /agents/a1/photo'] = () => err(415, 'AGENT_PHOTO_UNSUPPORTED', 'La foto debe ser una imagen JPEG, PNG o WebP');
    mockApi(routes);
    renderApp('/agents');
    const d = await open();
    await userEvent.setup({ applyAccept: false }).upload(await d.findByLabelText('Elegir foto'), new File(['x'], 'raro.gif', { type: 'image/gif' }));
    expect(await d.findByText('La foto debe ser una imagen JPEG, PNG o WebP')).toBeInTheDocument();
  });
});

describe('Agentes IA · Instrucciones', () => {
  it('guarda los tres bloques; una variable de la lista se inserta en el bloque donde se estaba escribiendo', async () => {
    const w = world({ agents: [agent({ personality: '', objective: 'Agendar' })] });
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Instrucciones');
    const pers = await d.findByLabelText('Personalidad');
    await userEvent.type(pers, 'Hola ');
    await userEvent.click(d.getByRole('button', { name: '{{primer_nombre}}' }));
    expect(pers).toHaveValue('Hola {{primer_nombre}}');
    await userEvent.click(d.getByLabelText('Información adicional'));
    await userEvent.click(d.getByRole('button', { name: '{{contact.ciudad}}' }));
    expect(d.getByLabelText('Información adicional')).toHaveValue('{{contact.ciudad}}');
    await userEvent.click(d.getByRole('button', { name: 'Guardar instrucciones' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ personality: 'Hola {{primer_nombre}}', objective: 'Agendar', extra_info: '{{contact.ciudad}}' }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('una variable inexistente se rechaza con el motivo del servidor', async () => {
    const w = world();
    w.patchFails = () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'personality', code: 'unknown_variable', message: 'La variable «{{apodo}}» no existe.' }] } } });
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Instrucciones');
    await userEvent.click(await d.findByRole('button', { name: 'Guardar instrucciones' }));
    expect(await d.findByRole('alert')).toBeInTheDocument();
  });

  it('la vista previa muestra lo que recibiría el agente con las variables llenas y avisa lo que falta o no existe; se puede probar con un contacto real', async () => {
    const w = world({ preview: { system: 'Eres Sofía.\n\nPERSONALIDAD\nTrata de tú a Lucía.\n\nREGLAS\n- No inventes', missing: ['contact.ciudad'], unknown: ['apodo'], contact: { id: 'k1', name: 'Lucía Paredes' } } });
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Instrucciones');
    const box = within(await d.findByRole('region', { name: 'Vista previa' }));
    await userEvent.type(box.getByLabelText('Buscar un contacto'), 'luc');
    await userEvent.click(await box.findByRole('button', { name: 'Lucía Paredes' }));
    expect(box.getByText('Lucía Paredes')).toBeInTheDocument();
    await userEvent.click(box.getByRole('button', { name: 'Ver vista previa' }));
    await waitFor(() => expect(w.calls['preview']![0]!.body).toEqual({ agent_id: 'a1', personality: 'Cálida y cercana', objective: '', extra_info: '', contact_id: 'k1' }));
    expect(await box.findByLabelText('Mensaje de sistema')).toHaveTextContent('Trata de tú a Lucía.');
    expect(box.getByText(/no existen o no se permiten: \{\{apodo\}\}/)).toBeInTheDocument();
    expect(box.getByText(/no tiene datos para: \{\{contact.ciudad\}\}/)).toBeInTheDocument();
    expect(w.calls['contacts']!.some((c) => c.query.get('q') === 'luc')).toBe(true);
  });
});

describe('Agentes IA · Conocimiento', () => {
  it('elegir documentos suma fragmentos contra el tope; guardar manda la lista y, si cambió, «mostrar fuente»', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Conocimiento');
    const list = within(await d.findByRole('list', { name: 'Documentos de la biblioteca' }));
    expect(list.getByText('Procesando')).toBeInTheDocument();
    expect(d.getByText('0 de 5.000 fragmentos usados')).toBeInTheDocument();
    await userEvent.click(list.getByRole('checkbox', { name: 'Usar «horarios.txt»' }));
    await userEvent.click(list.getByRole('checkbox', { name: 'Usar «precios.csv»' }));
    expect(d.getByText('5.500 de 5.000 fragmentos usados')).toHaveClass('text-crit'); // pasa del tope: se avisa en rojo
    await userEvent.click(list.getByRole('checkbox', { name: 'Usar «precios.csv»' }));
    await userEvent.click(d.getByLabelText('Mostrar de qué documento sale cada dato'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['documents']![0]!.body).toEqual({ document_ids: ['d1'] }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ show_source: true }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('el servidor puede rechazar por el tope y se muestra el motivo; con la biblioteca vacía lo explica', async () => {
    const w = world();
    const routes = server(w);
    routes['PUT /agents/a1/documents'] = () => err(409, 'AGENT_CHUNK_LIMIT', 'Los documentos elegidos suman 5.500 fragmentos y un agente puede usar hasta 5.000: quita alguno');
    mockApi(routes);
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Conocimiento');
    await userEvent.click(await d.findByRole('checkbox', { name: 'Usar «horarios.txt»' }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText(/un agente puede usar hasta 5.000/)).toBeInTheDocument();
  });

  it('sin documentos en la biblioteca lo dice', async () => {
    mockApi(server(world({ options: { ...OPTIONS, documents: [] } })));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Conocimiento');
    expect(await d.findByText(/Tu biblioteca está vacía/)).toBeInTheDocument();
  });
});

describe('Agentes IA · Comportamiento', () => {
  it('guarda los ajustes y las conexiones; la conexión de otro agente aparece bloqueada con su nombre', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Comportamiento');
    const conns = within(await d.findByRole('region', { name: 'Conexiones' }));
    expect(conns.getByRole('checkbox', { name: 'Atender «GoHighLevel»' })).toBeDisabled();
    expect(conns.getByText('Lo atiende Marcos')).toBeInTheDocument();
    await userEvent.click(d.getByLabelText('Dividir las respuestas largas en varios mensajes'));
    await userEvent.selectOptions(d.getByLabelText('Máximo de mensajes por respuesta'), '4');
    await userEvent.selectOptions(d.getByLabelText('Cola a la que pasa'), 'q1');
    await userEvent.click(d.getByLabelText(/Responder a toda hora/));
    await userEvent.click(conns.getByRole('checkbox', { name: 'Atender «WhatsApp Norte»' }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toEqual({ split_enabled: true, split_blocks: 4, transfer_enabled: true, transfer_queue_id: 'q1', always_on: false }));
    await waitFor(() => expect(w.calls['channels']![0]!.body).toEqual({ channel_ids: ['c1'] }));
    expect(await d.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('apagar «pasar con una persona» quita la cola; un conflicto de conexión se muestra', async () => {
    const w = world({ agents: [agent({ transfer_queue_id: 'q1' })] });
    const routes = server(w);
    routes['PUT /agents/a1/channels'] = () => err(409, 'CHANNEL_HAS_AGENT', 'Una de esas conexiones ya la atiende el agente «Marcos»: quítasela primero');
    mockApi(routes);
    renderApp('/agents');
    const d = await open();
    await goTab(d, 'Comportamiento');
    await userEvent.click(await d.findByLabelText('Puede pasar la conversación a una persona del equipo'));
    expect(d.queryByLabelText('Cola a la que pasa')).toBeNull();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['patch']![0]!.body).toMatchObject({ transfer_enabled: false, transfer_queue_id: null }));
    expect(await d.findByText(/ya la atiende el agente «Marcos»/)).toBeInTheDocument();
  });
});

describe('Agentes IA · borrar', () => {
  it('pide confirmación; «No» la cancela y «Sí, borrar» lo borra y cierra', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/agents');
    const d = await open();
    await userEvent.click(await d.findByRole('button', { name: 'Borrar agente' }));
    await userEvent.click(d.getByRole('button', { name: 'No' }));
    expect(w.calls['delete']).toBeUndefined();
    await userEvent.click(d.getByRole('button', { name: 'Borrar agente' }));
    await userEvent.click(d.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['delete']).toHaveLength(1));
    expect(await screen.findByText(/Aún no tienes agentes/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
