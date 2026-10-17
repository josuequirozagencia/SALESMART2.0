import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAccess, ContactTag, CustomField, SavedList } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const ALL: ContactAccess = { view_all: true, write: true, delete: true, import: true, export: true };
const OWN: ContactAccess = { view_all: false, write: true, delete: false, import: false, export: false };
const READ: ContactAccess = { view_all: true, write: false, delete: false, import: false, export: false };

const tag = (id: string, name: string, over: Partial<ContactTag> = {}): ContactTag => ({ id, name, color: '#6a44f2', system_key: null, is_system: false, ...over });
const LEAD = tag('t-lead', 'Lead', { system_key: 'lead', is_system: true, color: '#2563eb' });
const VIP = tag('t-vip', 'VIP', { color: '#ff0000' });
const FRIO = tag('t-frio', 'Frío');
const fld = (key: string, name: string, type: CustomField['type'], over: Partial<CustomField> = {}): CustomField => ({ id: `f-${key}`, entity: 'contact', name, key, type, options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: '2026-10-10T15:00:00.000Z', ...over });
const CIUDAD = fld('ciudad', 'Ciudad', 'text');
const INTERES = fld('interes', 'Interés', 'select', { options: ['Uñas', 'Barbería'] });
const EDAD = fld('edad', 'Edad', 'number');
const contact = (id: string, name: string, over: Partial<Contact> = {}): Contact => ({
  id, name, email: `${id}@correo.test`, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], attribution: null,
  created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});
const ANA = contact('c1', 'Ana Torres', { consent: 'granted', tags: [LEAD, VIP], custom_fields: { ciudad: 'Quito', interes: 'Uñas', edad: 34 } });
const BETO = contact('c2', 'Beto Luna', { custom_fields: { ciudad: 'Cuenca' } });
const list = (id: string, name: string, over: Partial<SavedList> = {}): SavedList => ({ id, name, kind: 'dynamic', filters: {}, columns: null, sort: null, shared: false, mine: true, member_count: null, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over });

interface World { routes: Record<string, Handler>; lists: SavedList[]; posts: Call[]; patches: Array<{ id: string; call: Call }>; members: Array<{ id: string; call: Call }>; deletes: string[] }

/** Servidor de contactos con listas, etiquetas y campos. mockApi no admite rutas con parámetros: se enrutan una a una por id conocido. */
function world(access: ContactAccess = ALL, initial: SavedList[] = [], over: { manage?: boolean; addMembers?: Handler } = {}): World {
  const w: World = { routes: {}, lists: [...initial], posts: [], patches: [], members: [], deletes: [] };
  w.routes = {
    ...authed(access.view_all ? ME_ADMIN : ME_ADVISOR),
    'GET /contacts': () => ({ body: { items: [ANA, BETO], next_cursor: null, total: 2, access } }),
    'GET /contacts/owners': () => ({ body: { items: [] } }),
    'GET /tags': () => ({ body: { items: [LEAD, VIP, FRIO], access: { manage: over.manage ?? access.view_all } } }),
    'GET /custom-fields': () => ({ body: { items: [CIUDAD, INTERES, EDAD], access: { manage: access.view_all } } }),
    'GET /contact-lists': () => ({ body: { items: w.lists } }),
    'POST /contact-lists': (call) => {
      w.posts.push(call);
      const b = call.body as { name: string; kind: SavedList['kind']; filters?: SavedList['filters']; columns?: string[]; sort?: SavedList['sort']; shared?: boolean; contact_ids?: string[] };
      const made = list('new-list', b.name, { kind: b.kind, filters: b.filters ?? {}, columns: b.columns ?? null, sort: b.sort ?? null, shared: b.shared ?? false, member_count: b.kind === 'fixed' ? (b.contact_ids?.length ?? 0) : null });
      w.lists = [...w.lists, made];
      return { status: 201, body: made };
    },
  };
  for (const id of [...initial.map((l) => l.id), 'new-list']) {
    w.routes[`PATCH /contact-lists/${id}`] = (call) => {
      w.patches.push({ id, call });
      const cur = w.lists.find((l) => l.id === id)!;
      Object.assign(cur, call.body);
      return { body: cur };
    };
    w.routes[`DELETE /contact-lists/${id}`] = () => {
      w.deletes.push(id);
      w.lists = w.lists.filter((l) => l.id !== id);
      return { body: { id, deleted: true } };
    };
    w.routes[`POST /contact-lists/${id}/members`] = over.addMembers ?? ((call) => {
      w.members.push({ id, call });
      return { body: { added: (call.body as { contact_ids: string[] }).contact_ids.length, skipped: 0 } };
    });
  }
  return w;
}
const lastQuery = (api: ReturnType<typeof mockApi>): URLSearchParams => api.last('GET /contacts')!.query;
const tableRow = (name: string) => within(within(screen.getByRole('table', { name: 'Contactos' })).getByRole('button', { name: `Abrir el contacto ${name}` }).closest('tr')!);

