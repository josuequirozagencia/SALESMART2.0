import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAccess, ContactList, OwnerOption } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, ME_AGENCY_IN_CLIENT, mockApi, renderApp, resetWorld, trial, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ALL: ContactAccess = { view_all: true, write: true, delete: true };
const OWN: ContactAccess = { view_all: false, write: true, delete: false };
const READ: ContactAccess = { view_all: true, write: false, delete: false };

const contact = (id: string, name: string, over: Partial<Contact> = {}): Contact => ({
  id,
  name,
  email: null,
  phones: [],
  owner: null,
  source: 'manual',
  consent: 'unknown',
  consent_updated_at: null,
  custom_fields: {}, tags: [], attribution: null,
  created_at: '2026-10-10T15:00:00.000Z',
  updated_at: '2026-10-10T15:00:00.000Z',
  ...over,
});
const ANA = contact('c1', 'Ana Torres', { email: 'ana@correo.test', phones: [{ e164: '+593984217730', primary: true }, { e164: '+34612345678', primary: false }], owner: { id: 'u2', name: 'Luis Navas' }, consent: 'granted' });
const BETO = contact('c2', 'Beto Luna', { phones: [{ e164: '+593991112233', primary: true }], consent: 'revoked' });
const OWNERS: OwnerOption[] = [
  { id: 'u1', name: 'Ana Pérez', email: 'ana@empresa.test', role: 'client_admin' },
  { id: 'u2', name: 'Luis Navas', email: 'luis@empresa.test', role: 'advisor' },
];

interface Server {
  routes: Record<string, Handler>;
  state: Contact[];
  /** Cuerpos recibidos por método. */
  posts: unknown[];
  patches: Array<{ id: string; body: unknown }>;
  deletes: string[];
}

/** Servidor de contactos con estado (como el real: crea, edita, borra y lista). mockApi no admite rutas con parámetros: se enrutan una a una. */
function server(me: typeof ME_ADMIN, access: ContactAccess, initial: Contact[] = [ANA, BETO], over: { post?: Handler; patch?: Handler; page?: (c: Call) => ContactList | undefined } = {}): Server {
  const s: Server = { routes: {}, state: [...initial], posts: [], patches: [], deletes: [] };
  const ids = new Set(initial.map((c) => c.id));
  ids.add('new1');
  s.routes = {
    ...authed(me, trial()),
    'GET /contacts': (call) => {
      const custom = over.page?.(call);
      if (custom) return { body: custom };
      const q = (call.query.get('q') ?? '').toLowerCase();
      const items = s.state.filter((c) => q === '' || c.name.toLowerCase().includes(q));
      return { body: { items, next_cursor: null, total: call.query.get('cursor') ? null : items.length, access } satisfies ContactList };
    },
    'GET /contacts/owners': () => (access.view_all ? { body: { items: OWNERS } } : err(403, 'FORBIDDEN')),
    'POST /contacts': over.post ?? ((call) => {
      s.posts.push(call.body);
      const b = call.body as { name: string; email: string | null; phones: string[]; consent: Contact['consent']; owner_id?: string | null };
      const made = contact('new1', b.name, { email: b.email, phones: b.phones.map((e164, i) => ({ e164, primary: i === 0 })), consent: b.consent, owner: OWNERS.find((o) => o.id === b.owner_id) ? { id: b.owner_id!, name: OWNERS.find((o) => o.id === b.owner_id)!.name } : null });
      s.state.unshift(made);
      return { status: 201, body: made };
    }),
  };
  for (const id of ids) {
    s.routes[`PATCH /contacts/${id}`] = over.patch ?? ((call) => {
      s.patches.push({ id, body: call.body });
      const b = call.body as Partial<{ name: string; email: string | null; phones: string[]; consent: Contact['consent'] }>;
      const at = s.state.findIndex((c) => c.id === id);
      const cur = s.state[at]!;
      const next: Contact = { ...cur, ...(b.name !== undefined ? { name: b.name } : {}), ...(b.email !== undefined ? { email: b.email } : {}), ...(b.consent ? { consent: b.consent } : {}), ...(b.phones ? { phones: b.phones.map((e164, i) => ({ e164, primary: i === 0 })) } : {}) };
      s.state[at] = next;
      return { body: next };
    });
    s.routes[`DELETE /contacts/${id}`] = () => {
      s.deletes.push(id);
      s.state = s.state.filter((c) => c.id !== id);
      return { body: { id, deleted: true } };
    };
  }
  return s;
}

const open = async (name: string) => userEvent.click(await screen.findByRole('button', { name: `Abrir el contacto ${name}` }));
const dialog = async () => screen.findByRole('dialog');

