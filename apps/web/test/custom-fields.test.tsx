import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRaw, toRaw } from '../src/features/custom-fields/fieldValues';
import type { Contact, ContactAccess, CustomField, CustomFieldType } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const fld = (key: string, name: string, type: CustomFieldType, over: Partial<CustomField> = {}): CustomField => ({
  id: `f-${key}`,
  entity: 'contact',
  name,
  key,
  type,
  options: null,
  required: false,
  show_in_form: true,
  position: 0,
  archived_at: null,
  created_at: '2026-10-10T15:00:00.000Z',
  ...over,
});
const slug = (n: string): string => n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

interface FieldsServer {
  routes: Record<string, Handler>;
  state: CustomField[];
  posts: unknown[];
  patches: Array<{ id: string; body: unknown }>;
  orders: unknown[];
  archives: Array<{ id: string; action: 'archive' | 'restore' }>;
}

/** Servidor de campos con estado (como el real). mockApi no admite rutas con parámetros: se enrutan una a una por id conocido. */
function fieldsServer(initial: CustomField[], manage = true, over: { post?: Handler; order?: Handler } = {}): FieldsServer {
  const s: FieldsServer = { routes: {}, state: initial.map((f, i) => ({ ...f, position: i })), posts: [], patches: [], orders: [], archives: [] };
  const view = (include: boolean): CustomField[] => s.state.filter((f) => include || f.archived_at === null).sort((a, b) => a.position - b.position);
  s.routes = {
    'GET /custom-fields': (call) => ({ body: { items: view(call.query.get('archived') === 'include'), access: { manage } } }),
    'POST /custom-fields': over.post ?? ((call) => {
      s.posts.push(call.body);
      const b = call.body as { name: string; type: CustomFieldType; options?: string[]; required: boolean; show_in_form: boolean };
      const made = fld(slug(b.name), b.name, b.type, { options: b.options ?? null, required: b.required, show_in_form: b.show_in_form, position: s.state.length });
      s.state.push(made);
      return { status: 201, body: made };
    }),
    'PUT /custom-fields/order': over.order ?? ((call) => {
      s.orders.push(call.body);
      const ids = (call.body as { ids: string[] }).ids;
      ids.forEach((id, i) => { s.state.find((f) => f.id === id)!.position = i; });
      return { body: { items: view(true) } };
    }),
  };
  for (const f of initial) {
    s.routes[`PATCH /custom-fields/${f.id}`] = (call) => {
      s.patches.push({ id: f.id, body: call.body });
      const cur = s.state.find((x) => x.id === f.id)!;
      const b = call.body as Partial<CustomField>;
      Object.assign(cur, b);
      if (b.show_in_form === false) cur.required = false;
      return { body: cur };
    };
    for (const action of ['archive', 'restore'] as const) {
      s.routes[`POST /custom-fields/${f.id}/${action}`] = () => {
        s.archives.push({ id: f.id, action });
        const cur = s.state.find((x) => x.id === f.id)!;
        cur.archived_at = action === 'archive' ? '2026-10-16T12:00:00.000Z' : null;
        return { body: cur };
      };
    }
  }
  return s;
}

const settings = (path = '/settings/fields') => renderApp(path);
const rowOf = async (name: string) => within(await screen.findByRole('list', { name: 'Campos' })).getByText(name).closest('li')!;