describe('Contactos · columnas', () => {
  it('por defecto muestra nombre, teléfono, responsable, consentimiento, etiquetas y creado; el menú agrega, quita y reordena, y lo recuerda el navegador', async () => {
    mockApi(world().routes);
    const a = renderApp('/contacts');
    const table = await screen.findByRole('table', { name: 'Contactos' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Nombre', 'Teléfono', 'Responsable', 'Consentimiento', 'Etiquetas', 'Creado']);
    expect(within(tableRow('Ana Torres').getByRole('list', { name: 'Etiquetas' })).getByText('VIP')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Columnas · 6' }));
    const menu = within(screen.getByRole('group', { name: 'Columnas de la tabla' }));
    expect(menu.getByLabelText('Nombre')).toBeDisabled(); // desde ahí se abre el contacto
    await userEvent.click(menu.getByLabelText('Correo'));
    await userEvent.click(menu.getByLabelText('Ciudad')); // un campo personalizado también es una columna
    await userEvent.click(menu.getByLabelText('Creado')); // quitar
    await userEvent.click(menu.getByRole('button', { name: 'Subir Ciudad' }));
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Nombre', 'Teléfono', 'Responsable', 'Consentimiento', 'Etiquetas', 'Ciudad', 'Correo']);
    expect(tableRow('Ana Torres').getByText('Quito')).toBeInTheDocument();
    expect(tableRow('Ana Torres').getByText('c1@correo.test')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('ss:contacts:columns')!)).toEqual(['name', 'phone', 'owner', 'consent', 'tags', 'cf:ciudad', 'email']);
    expect(menu.getByRole('button', { name: 'Subir Teléfono' })).toBeDisabled(); // ya está justo debajo de Nombre
    expect(menu.getByRole('button', { name: 'Subir Responsable' })).toBeEnabled();
    expect(menu.queryByRole('button', { name: 'Subir Nombre' })).not.toBeInTheDocument();

    a.unmount();
    vi.unstubAllGlobals();
    resetWorld();
    mockApi(world().routes);
    renderApp('/contacts');
    const again = await screen.findByRole('table', { name: 'Contactos' });
    expect(within(again).getAllByRole('columnheader').map((h) => h.textContent)).toContain('Ciudad'); // se recuerda
  });

  it('un valor de campo personalizado se muestra con su formato (número, Sí/No, lista) y las columnas desconocidas del almacenamiento se ignoran', async () => {
    window.localStorage.setItem('ss:contacts:columns', JSON.stringify(['email', 'cf:edad', 'cf:borrado', 'basura', 'cf:interes']));
    mockApi(world().routes);
    renderApp('/contacts');
    const table = await screen.findByRole('table', { name: 'Contactos' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Nombre', 'Correo', 'Edad', 'Interés']);
    expect(tableRow('Ana Torres').getByText('34')).toBeInTheDocument();
    expect(tableRow('Ana Torres').getByText('Uñas')).toBeInTheDocument();
    window.localStorage.setItem('ss:contacts:columns', '{rota');
  });
});

describe('Contactos · filtros', () => {
  it('consentimiento y etiquetas viajan como parámetros y se ven como filtros activos que se quitan con la ×', async () => {
    const api = mockApi(world().routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.selectOptions(screen.getByLabelText('Consentimiento'), 'Con consentimiento');
    await waitFor(() => expect(lastQuery(api).get('consent')).toBe('granted'));
    await userEvent.selectOptions(screen.getByLabelText('Etiqueta'), 'VIP');
    await userEvent.selectOptions(screen.getByLabelText('Etiqueta'), 'Frío');
    await waitFor(() => expect(lastQuery(api).getAll('tag')).toEqual(['t-vip', 't-frio']));
    expect(within(screen.getByLabelText('Etiqueta')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Agregar etiqueta…', 'Lead']); // las ya elegidas no se vuelven a ofrecer (las del sistema también se pueden filtrar)
    const chips = within(screen.getByRole('list', { name: 'Filtros activos' }));
    expect(chips.getByText('Con consentimiento')).toBeInTheDocument();
    expect(chips.getByText('Etiqueta: VIP')).toBeInTheDocument();
    await userEvent.click(chips.getByRole('button', { name: 'Quitar el filtro Etiqueta: VIP' }));
    await waitFor(() => expect(lastQuery(api).getAll('tag')).toEqual(['t-frio']));
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => expect(lastQuery(api).get('consent')).toBeNull());
    expect(lastQuery(api).getAll('tag')).toEqual([]);
    expect(screen.queryByRole('list', { name: 'Filtros activos' })).not.toBeInTheDocument();
  });

  it('filtrar por campo personalizado: los operadores dependen del tipo y el filtro viaja como variable:operador:valor', async () => {
    const api = mockApi(world().routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar por campo' }));
    const form = within(screen.getByRole('form', { name: 'Filtrar por campo' }));
    expect(within(form.getByLabelText('Condición')).getAllByRole('option').map((o) => o.textContent)).toEqual(['es igual a', 'contiene', 'tiene valor', 'está vacío']); // texto
    await userEvent.selectOptions(form.getByLabelText('Condición'), 'contiene');
    await userEvent.type(form.getByLabelText('Valor del filtro'), 'quito');
    await userEvent.click(form.getByRole('button', { name: 'Agregar filtro' }));
    await waitFor(() => expect(lastQuery(api).getAll('cf')).toEqual(['ciudad:contains:quito']));
    expect(within(screen.getByRole('list', { name: 'Filtros activos' })).getByText('Ciudad contiene quito')).toBeInTheDocument();

    await userEvent.selectOptions(form.getByLabelText('Campo'), 'Interés (Selección única)');
    expect(within(form.getByLabelText('Condición')).getAllByRole('option').map((o) => o.textContent)).toEqual(['es igual a', 'tiene valor', 'está vacío']); // selección única
    await userEvent.selectOptions(form.getByLabelText('Valor del filtro'), 'Barbería');
    await userEvent.click(form.getByRole('button', { name: 'Agregar filtro' }));
    await userEvent.selectOptions(form.getByLabelText('Campo'), 'Edad (Número)');
    expect(within(form.getByLabelText('Condición')).getAllByRole('option').map((o) => o.textContent)).toContain('es mayor o igual a');
    await userEvent.selectOptions(form.getByLabelText('Condición'), 'es mayor o igual a');
    await userEvent.type(form.getByLabelText('Valor del filtro'), '30,5');
    await userEvent.click(form.getByRole('button', { name: 'Agregar filtro' }));
    await userEvent.selectOptions(form.getByLabelText('Condición'), 'tiene valor');
    expect(form.queryByLabelText('Valor del filtro')).not.toBeInTheDocument(); // no necesita valor
    await userEvent.click(form.getByRole('button', { name: 'Agregar filtro' }));
    await waitFor(() => expect(lastQuery(api).getAll('cf')).toEqual(['ciudad:contains:quito', 'interes:eq:Barbería', 'edad:gte:30.5', 'edad:is_set']));
    const chips = within(screen.getByRole('list', { name: 'Filtros activos' }));
    expect(chips.getByText('Edad es mayor o igual a 30.5')).toBeInTheDocument();
    await userEvent.click(chips.getByRole('button', { name: 'Quitar el filtro Ciudad contiene quito' }));
    await waitFor(() => expect(lastQuery(api).getAll('cf')).toEqual(['interes:eq:Barbería', 'edad:gte:30.5', 'edad:is_set']));
  });

  it('un error del servidor al filtrar se muestra y se puede reintentar', async () => {
    const w = world();
    let fail = false;
    w.routes['GET /contacts'] = () => (fail ? err(400, 'VALIDATION_ERROR') : { body: { items: [ANA], next_cursor: null, total: 1, access: ALL } });
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    fail = true;
    await userEvent.selectOptions(screen.getByLabelText('Consentimiento'), 'Con consentimiento');
    expect(await screen.findByRole('alert')).toHaveTextContent('Revisa los datos ingresados.');
  });
});

describe('Contactos · listas', () => {
  it('las listas aparecen como pestañas; una dinámica carga sus filtros (no manda list=) y una fija manda list=<id>', async () => {
    const w = world(ALL, [
      list('l-din', 'VIP con consentimiento', { filters: { consent: 'granted', tag: ['t-vip'], cf: ['ciudad:eq:Quito'], q: 'ana' }, sort: { key: 'name', order: 'asc' } }),
      list('l-fija', 'Mi selección', { kind: 'fixed', member_count: 2, shared: true }),
    ]);
    const api = mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    const tabs = within(screen.getByRole('tablist', { name: 'Listas' }));
    expect(tabs.getByRole('tab', { name: 'Todos' })).toHaveAttribute('aria-selected', 'true');
    expect(await tabs.findByRole('tab', { name: /^Mi selección/ })).toHaveTextContent('Mi selección · 2 · compartida');

    await userEvent.click(await tabs.findByRole('tab', { name: /VIP con consentimiento/ }));
    await waitFor(() => expect(lastQuery(api).get('consent')).toBe('granted'));
    const q1 = lastQuery(api);
    expect(q1.getAll('tag')).toEqual(['t-vip']);
    expect(q1.getAll('cf')).toEqual(['ciudad:eq:Quito']);
    expect(q1.get('q')).toBe('ana');
    expect([q1.get('sort'), q1.get('order')]).toEqual(['name', 'asc']);
    expect(q1.get('list')).toBeNull();
    expect(screen.getByLabelText('Buscar')).toHaveValue('ana');
    expect(screen.getByLabelText('Consentimiento')).toHaveValue('granted');
    expect(within(screen.getByRole('list', { name: 'Filtros activos' })).getByText('Ciudad es igual a Quito')).toBeInTheDocument();

    await userEvent.click(tabs.getByRole('tab', { name: /Mi selección/ }));
    await waitFor(() => expect(lastQuery(api).get('list')).toBe('l-fija'));
    expect(lastQuery(api).get('consent')).toBeNull(); // una fija no hereda filtros
    expect(screen.queryByRole('list', { name: 'Filtros activos' })).not.toBeInTheDocument();
    await userEvent.click(tabs.getByRole('tab', { name: 'Todos' }));
    await waitFor(() => expect(lastQuery(api).get('list')).toBeNull());
    expect(screen.getByLabelText('Buscar')).toHaveValue('');
  });

  it('«Nueva lista» guarda los filtros, las columnas y el orden actuales como lista dinámica y la abre', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.selectOptions(screen.getByLabelText('Consentimiento'), 'Con consentimiento');
    await userEvent.selectOptions(screen.getByLabelText('Orden'), 'Nombre (A–Z)');
    await userEvent.click(screen.getByRole('button', { name: '+ Nueva lista' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva lista' }));
    expect(d.getByText(/Lista dinámica con los filtros, el orden y las columnas actuales/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Crear lista' }));
    expect(await d.findByText('Escribe un nombre para la lista')).toBeInTheDocument();
    expect(w.posts).toHaveLength(0);
    await userEvent.type(d.getByLabelText('Nombre de la lista'), '  Interesados de octubre ');
    await userEvent.click(d.getByLabelText('Compartir con toda la empresa'));
    await userEvent.click(d.getByRole('button', { name: 'Crear lista' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toEqual({ name: 'Interesados de octubre', kind: 'dynamic', filters: { consent: 'granted' }, columns: ['name', 'phone', 'owner', 'consent', 'tags', 'created_at'], sort: { key: 'name', order: 'asc' }, shared: true });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Interesados de octubre/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('el asesor crea listas personales: no ve «compartir»; sin permiso de escritura no hay listas ni casillas', async () => {
    const w = world(OWN);
    mockApi(w.routes);
    const a = renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('button', { name: '+ Nueva lista' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva lista' }));
    expect(d.queryByLabelText('Compartir con toda la empresa')).not.toBeInTheDocument();
    expect(d.getByText('Esta lista es solo tuya.')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Nombre de la lista'), 'Mis pendientes');
    await userEvent.click(d.getByRole('button', { name: 'Crear lista' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).not.toHaveProperty('shared');
    a.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    mockApi(world(READ).routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    expect(screen.queryByRole('button', { name: '+ Nueva lista' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Seleccionar/ })).not.toBeInTheDocument();
  });

  it('renombrar, compartir y borrar desde «Editar lista»; solo su dueño (o quien ve todo en una compartida) ve el lápiz', async () => {
    const w = world(ALL, [list('l1', 'Mi lista'), list('l2', 'De otra persona', { mine: false, shared: true }), list('l3', 'Privada ajena', { mine: false, shared: false })]);
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('tab', { name: /Mi lista/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Editar la lista Mi lista' }));
    const d = within(await screen.findByRole('dialog', { name: 'Editar lista' }));
    expect(d.getByText(/Lista dinámica: se actualiza sola/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText('Nombre de la lista'));
    await userEvent.type(d.getByLabelText('Nombre de la lista'), 'Renombrada');
    await userEvent.click(d.getByLabelText('Compartir con toda la empresa'));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.patches).toHaveLength(1));
    expect(w.patches[0]!.call.body).toEqual({ name: 'Renombrada', shared: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /Renombrada/ })).toHaveAttribute('aria-selected', 'true'); // sigue abierta

    await userEvent.click(screen.getByRole('button', { name: 'Editar la lista Renombrada' }));
    const e = within(await screen.findByRole('dialog', { name: 'Editar lista' }));
    await userEvent.click(e.getByRole('button', { name: 'Eliminar lista' }));
    expect(e.getByText(/Los contactos no se borran/)).toBeInTheDocument();
    await userEvent.click(e.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.deletes).toEqual(['l1']));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Renombrada/ })).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Todos' })).toHaveAttribute('aria-selected', 'true');
    // quien ve todo también edita una compartida de otra persona; una privada ajena ni siquiera existe para él (el servidor no la manda)
    await userEvent.click(screen.getByRole('tab', { name: /De otra persona/ }));
    expect(screen.getByRole('button', { name: 'Editar la lista De otra persona' })).toBeInTheDocument();
  });

  it('el asesor no puede editar una lista compartida por otra persona (solo usarla)', async () => {
    const w = world(OWN, [list('l2', 'Compartida', { mine: false, shared: true })]);
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('tab', { name: /Compartida/ }));
    expect(screen.queryByRole('button', { name: /Editar la lista/ })).not.toBeInTheDocument();
  });

  it('cambiar columnas, filtros u orden de una lista abierta avisa y se guardan con un clic', async () => {
    const w = world(ALL, [list('l1', 'Mi lista', { filters: { consent: 'granted' } })]);
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('tab', { name: /Mi lista/ }));
    expect(screen.queryByText(/Cambiaste/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Consentimiento'), 'Sin consentimiento (lo retiró)');
    await userEvent.click(screen.getByRole('button', { name: 'Columnas · 6' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Columnas de la tabla' })).getByLabelText('Correo'));
    expect(await screen.findByText(/Cambiaste los filtros, las columnas o el orden/)).toBeInTheDocument();
    expect(window.localStorage.getItem('ss:contacts:columns')).toBeNull(); // las columnas de una lista no tocan las de «Todos»
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios en la lista' }));
    await waitFor(() => expect(w.patches).toHaveLength(1));
    expect(w.patches[0]!.call.body).toEqual({ filters: { consent: 'revoked' }, columns: ['name', 'phone', 'owner', 'consent', 'tags', 'created_at', 'email'], sort: { key: 'created_at', order: 'desc' } });
    expect(await screen.findByText('Cambios guardados en la lista.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Cambiaste/)).not.toBeInTheDocument());
  });
});

describe('Contactos · selección', () => {
  it('las casillas seleccionan (también «todos los que se ven»); la barra crea una lista fija con la selección y la abre', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a Ana Torres' }));
    expect(within(screen.getByRole('status')).getByText('1 seleccionado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los contactos que se ven' }));
    expect(within(screen.getByRole('status')).getByText('2 seleccionados')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los contactos que se ven' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a Ana Torres' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a Beto Luna' }));
    await userEvent.click(screen.getByRole('button', { name: 'Crear lista con la selección' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva lista' }));
    expect(d.getByText('Lista fija con los 2 contactos seleccionados.')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Nombre de la lista'), 'Mi selección');
    await userEvent.click(d.getByRole('button', { name: 'Crear lista' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toMatchObject({ name: 'Mi selección', kind: 'fixed', contact_ids: ['c1', 'c2'] });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Mi selección/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('tab', { name: /^Mi selección/ })).toHaveTextContent('Mi selección · 2');
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); // la selección se limpia
  });

  it('«Agregar a una lista» solo ofrece listas fijas editables y avisa cuántos entraron; "Quitar selección" limpia', async () => {
    const w = world(ALL, [list('l-fija', 'Fija mía', { kind: 'fixed', member_count: 0 }), list('l-din', 'Dinámica'), list('l-aj', 'Fija ajena privada', { kind: 'fixed', mine: false, shared: false })]);
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a Ana Torres' }));
    const select = screen.getByLabelText('Lista a la que agregar');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Agregar a una lista…', 'Fija mía']);
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeDisabled();
    await userEvent.selectOptions(select, 'Fija mía');
    await userEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(w.members).toHaveLength(1));
    expect(w.members[0]).toMatchObject({ id: 'l-fija' });
    expect(w.members[0]!.call.body).toEqual({ contact_ids: ['c1'] });
    expect(await screen.findByText('Se agregaron 1 contacto a la lista.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar a Beto Luna' }));
    await userEvent.click(screen.getByRole('button', { name: 'Quitar selección' }));
    expect(screen.queryByLabelText('Lista a la que agregar')).not.toBeInTheDocument();
  });

  it('una selección de más de 500 contactos no se puede convertir en lista de una vez', async () => {
    const many = Array.from({ length: 501 }, (_, i) => contact(`m${i}`, `Contacto ${i}`));
    const w = world();
    w.routes['GET /contacts'] = () => ({ body: { items: many, next_cursor: null, total: 501, access: ALL } });
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByRole('table', { name: 'Contactos' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los contactos que se ven' }));
    await userEvent.click(screen.getByRole('button', { name: 'Crear lista con la selección' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva lista' }));
    expect(d.getByText(/hasta 500 contactos a la vez/)).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Crear lista' })).toBeDisabled();
  });
});

describe('Contacto · etiquetas personalizadas', () => {
  it('ofrece solo las personalizadas (no las del sistema), las muestra marcadas al editar y envía tag_ids solo si cambian', async () => {
    const w = world();
    const patches: Call[] = [];
    w.routes['PATCH /contacts/c1'] = (call) => { patches.push(call); return { body: ANA }; };
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    const set = within(await d.findByRole('group', { name: 'Etiquetas' }));
    expect(set.queryByLabelText('Lead')).not.toBeInTheDocument(); // la del sistema no se elige
    expect(set.getByLabelText('VIP')).toBeChecked();
    expect(set.getByLabelText('Frío')).not.toBeChecked();
    expect(within(d.getByRole('list', { name: 'Etiquetas' })).getByText('Lead')).toBeInTheDocument(); // sí se ve como insignia

    await userEvent.click(d.getByRole('button', { name: 'Guardar' })); // sin tocar las etiquetas
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.body).not.toHaveProperty('tag_ids');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const e = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    await userEvent.click(within(await e.findByRole('group', { name: 'Etiquetas' })).getByLabelText('VIP'));
    await userEvent.click(within(e.getByRole('group', { name: 'Etiquetas' })).getByLabelText('Frío'));
    await userEvent.click(e.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect((patches[1]!.body as { tag_ids: string[] }).tag_ids).toEqual(['t-frio']);
  });

  it('al crear un contacto envía las etiquetas elegidas', async () => {
    const w = world();
    const posts: Call[] = [];
    w.routes['POST /contacts'] = (call) => { posts.push(call); return { status: 201, body: ANA }; };
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(await d.findByLabelText('Nombre'), 'Carla');
    await userEvent.click(within(await d.findByRole('group', { name: 'Etiquetas' })).getByLabelText('Frío'));
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.body as { tag_ids: string[] }).tag_ids).toEqual(['t-frio']);
  });
});

describe('Configuración › Etiquetas', () => {
  function tagsWorld(manage = true) {
    const s = { tags: [LEAD, VIP, FRIO], posts: [] as Call[], patches: [] as Call[], deletes: [] as string[], routes: {} as Record<string, Handler> };
    s.routes = {
      ...authed(ME_ADMIN),
      'GET /tags': () => ({ body: { items: s.tags, access: { manage } } }),
      'POST /tags': (call) => {
        s.posts.push(call);
        const b = call.body as { name: string; color: string };
        const made = tag('t-new', b.name, { color: b.color });
        s.tags = [...s.tags, made];
        return { status: 201, body: made };
      },
      'PATCH /tags/t-vip': (call) => { s.patches.push(call); s.tags = s.tags.map((t) => (t.id === 't-vip' ? { ...t, ...(call.body as object) } : t)); return { body: s.tags.find((t) => t.id === 't-vip') }; },
      'DELETE /tags/t-frio': () => { s.deletes.push('t-frio'); s.tags = s.tags.filter((t) => t.id !== 't-frio'); return { body: { id: 't-frio', deleted: true } }; },
    };
    return s;
  }

  it('lista las del sistema (sin acciones) y las personalizadas; el administrador crea, edita y borra', async () => {
    const s = tagsWorld();
    mockApi(s.routes);
    renderApp('/settings/tags');
    const sys = within(await screen.findByRole('region', { name: 'Etiquetas del sistema' }));
    expect(sys.getByText('Lead')).toBeInTheDocument();
    expect(sys.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Etiquetas' })).toHaveAttribute('href', '/settings/tags');

    await userEvent.click(screen.getByRole('button', { name: 'Nueva etiqueta' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva etiqueta' }));
    await userEvent.click(d.getByRole('button', { name: 'Crear etiqueta' }));
    expect(await d.findByText('Escribe el nombre de la etiqueta')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Nombre'), 'Cliente nuevo');
    fireEvent.change(d.getByLabelText('Color'), { target: { value: '#00ff00' } });
    await userEvent.click(d.getByRole('button', { name: 'Crear etiqueta' }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.body).toEqual({ name: 'Cliente nuevo', color: '#00ff00' });
    expect(await screen.findByText('Cliente nuevo')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Editar VIP' }));
    const e = within(await screen.findByRole('dialog', { name: 'Editar etiqueta' }));
    await userEvent.clear(e.getByLabelText('Nombre'));
    await userEvent.type(e.getByLabelText('Nombre'), 'Muy VIP');
    await userEvent.click(e.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(s.patches[0]!.body).toEqual({ name: 'Muy VIP', color: '#ff0000' });
    expect(await screen.findByText('Muy VIP')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Borrar Frío' }));
    expect(screen.getByText(/Los contactos no se borran/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(s.deletes).toEqual(['t-frio']));
    await waitFor(() => expect(screen.queryByText('Frío')).not.toBeInTheDocument());
  });

  it('quien no administra ve la lista sin acciones; un nombre repetido se explica', async () => {
    mockApi(tagsWorld(false).routes);
    const a = renderApp('/settings/tags');
    expect(await screen.findByText('Solo el administrador de la empresa puede crear o cambiar etiquetas.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva etiqueta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar VIP' })).not.toBeInTheDocument();
    a.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    const s = tagsWorld();
    s.routes['POST /tags'] = () => err(409, 'TAG_EXISTS', 'Ya existe una etiqueta con ese nombre');
    mockApi(s.routes);
    renderApp('/settings/tags');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva etiqueta' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva etiqueta' }));
    await userEvent.type(d.getByLabelText('Nombre'), 'vip');
    await userEvent.click(d.getByRole('button', { name: 'Crear etiqueta' }));
    expect(await d.findByText('Ya existe una etiqueta con ese nombre')).toBeInTheDocument();
  });
});