describe('Contactos · lista', () => {
  it('el menú tiene «Contactos»; la lista muestra nombre, correo, teléfonos con formato, responsable, consentimiento y el total', async () => {
    const s = server(ME_ADMIN, ALL);
    mockApi(s.routes);
    renderApp('/contacts');
    expect(await screen.findByRole('link', { name: 'Contactos' })).toHaveAttribute('href', '/contacts');
    const list = await screen.findByRole('list', { name: 'Contactos' });
    const ana = within(within(list).getByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    expect(ana.getByText('ana@correo.test')).toBeInTheDocument();
    expect(ana.getByText(/\+593 98 421 7730/)).toBeInTheDocument();
    expect(ana.getByText(/\+1 más/)).toBeInTheDocument();
    expect(ana.getByText('Luis Navas')).toBeInTheDocument();
    expect(ana.getByText('Con consentimiento')).toBeInTheDocument();
    const beto = within(within(list).getByRole('button', { name: 'Abrir el contacto Beto Luna' }));
    expect(beto.getByText('Sin asignar')).toBeInTheDocument();
    expect(beto.getByText('Sin consentimiento')).toBeInTheDocument();
    expect(beto.getByText('Sin correo')).toBeInTheDocument();
    expect(await screen.findByText('2 contactos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo contacto' })).toBeInTheDocument();
  });

  it('quien ve todos los contactos filtra por responsable; el asesor no tiene ese filtro y la cuenta dice que son «asignados a ti»', async () => {
    mockApi(server(ME_ADMIN, ALL).routes);
    const first = renderApp('/contacts');
    const owner = await screen.findByLabelText('Responsable');
    await waitFor(() => expect(within(owner).getByRole('option', { name: 'Luis Navas' })).toBeInTheDocument());
    first.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    const api = mockApi(server(ME_ADVISOR, OWN, [ANA]).routes);
    renderApp('/contacts');
    expect(await screen.findByText(/1 contacto asignados a ti/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Responsable')).not.toBeInTheDocument();
    expect(api.count('GET /contacts/owners')).toBe(0); // sin permiso ni siquiera se consulta
  });

  it('buscar espera un momento y consulta al servidor con el texto; «Limpiar filtros» lo quita', async () => {
    const s = server(ME_ADMIN, ALL);
    const api = mockApi(s.routes);
    renderApp('/contacts');
    await screen.findByRole('button', { name: 'Abrir el contacto Beto Luna' });
    await userEvent.type(screen.getByLabelText('Buscar'), 'beto');
    await waitFor(() => expect(api.last('GET /contacts')?.query.get('q')).toBe('beto'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Abrir el contacto Ana Torres' })).not.toBeInTheDocument());
    expect(screen.getByText('1 contacto con estos filtros')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' });
    expect(api.last('GET /contacts')?.query.get('q')).toBeNull();
  });

  it('ordenar y filtrar por responsable viajan como parámetros; sin resultados se explica', async () => {
    const s = server(ME_ADMIN, ALL);
    const api = mockApi(s.routes);
    renderApp('/contacts');
    await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' });
    await userEvent.selectOptions(screen.getByLabelText('Orden'), 'Nombre (Z–A)');
    await waitFor(() => expect(api.last('GET /contacts')?.query.get('sort')).toBe('name'));
    expect(api.last('GET /contacts')?.query.get('order')).toBe('desc');
    await userEvent.selectOptions(screen.getByLabelText('Responsable'), 'Sin asignar');
    await waitFor(() => expect(api.last('GET /contacts')?.query.get('owner')).toBe('none'));
    await userEvent.type(screen.getByLabelText('Buscar'), 'zzz');
    expect(await screen.findByText('Ningún contacto coincide con los filtros.')).toBeInTheDocument();
  });

  it('con más de una página aparece «Cargar más» y pide la siguiente con el cursor', async () => {
    const page2 = [contact('c3', 'Carla Mena')];
    const s = server(ME_ADMIN, ALL, [ANA], {
      page: (call) => (call.query.get('cursor') === 'CUR2'
        ? { items: page2, next_cursor: null, total: null, access: ALL }
        : { items: [ANA], next_cursor: 'CUR2', total: 2, access: ALL }),
    });
    const api = mockApi(s.routes);
    renderApp('/contacts');
    await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' });
    expect(screen.queryByRole('button', { name: 'Abrir el contacto Carla Mena' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByRole('button', { name: 'Abrir el contacto Carla Mena' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir el contacto Ana Torres' })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === '/contacts').map((c) => c.query.get('cursor'))).toEqual([null, 'CUR2']);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
    expect(screen.getByText('2 contactos')).toBeInTheDocument(); // el total de la primera página se conserva
  });

  it('sin contactos: invita a crear el primero; si no puede crear, solo informa; un error de carga permite reintentar', async () => {
    const empty = server(ME_ADMIN, ALL, []);
    mockApi(empty.routes);
    const a = renderApp('/contacts');
    expect(await screen.findByText(/Crea el primero con «Nuevo contacto»/)).toBeInTheDocument();
    a.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    mockApi(server(ME_AGENCY_IN_CLIENT, READ, []).routes);
    const b = renderApp('/contacts');
    expect(await screen.findByText('Todavía no hay contactos.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo contacto' })).not.toBeInTheDocument();
    b.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    let fail = true;
    const flaky = server(ME_ADMIN, ALL);
    flaky.routes['GET /contacts'] = () => (fail ? err(500, 'INTERNAL') : { body: { items: [ANA], next_cursor: null, total: 1, access: ALL } });
    mockApi(flaky.routes);
    renderApp('/contacts');
    expect(await screen.findByRole('alert')).toHaveTextContent('Tuvimos un problema de nuestro lado');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' })).toBeInTheDocument();
  });
});

describe('Contactos · crear', () => {
  it('crea con teléfono nacional: se antepone el prefijo elegido, el principal es el primero y la lista se actualiza', async () => {
    const s = server(ME_ADMIN, ALL);
    mockApi(s.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await dialog());
    await userEvent.type(d.getByLabelText('Nombre'), '  Carla Mena ');
    await userEvent.type(d.getByLabelText('Correo'), 'Carla@Correo.TEST');
    await userEvent.type(d.getByLabelText('Teléfono 1 (principal)'), '098 421 7730');
    await userEvent.click(d.getByRole('button', { name: 'Agregar otro teléfono' }));
    await userEvent.type(d.getByLabelText('Teléfono 2'), '+34 612 345 678');
    await userEvent.selectOptions(d.getByLabelText('Responsable'), 'Luis Navas');
    await userEvent.selectOptions(d.getByLabelText('Consentimiento para escribirle'), 'Con consentimiento');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]).toEqual({ name: 'Carla Mena', email: 'carla@correo.test', phones: ['+593984217730', '+34612345678'], consent: 'granted', owner_id: 'u2' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Abrir el contacto Carla Mena' })).toBeInTheDocument();
  });

  it('el asesor no elige responsable (no se envía owner_id: el servidor lo asigna a quien crea)', async () => {
    const s = server(ME_ADVISOR, OWN, []);
    mockApi(s.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await dialog());
    expect(d.queryByLabelText('Responsable')).not.toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Nombre'), 'Cliente Nuevo');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]).toEqual({ name: 'Cliente Nuevo', email: null, phones: [], consent: 'unknown' });
  });

  it('valida en el navegador sin enviar: nombre vacío, correo mal escrito, teléfono corto o repetido', async () => {
    const s = server(ME_ADMIN, ALL);
    mockApi(s.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await dialog());
    await userEvent.type(d.getByLabelText('Correo'), 'no-es-correo');
    await userEvent.type(d.getByLabelText('Teléfono 1 (principal)'), '123');
    await userEvent.click(d.getByRole('button', { name: 'Agregar otro teléfono' }));
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Escribe el nombre')).toBeInTheDocument();
    expect(d.getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(d.getByText(/Número no válido: usa de 8 a 15 dígitos/)).toBeInTheDocument();

    await userEvent.clear(d.getByLabelText('Teléfono 1 (principal)'));
    await userEvent.type(d.getByLabelText('Teléfono 1 (principal)'), '0984217730');
    await userEvent.type(d.getByLabelText('Teléfono 2'), '+593984217730');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Este número está repetido')).toBeInTheDocument();
    expect(s.posts).toHaveLength(0);
  });

  it('un teléfono que ya es de otro contacto se marca en SU fila (409) y el diálogo sigue abierto con lo escrito', async () => {
    const s = server(ME_ADMIN, ALL, [ANA], {
      post: () => ({ status: 409, body: { error: { code: 'PHONE_TAKEN', message: 'x', request_id: 'r', details: [{ path: 'phones.1', code: 'duplicate', message: 'Ya existe un contacto con este teléfono' }] } } }),
    });
    mockApi(s.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await dialog());
    await userEvent.type(d.getByLabelText('Nombre'), 'Carla');
    await userEvent.type(d.getByLabelText('Teléfono 1 (principal)'), '0991112233');
    await userEvent.click(d.getByRole('button', { name: 'Agregar otro teléfono' }));
    await userEvent.type(d.getByLabelText('Teléfono 2'), '0984217730');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Ya existe un contacto con este teléfono')).toBeInTheDocument();
    expect(d.getByText('Uno de los teléfonos ya pertenece a otro contacto de tu empresa.')).toBeInTheDocument();
    expect(d.getByLabelText('Nombre')).toHaveValue('Carla');
    // el aviso queda junto al segundo teléfono, no al primero
    const row2 = d.getByLabelText('Teléfono 2').closest('div')!.parentElement!;
    expect(within(row2).getByText('Ya existe un contacto con este teléfono')).toBeInTheDocument();
  });

  it('un error del servidor se muestra y no cierra el diálogo; Cancelar y Escape lo cierran', async () => {
    const s = server(ME_ADMIN, ALL, [ANA], { post: () => err(500, 'INTERNAL') });
    mockApi(s.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await dialog());
    await userEvent.type(d.getByLabelText('Nombre'), 'Carla');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Tuvimos un problema de nuestro lado. Inténtalo en unos minutos.')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo contacto' }));
    await dialog();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Contactos · editar y borrar', () => {
  it('abre con los datos del contacto, guarda los cambios y la lista los refleja', async () => {
    const s = server(ME_ADMIN, ALL);
    mockApi(s.routes);
    renderApp('/contacts');
    await open('Beto Luna');
    const d = within(await dialog());
    expect(d.getByLabelText('Nombre')).toHaveValue('Beto Luna');
    expect(d.getByLabelText('Teléfono 1 (principal)')).toHaveValue('+593991112233');
    expect(d.getByLabelText('Consentimiento para escribirle')).toHaveValue('revoked');
    await userEvent.clear(d.getByLabelText('Nombre'));
    await userEvent.type(d.getByLabelText('Nombre'), 'Alberto Luna');
    await userEvent.type(d.getByLabelText('Correo'), 'beto@correo.test');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(s.patches[0]).toEqual({ id: 'c2', body: { name: 'Alberto Luna', email: 'beto@correo.test', phones: ['+593991112233'], consent: 'revoked', owner_id: null } });
    expect(await screen.findByRole('button', { name: 'Abrir el contacto Alberto Luna' })).toBeInTheDocument();
  });

  it('borrar pide confirmación; «No» la cancela y «Sí, borrar» borra y quita la fila', async () => {
    const s = server(ME_ADMIN, ALL);
    mockApi(s.routes);
    renderApp('/contacts');
    await open('Beto Luna');
    const d = within(await dialog());
    await userEvent.click(d.getByRole('button', { name: 'Borrar contacto' }));
    expect(d.getByText('¿Borrar este contacto?')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'No' }));
    expect(d.queryByText('¿Borrar este contacto?')).not.toBeInTheDocument();
    expect(s.deletes).toEqual([]);
    await userEvent.click(d.getByRole('button', { name: 'Borrar contacto' }));
    await userEvent.click(d.getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(s.deletes).toEqual(['c2']));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Abrir el contacto Beto Luna' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Abrir el contacto Ana Torres' })).toBeInTheDocument();
    expect(screen.queryByText('¿Borrar este contacto?')).not.toBeInTheDocument();
  });

  it('el asesor puede editar pero no ve «Borrar contacto»', async () => {
    mockApi(server(ME_ADVISOR, OWN, [ANA]).routes);
    renderApp('/contacts');
    await open('Ana Torres');
    const d = within(await dialog());
    expect(d.getByRole('button', { name: 'Guardar' })).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Borrar contacto' })).not.toBeInTheDocument();
    expect(d.queryByLabelText('Responsable')).not.toBeInTheDocument();
  });

  it('en solo lectura (agencia con nivel «lectura», o prueba vencida) se ve el contacto pero no se puede cambiar ni borrar', async () => {
    const s = server({ ...ME_AGENCY_IN_CLIENT, access_level: 'read', read_only: true }, READ);
    mockApi(s.routes);
    renderApp('/contacts');
    expect(await screen.findByText(/Solo lectura/)).toBeInTheDocument(); // banner de contexto
    expect(screen.queryByRole('button', { name: 'Nuevo contacto' })).not.toBeInTheDocument();
    await open('Ana Torres');
    const d = within(await dialog());
    expect(d.getByText(/modo solo lectura/)).toBeInTheDocument();
    expect(d.getByLabelText('Nombre')).toBeDisabled();
    expect(d.getByLabelText('Teléfono 1 (principal)')).toBeDisabled();
    expect(d.queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Borrar contacto' })).not.toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Agregar otro teléfono' })).not.toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(s.patches).toEqual([]);
  });

  it('si el contacto ya no existe (404 al guardar) se avisa sin cerrar el diálogo', async () => {
    const s = server(ME_ADMIN, ALL, [ANA, BETO], { patch: () => err(404, 'NOT_FOUND') });
    mockApi(s.routes);
    renderApp('/contacts');
    await open('Ana Torres');
    const d = within(await dialog());
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('No pudimos guardar los cambios.')).toBeInTheDocument();
  });
});