describe('Configuración › Campos personalizados', () => {
  it('quien administra ve «Configuración» en el menú y la lista con variable, tipo, opciones y los interruptores', async () => {
    const s = fieldsServer([
      fld('ciudad', 'Ciudad', 'text'),
      fld('interes', 'Interés', 'select', { options: ['Uñas', 'Barbería'], required: true }),
      fld('secreto', 'Secreto', 'text', { show_in_form: false }),
    ]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings('/contacts');
    expect(await screen.findByRole('link', { name: 'Configuración' })).toHaveAttribute('href', '/settings/fields');
    await userEvent.click(screen.getByRole('link', { name: 'Configuración' }));
    expect(await screen.findByRole('heading', { name: 'Configuración' })).toBeInTheDocument();
    const ciudad = within(await rowOf('Ciudad'));
    expect(ciudad.getByText('{{contact.ciudad}}')).toBeInTheDocument();
    expect(ciudad.getByText('Texto')).toBeInTheDocument();
    const interes = within(await rowOf('Interés'));
    expect(interes.getByText('Selección única')).toBeInTheDocument();
    expect(interes.getByText('Uñas · Barbería')).toBeInTheDocument();
    expect(interes.getByLabelText('Interés es obligatorio')).toBeChecked();
    expect(interes.getByLabelText('Mostrar Interés en el formulario')).toBeChecked();
    const secreto = within(await rowOf('Secreto'));
    expect(secreto.getByLabelText('Mostrar Secreto en el formulario')).not.toBeChecked();
    expect(secreto.getByLabelText('Secreto es obligatorio')).toBeDisabled(); // oculto ⇒ no puede ser obligatorio
    expect(screen.getByRole('button', { name: 'Nuevo campo' })).toBeInTheDocument();
  });

  it('quien no administra (asesor, agencia en lectura) no ve el menú ni las acciones, solo la lista y un aviso', async () => {
    const s = fieldsServer([fld('ciudad', 'Ciudad', 'text')], false);
    mockApi({ ...authed(ME_ADVISOR), ...s.routes, 'GET /contacts': () => ({ body: { items: [], next_cursor: null, total: 0, access: { view_all: false, write: true, delete: false, import: false, export: false } } }) });
    settings('/contacts');
    await screen.findByRole('link', { name: 'Contactos' });
    expect(screen.queryByRole('link', { name: 'Configuración' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
    resetWorld();
    mockApi({ ...authed(ME_ADVISOR), ...s.routes });
    settings('/settings/fields');
    const ciudad = within(await rowOf('Ciudad'));
    expect(screen.getByText('Solo el administrador de la empresa puede cambiar los campos.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo campo' })).not.toBeInTheDocument();
    expect(ciudad.queryByRole('button', { name: /Editar|Archivar|Subir|Bajar/ })).not.toBeInTheDocument();
    expect(ciudad.getByLabelText('Mostrar Ciudad en el formulario')).toBeDisabled();
  });

  it('crea un campo de selección: las opciones van una por línea y la variable la genera el servidor', async () => {
    const s = fieldsServer([]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    expect(await screen.findByText(/Crea el primero con «Nuevo campo»/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo campo' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo campo' }));
    expect(d.queryByLabelText('Opciones')).not.toBeInTheDocument(); // solo en los campos de selección
    await userEvent.type(d.getByLabelText('Nombre'), '  Interés ');
    await userEvent.selectOptions(d.getByLabelText('Tipo'), 'Selección única');
    await userEvent.type(d.getByLabelText('Opciones'), 'Uñas{Enter}Barbería, corte{Enter}{Enter}Repostería');
    await userEvent.click(d.getByLabelText('Obligatorio'));
    await userEvent.click(d.getByRole('button', { name: 'Crear campo' }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]).toEqual({ name: 'Interés', type: 'select', options: ['Uñas', 'Barbería, corte', 'Repostería'], show_in_form: true, required: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = within(await rowOf('Interés'));
    expect(row.getByText('{{contact.interes}}')).toBeInTheDocument();
    expect(row.getByText('Uñas · Barbería, corte · Repostería')).toBeInTheDocument();
  });

  it('valida en el navegador: nombre vacío, selección sin opciones o con opciones repetidas, y obligatorio solo si se muestra en el formulario', async () => {
    const s = fieldsServer([]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo campo' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo campo' }));
    await userEvent.click(d.getByRole('button', { name: 'Crear campo' }));
    expect(await d.findByText('Escribe el nombre del campo')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Nombre'), 'Interés');
    await userEvent.selectOptions(d.getByLabelText('Tipo'), 'Selección múltiple');
    await userEvent.click(d.getByRole('button', { name: 'Crear campo' }));
    expect(await d.findByText('Escribe al menos una opción (una por línea)')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Opciones'), 'Uno{Enter}uno');
    await userEvent.click(d.getByRole('button', { name: 'Crear campo' }));
    expect(await d.findByText('Hay opciones repetidas')).toBeInTheDocument();
    expect(s.posts).toHaveLength(0);

    await userEvent.click(d.getByLabelText('Obligatorio'));
    expect(d.getByLabelText('Obligatorio')).toBeChecked();
    await userEvent.click(d.getByLabelText('Mostrar en el formulario de contacto')); // se oculta ⇒ deja de ser obligatorio
    expect(d.getByLabelText('Obligatorio')).not.toBeChecked();
    expect(d.getByLabelText('Obligatorio')).toBeDisabled();
  });

  it('un error del servidor (nombre repetido, reservado, tope) se muestra y el diálogo sigue abierto con lo escrito', async () => {
    const s = fieldsServer([], true, { post: () => err(409, 'CUSTOM_FIELD_EXISTS', 'Ya existe un campo con ese nombre («Ciudad»)') });
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo campo' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo campo' }));
    await userEvent.type(d.getByLabelText('Nombre'), 'Ciudad');
    await userEvent.click(d.getByRole('button', { name: 'Crear campo' }));
    expect(await d.findByText('Ya existe un campo con ese nombre («Ciudad»)')).toBeInTheDocument();
    expect(d.getByLabelText('Nombre')).toHaveValue('Ciudad');
  });

  it('editar: el tipo y la variable se ven pero no cambian; se guardan nombre, opciones y visibilidad', async () => {
    const s = fieldsServer([fld('interes', 'Interés', 'select', { options: ['Uñas', 'Barbería'] })]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar Interés' }));
    const d = within(await screen.findByRole('dialog', { name: 'Editar campo' }));
    expect(d.queryByLabelText('Tipo')).not.toBeInTheDocument();
    expect(d.getByText(/Selección única/)).toBeInTheDocument();
    expect(d.getByText('{{contact.interes}}')).toBeInTheDocument();
    expect(d.getByLabelText('Opciones')).toHaveValue('Uñas\nBarbería');
    await userEvent.clear(d.getByLabelText('Nombre'));
    await userEvent.type(d.getByLabelText('Nombre'), 'Interés principal');
    await userEvent.type(d.getByLabelText('Opciones'), '{Enter}Cejas');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(s.patches[0]).toEqual({ id: 'f-interes', body: { name: 'Interés principal', options: ['Uñas', 'Barbería', 'Cejas'], show_in_form: true, required: false } });
    const row = within(await rowOf('Interés principal'));
    expect(row.getByText('{{contact.interes}}')).toBeInTheDocument(); // la variable no cambió
  });

  it('los interruptores guardan al instante: mostrar en el formulario y obligatorio', async () => {
    const s = fieldsServer([fld('ciudad', 'Ciudad', 'text')]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    const row = within(await rowOf('Ciudad'));
    await userEvent.click(row.getByLabelText('Ciudad es obligatorio'));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(s.patches[0]).toEqual({ id: 'f-ciudad', body: { required: true } });
    await waitFor(() => expect(within(screen.getByText('Ciudad').closest('li')!).getByLabelText('Ciudad es obligatorio')).toBeChecked());
    await userEvent.click(within(screen.getByText('Ciudad').closest('li')!).getByLabelText('Mostrar Ciudad en el formulario'));
    await waitFor(() => expect(s.patches).toHaveLength(2));
    expect(s.patches[1]).toEqual({ id: 'f-ciudad', body: { show_in_form: false } });
    await waitFor(() => expect(within(screen.getByText('Ciudad').closest('li')!).getByLabelText('Ciudad es obligatorio')).not.toBeChecked()); // ocultar lo deja de hacer obligatorio
  });

  it('ordena con subir y bajar: manda el orden completo de los campos activos y los extremos no se mueven', async () => {
    const s = fieldsServer([fld('a', 'Alfa', 'text'), fld('b', 'Beta', 'text'), fld('c', 'Gamma', 'text')]);
    const api = mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    await rowOf('Alfa');
    expect(screen.getByRole('button', { name: 'Subir Alfa' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bajar Gamma' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Bajar Alfa' }));
    await waitFor(() => expect(s.orders).toHaveLength(1));
    expect(s.orders[0]).toEqual({ ids: ['f-b', 'f-a', 'f-c'] });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Campos' })).getAllByRole('listitem').map((li) => li.querySelector('b')?.textContent?.trim())).toEqual(['Beta', 'Alfa', 'Gamma']));
    expect(api.count('PUT /custom-fields/order')).toBe(1);
  });

  it('si la lista cambió mientras tanto (409) se avisa para actualizar la pantalla', async () => {
    const s = fieldsServer([fld('a', 'Alfa', 'text'), fld('b', 'Beta', 'text')], true, { order: () => err(409, 'CUSTOM_FIELD_ORDER_STALE', 'La lista de campos cambió. Actualiza la pantalla e inténtalo de nuevo') });
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    settings();
    await userEvent.click(await screen.findByRole('button', { name: 'Bajar Alfa' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La lista de campos cambió');
  });

  it('archivar saca el campo de la lista (no se borra); en «Ver archivados» se puede restaurar', async () => {
    const s = fieldsServer([fld('ciudad', 'Ciudad', 'text'), fld('interes', 'Interés', 'text')]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes, 'GET /contacts': () => ({ body: { items: [], next_cursor: null, total: 0, access: { view_all: true, write: true, delete: true, import: true, export: true } } }) });
    settings();
    await rowOf('Ciudad');
    expect(screen.queryByLabelText(/Ver archivados/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Archivar Ciudad' }));
    await waitFor(() => expect(s.archives).toEqual([{ id: 'f-ciudad', action: 'archive' }]));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Campos' })).queryByText('Ciudad')).not.toBeInTheDocument());
    const toggle = await screen.findByLabelText('Ver archivados (1)');
    expect(screen.queryByRole('list', { name: 'Campos archivados' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    const archived = within(await screen.findByRole('list', { name: 'Campos archivados' }));
    expect(archived.getByText('Archivado')).toBeInTheDocument();
    expect(archived.queryByRole('button', { name: /Editar|Archivar/ })).not.toBeInTheDocument();
    await userEvent.click(archived.getByRole('button', { name: 'Restaurar Ciudad' }));
    await waitFor(() => expect(s.archives).toHaveLength(2));
    expect(s.archives[1]).toEqual({ id: 'f-ciudad', action: 'restore' });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Campos' })).getByText('Ciudad')).toBeInTheDocument());
  });
});

// ── El formulario de contacto con campos personalizados ──

const ALL: ContactAccess = { view_all: true, write: true, delete: true, import: true, export: true };
const READ: ContactAccess = { view_all: true, write: false, delete: false, import: false, export: false };
const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1', name: 'Ana Torres', email: null, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null,
  custom_fields: {}, tags: [], attribution: null, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});

const DEFS: CustomField[] = [
  fld('cedula', 'Cédula', 'text', { required: true }),
  fld('ciudad', 'Ciudad', 'text'),
  fld('presupuesto', 'Presupuesto', 'currency'),
  fld('nacimiento', 'Nacimiento', 'date'),
  fld('cuando', 'Cita', 'datetime'),
  fld('vip', 'Cliente VIP', 'boolean'),
  fld('interes', 'Interés', 'select', { options: ['Uñas', 'Barbería'] }),
  fld('horarios', 'Horarios', 'multiselect', { options: ['Mañana', 'Tarde'] }),
  fld('web', 'Sitio web', 'url'),
  fld('tel2', 'Otro teléfono', 'phone'),
  fld('notas', 'Notas', 'long_text'),
  fld('oculto', 'Campo oculto', 'text', { show_in_form: false }),
];

interface ContactsServer { routes: Record<string, Handler>; posts: Call[]; patches: Call[] }
function contactsServer(defs: CustomField[], contacts: Contact[], access: ContactAccess = ALL, over: { post?: Handler } = {}): ContactsServer {
  const s: ContactsServer = { routes: {}, posts: [], patches: [] };
  s.routes = {
    'GET /custom-fields': () => ({ body: { items: defs, access: { manage: access.write } } }),
    'GET /contacts': () => ({ body: { items: contacts, next_cursor: null, total: contacts.length, access } }),
    'GET /contacts/owners': () => ({ body: { items: [] } }),
    'POST /contacts': over.post ?? ((call) => { s.posts.push(call); return { status: 201, body: contact({ id: 'new1' }) }; }),
  };
  for (const c of contacts) s.routes[`PATCH /contacts/${c.id}`] = (call) => { s.patches.push(call); return { body: c }; };
  return s;
}
const customOf = (call: Call | undefined): unknown => (call?.body as { custom_fields?: unknown } | undefined)?.custom_fields;

describe('Formulario de contacto · campos adicionales', () => {
  it('dibuja cada campo según su tipo, marca los obligatorios y no muestra los ocultos', async () => {
    const s = contactsServer(DEFS, []);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    expect(await d.findByText('Campos adicionales')).toBeInTheDocument();
    expect(d.getByLabelText(/Cédula/)).toHaveAttribute('aria-required', 'true');
    expect(d.getByLabelText('Ciudad')).toHaveAttribute('type', 'text');
    expect(d.getByLabelText('Presupuesto')).toHaveAttribute('inputmode', 'decimal');
    expect(d.getByLabelText('Nacimiento')).toHaveAttribute('type', 'date');
    expect(d.getByLabelText('Cita')).toHaveAttribute('type', 'datetime-local');
    expect(within(d.getByLabelText('Cliente VIP')).getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'Sí', 'No']);
    expect(within(d.getByLabelText('Interés')).getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'Uñas', 'Barbería']);
    expect(d.getByLabelText('Mañana')).toHaveAttribute('type', 'checkbox');
    expect(d.getByLabelText('Sitio web')).toHaveAttribute('type', 'url');
    expect(d.getByLabelText('Otro teléfono')).toHaveAttribute('type', 'tel');
    expect(d.getByLabelText('Notas').tagName).toBe('TEXTAREA');
    expect(d.queryByLabelText('Campo oculto')).not.toBeInTheDocument();
  });

  it('sin campos configurados el formulario queda como antes (sin sección adicional)', async () => {
    mockApi({ ...authed(ME_ADMIN), ...contactsServer([], []).routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await d.findByLabelText('Nombre');
    expect(d.queryByText('Campos adicionales')).not.toBeInTheDocument();
  });

  it('un campo obligatorio vacío bloquea el alta con su aviso; al llenarlo se envían todos los valores en su forma de API', async () => {
    const s = contactsServer(DEFS, []);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(await d.findByLabelText('Nombre'), 'Carla Mena');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Este campo es obligatorio')).toBeInTheDocument();
    expect(s.posts).toHaveLength(0);

    await userEvent.type(d.getByLabelText(/Cédula/), '0912345678');
    await userEvent.type(d.getByLabelText('Presupuesto'), '1500,5');
    fireEvent.change(d.getByLabelText('Nacimiento'), { target: { value: '1990-05-17' } });
    fireEvent.change(d.getByLabelText('Cita'), { target: { value: '2026-10-20T10:00' } });
    await userEvent.selectOptions(d.getByLabelText('Cliente VIP'), 'Sí');
    await userEvent.selectOptions(d.getByLabelText('Interés'), 'Barbería');
    await userEvent.click(d.getByLabelText('Tarde'));
    await userEvent.type(d.getByLabelText('Sitio web'), 'https://ejemplo.test/carla');
    await userEvent.type(d.getByLabelText('Otro teléfono'), '098 421 7730');
    await userEvent.type(d.getByLabelText('Notas'), 'Prefiere por la tarde');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(customOf(s.posts[0])).toEqual({
      cedula: '0912345678', presupuesto: '1500.5', nacimiento: '1990-05-17', cuando: new Date('2026-10-20T10:00').toISOString(), vip: true, interes: 'Barbería',
      horarios: ['Tarde'], web: 'https://ejemplo.test/carla', tel2: '+593984217730', notas: 'Prefiere por la tarde',
    });
  });

  it('valida el formato de cada tipo en el navegador sin enviar nada', async () => {
    const s = contactsServer(DEFS, []);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(await d.findByLabelText('Nombre'), 'X');
    await userEvent.type(d.getByLabelText(/Cédula/), '1');
    await userEvent.type(d.getByLabelText('Presupuesto'), 'abc');
    await userEvent.type(d.getByLabelText('Sitio web'), 'ftp://x.test');
    await userEvent.type(d.getByLabelText('Otro teléfono'), '123');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Escribe un número (hasta 6 decimales)')).toBeInTheDocument();
    expect(d.getByText('Escribe una dirección que empiece con http:// o https://')).toBeInTheDocument();
    expect(d.getByText(/Número no válido: usa de 8 a 15 dígitos/)).toBeInTheDocument();
    expect(s.posts).toHaveLength(0);
  });

  it('un error del servidor sobre un campo se marca en ESE campo y el diálogo conserva lo escrito', async () => {
    const s = contactsServer(DEFS, [], ALL, {
      post: () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'custom_fields.ciudad', code: 'too_long', message: 'Usa como máximo 500 caracteres' }] } } }),
    });
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(await d.findByLabelText('Nombre'), 'Carla');
    await userEvent.type(d.getByLabelText(/Cédula/), '0912345678');
    await userEvent.type(d.getByLabelText('Ciudad'), 'Quito');
    await userEvent.click(d.getByRole('button', { name: 'Crear contacto' }));
    expect(await d.findByText('Usa como máximo 500 caracteres')).toBeInTheDocument();
    expect(d.getByLabelText('Ciudad')).toHaveValue('Quito');
    expect(d.getByLabelText('Nombre')).toHaveValue('Carla');
  });

  it('al editar muestra los valores guardados y envía SOLO los que cambian (null vacía); una opción que ya no existe se conserva a la vista', async () => {
    const c = contact({
      custom_fields: { cedula: '0912345678', ciudad: 'Quito', interes: 'Pintura', horarios: ['Mañana'], vip: false, presupuesto: 1500.5, cuando: '2026-10-20T15:00:00.000Z' },
    });
    const s = contactsServer(DEFS, [c]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    expect(await d.findByLabelText(/Cédula/)).toHaveValue('0912345678');
    expect(d.getByLabelText('Ciudad')).toHaveValue('Quito');
    expect(d.getByLabelText('Presupuesto')).toHaveValue('1500.5');
    expect(d.getByLabelText('Cliente VIP')).toHaveValue('false');
    expect(d.getByLabelText('Interés')).toHaveValue('Pintura');
    expect(within(d.getByLabelText('Interés')).getByRole('option', { name: 'Pintura (opción anterior)' })).toBeInTheDocument();
    expect(d.getByLabelText('Mañana')).toBeChecked();
    expect(d.getByLabelText('Tarde')).not.toBeChecked();

    await userEvent.clear(d.getByLabelText('Ciudad'));
    await userEvent.type(d.getByLabelText('Ciudad'), 'Lima');
    await userEvent.click(d.getByLabelText('Mañana')); // deja la lista vacía
    await userEvent.selectOptions(d.getByLabelText('Cliente VIP'), '—'); // vacía el Sí/No
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(customOf(s.patches[0])).toEqual({ ciudad: 'Lima', horarios: null, vip: null });
  });

  it('al editar sin tocar los campos no se envía nada de ellos; un contacto anterior sin el obligatorio se puede editar, pero no se puede vaciar uno que ya tiene valor', async () => {
    const viejo = contact({ id: 'c1', name: 'Antiguo' }); // sin cédula (el campo se hizo obligatorio después)
    const nuevo = contact({ id: 'c2', name: 'Nuevo', custom_fields: { cedula: '0912345678' } });
    const s = contactsServer(DEFS, [viejo, nuevo]);
    mockApi({ ...authed(ME_ADMIN), ...s.routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Antiguo' }));
    let d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    await userEvent.clear(await d.findByLabelText('Nombre'));
    await userEvent.type(d.getByLabelText('Nombre'), 'Antiguo editado');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(s.patches).toHaveLength(1));
    expect(customOf(s.patches[0])).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Abrir el contacto Nuevo' }));
    d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    await userEvent.clear(await d.findByLabelText(/Cédula/));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    expect(await d.findByText('Este campo es obligatorio')).toBeInTheDocument();
    expect(s.patches).toHaveLength(1);
  });

  it('en solo lectura los campos adicionales se ven pero no se pueden cambiar', async () => {
    const c = contact({ custom_fields: { cedula: '0912345678', interes: 'Uñas', horarios: ['Tarde'] } });
    mockApi({ ...authed(ME_ADMIN), ...contactsServer(DEFS, [c], READ).routes });
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    expect(await d.findByLabelText(/Cédula/)).toBeDisabled();
    expect(d.getByLabelText('Interés')).toBeDisabled();
    expect(d.getByLabelText('Tarde')).toBeDisabled();
    expect(d.getByLabelText('Tarde')).toBeChecked();
  });
});

describe('valores de los campos (utilidades)', () => {
  const f = (type: CustomFieldType, options: string[] | null = null) => fld('k', 'K', type, { options });
  const ok = (type: CustomFieldType, raw: string | string[], expected: unknown, prefix = '+593') => expect(parseRaw(f(type), raw, prefix)).toEqual({ ok: true, value: expected });
  const no = (type: CustomFieldType, raw: string | string[]) => expect(parseRaw(f(type), raw, '+593').ok).toBe(false);

  it('lo vacío es null y cada tipo se normaliza', () => {
    ok('text', '', null);
    ok('text', '   ', null);
    ok('multiselect', [], null);
    ok('text', '  hola ', 'hola');
    ok('number', '12,50', '12.50');
    ok('currency', '-3', '-3');
    ok('boolean', 'false', false);
    ok('boolean', 'true', true);
    ok('date', '2026-10-20', '2026-10-20');
    ok('email', 'Ana@Correo.TEST', 'ana@correo.test');
    ok('phone', '098 421 7730', '+593984217730');
    ok('phone', '+34 612 345 678', '+34612345678');
    ok('select', 'Uñas', 'Uñas');
    ok('multiselect', ['a', 'b'], ['a', 'b']);
    ok('datetime', '2026-10-20T10:00', new Date('2026-10-20T10:00').toISOString());
  });

  it('rechaza lo que el servidor rechazaría', () => {
    no('number', 'abc');
    no('number', '1.1234567');
    no('percent', '1e3');
    no('number', '1000000000');
    no('date', '20/10/2026');
    no('datetime', 'mañana');
    no('email', 'sin-arroba');
    no('phone', '123');
    no('url', 'ftp://x.test');
    no('url', 'no es url');
    no('text', 'x'.repeat(501));
    no('long_text', 'x'.repeat(5001));
  });

  it('del valor de la API al formulario y de vuelta no cambia el dato', () => {
    const iso = '2026-10-20T15:00:00.000Z';
    expect(toRaw(f('number'), 34)).toBe('34');
    expect(toRaw(f('boolean'), false)).toBe('false');
    expect(toRaw(f('boolean'), undefined)).toBe('');
    expect(toRaw(f('multiselect'), undefined)).toEqual([]);
    expect(toRaw(f('multiselect'), ['a'])).toEqual(['a']);
    expect(parseRaw(f('datetime'), toRaw(f('datetime'), iso), '+593')).toEqual({ ok: true, value: iso });
  });
});
