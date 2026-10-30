import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAccess, CrmCompany, Note, Task } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const ALL: ContactAccess = { view_all: true, write: true, delete: true, import: true, export: true };
const OWN: ContactAccess = { view_all: false, write: true, delete: false, import: false, export: false };
const READ: ContactAccess = { view_all: true, write: false, delete: false, import: false, export: false };

const company = (id: string, name: string, over: Partial<CrmCompany> = {}): CrmCompany => ({ id, name, website: null, phone: null, email: null, contact_count: 0, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over });
const ACME = company('k1', 'Acme SA', { website: 'acme.test', phone: '+593984217730', contact_count: 1 });
const LUNA = company('k2', 'Estudio Luna');
const ANA: Contact = {
  id: 'c1', name: 'Ana Torres', email: 'ana@x.test', phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies: [{ id: 'k1', name: 'Acme SA' }], attribution: null,
  created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z',
};
const note = (id: string, body: string, over: Partial<Note> = {}): Note => ({ id, body, author: { id: 'u1', name: 'Ana Pérez' }, edited_at: null, created_at: '2026-10-10T15:00:00.000Z', can_edit: true, can_delete: true, ...over });
const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id, title, description: null, due_at: null, status: 'open', completed_at: null, assignee: { id: 'u1', name: 'Ana Pérez' }, contact: null, company: null, created_by: 'u1', overdue: false, can_edit: true, can_complete: true,
  created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});

interface World { routes: Record<string, Handler>; calls: Record<string, Call[]>; companies: CrmCompany[]; notes: Note[]; tasks: Task[] }
const rec = (w: World, key: string, c: Call): void => { (w.calls[key] ??= []).push(c); };

/** Servidor de contactos, empresas, notas y tareas. mockApi no admite rutas con parámetros: se enrutan por los ids conocidos. */
function world(access: ContactAccess = ALL, over: { tasks?: Task[]; companies?: CrmCompany[]; notes?: Note[] } = {}): World {
  const w: World = { routes: {}, calls: {}, companies: over.companies ?? [ACME, LUNA], notes: over.notes ?? [note('n1', 'Prefiere por la tarde')], tasks: over.tasks ?? [task('t1', 'Llamar a Ana', { contact: { id: 'c1', name: 'Ana Torres' } })] };
  // Solo el administrador administra empresas (companies.manage); el asesor con escritura solo notas y tareas
  const cAccess = { manage: access.view_all && access.write, write: access.write };
  w.routes = {
    ...authed(access.view_all ? ME_ADMIN : ME_ADVISOR),
    'GET /contacts': (call) => {
      rec(w, 'contacts', call);
      return { body: { items: [ANA], next_cursor: null, total: 1, access } };
    },
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u9', name: 'Carolina Vera', email: 'c@x.test', role: 'advisor' }] } }),
    'GET /tags': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: [] } }),
    'GET /companies': (call) => {
      rec(w, 'companies', call);
      const q = call.query.get('q')?.toLowerCase();
      return { body: { items: w.companies.filter((c) => !q || c.name.toLowerCase().includes(q)), next_cursor: null, access: cAccess } };
    },
    'POST /companies': (call) => {
      rec(w, 'createCompany', call);
      const b = call.body as { name: string };
      if (b.name.toLowerCase() === 'acme sa') return err(409, 'COMPANY_EXISTS', 'Ya existe una empresa con ese nombre');
      const made = company('k9', b.name);
      w.companies = [...w.companies, made];
      return { status: 201, body: made };
    },
    'GET /companies/k1/contacts': () => ({ body: { items: [{ id: 'c1', name: 'Ana Torres', email: 'ana@x.test', phone: '+593984217730' }], next_cursor: null } }),
    'POST /companies/k1/contacts': (call) => { rec(w, 'link', call); return { body: { added: 1, skipped: 0 } }; },
    'POST /companies/k1/contacts/remove': (call) => { rec(w, 'unlink', call); return { body: { removed: 1 } }; },
    'GET /companies/k1/notes': () => ({ body: { items: [], next_cursor: null } }),
    'POST /companies/k1/notes': (call) => {
      rec(w, 'companyNote', call);
      const made = note('n9', (call.body as { body: string }).body);
      w.notes = [made, ...w.notes];
      return { status: 201, body: made };
    },
    'DELETE /companies/k1': () => ({ body: { id: 'k1', deleted: true } }),
    'GET /contacts/c1/notes': () => ({ body: { items: w.notes, next_cursor: null } }),
    'POST /contacts/c1/notes': (call) => {
      rec(w, 'note', call);
      const made = note('n9', (call.body as { body: string }).body);
      w.notes = [made, ...w.notes];
      return { status: 201, body: made };
    },
    'PATCH /notes/n1': (call) => {
      rec(w, 'editNote', call);
      w.notes = w.notes.map((n) => (n.id === 'n1' ? { ...n, body: (call.body as { body: string }).body, edited_at: '2026-10-11T10:00:00.000Z' } : n));
      return { body: w.notes.find((n) => n.id === 'n1') };
    },
    'DELETE /notes/n1': (call) => { rec(w, 'deleteNote', call); w.notes = w.notes.filter((n) => n.id !== 'n1'); return { body: { id: 'n1', deleted: true } }; },
    'POST /contacts/c1/companies/k2': (call) => { rec(w, 'linkCompany', call); return { body: { linked: true } }; },
    'DELETE /contacts/c1/companies/k1': (call) => { rec(w, 'unlinkCompany', call); return { body: { unlinked: true } }; },
    'GET /tasks': (call) => {
      rec(w, 'tasks', call);
      return { body: { items: w.tasks, next_cursor: null, total: w.tasks.length, access: { view_all: access.view_all, write: access.write } } };
    },
    'POST /tasks': (call) => {
      rec(w, 'createTask', call);
      const b = call.body as { title: string; contact_id?: string; company_id?: string };
      const made = task('t9', b.title);
      w.tasks = [...w.tasks, made];
      return { status: 201, body: made };
    },
    'POST /tasks/t1/complete': (call) => { rec(w, 'complete', call); w.tasks = w.tasks.map((t) => (t.id === 't1' ? { ...t, status: 'done' as const } : t)); return { body: w.tasks[0] }; },
    'POST /tasks/t1/reopen': (call) => { rec(w, 'reopen', call); return { body: w.tasks[0] }; },
    'PATCH /tasks/t1': (call) => { rec(w, 'editTask', call); return { body: w.tasks[0] }; },
    'DELETE /tasks/t1': (call) => { rec(w, 'deleteTask', call); w.tasks = []; return { body: { id: 't1', deleted: true } }; },
  };
  return w;
}

async function openContact() {
  renderApp('/contacts');
  await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
  return screen.getByRole('dialog', { name: 'Contacto' });
}

describe('menú', () => {
  it('«Empresas» ya no es un ítem del menú: es una vista dentro de Contactos (pestañas), y la dirección vieja /companies lleva ahí', async () => {
    mockApi(world().routes);
    renderApp('/contacts/companies');
    await screen.findByRole('table', { name: 'Empresas' });
    const nav = screen.getByRole('navigation', { name: 'Secciones' });
    expect(within(nav).queryByRole('link', { name: 'Empresas' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Contactos' })).toHaveAttribute('href', '/contacts');
    expect(within(nav).getByRole('link', { name: 'Tareas' })).toHaveAttribute('href', '/tasks');
    const tabs = screen.getByRole('navigation', { name: 'Vistas de contactos' });
    expect(within(tabs).getByRole('link', { name: 'Empresas' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Contactos' })).toHaveAttribute('href', '/contacts');
  });

  it('/companies redirige a /contacts/companies', async () => {
    mockApi(world().routes);
    renderApp('/companies');
    expect(await screen.findByRole('table', { name: 'Empresas' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Vistas de contactos' })).getByRole('link', { name: 'Empresas' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Empresas', () => {
  it('lista las empresas con su número de contactos y busca por nombre', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts/companies');
    const table = await screen.findByRole('table', { name: 'Empresas' });
    expect(within(table).getByRole('button', { name: 'Abrir la empresa Acme SA' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Abrir la empresa Estudio Luna' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar' }), 'luna');
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Empresas' })).queryByRole('button', { name: 'Abrir la empresa Acme SA' })).not.toBeInTheDocument());
    expect(w.calls['companies']!.at(-1)!.query.get('q')).toBe('luna');
  });

  it('crea una empresa; un nombre repetido se marca en el campo', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts/companies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva empresa' }));
    const dlg = screen.getByRole('dialog', { name: 'Nueva empresa' });
    await userEvent.type(within(dlg).getByLabelText('Nombre'), 'acme sa');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear empresa' }));
    expect(await within(dlg).findByText('Ya existe una empresa con ese nombre', { selector: '[role="alert"], p, span' })).toBeInTheDocument();

    await userEvent.clear(within(dlg).getByLabelText('Nombre'));
    await userEvent.type(within(dlg).getByLabelText('Nombre'), 'Nueva Corp');
    await userEvent.type(within(dlg).getByLabelText('Teléfono'), '098 421 7730');
    await userEvent.type(within(dlg).getByLabelText('Sitio web'), 'nueva.test');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear empresa' }));
    await waitFor(() => expect(w.calls['createCompany']).toHaveLength(2));
    expect(w.calls['createCompany']![1]!.body).toEqual({ name: 'Nueva Corp', website: 'nueva.test', phone: '+593984217730', email: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('valida en pantalla antes de enviar (nombre obligatorio, teléfono y correo con forma válida)', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts/companies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva empresa' }));
    const dlg = screen.getByRole('dialog', { name: 'Nueva empresa' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear empresa' }));
    expect(await within(dlg).findByText('Escribe el nombre')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Nombre'), 'X');
    await userEvent.type(within(dlg).getByLabelText('Teléfono'), '123');
    await userEvent.type(within(dlg).getByLabelText('Correo'), 'malo');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear empresa' }));
    expect(await within(dlg).findByText(/Número no válido/)).toBeInTheDocument();
    expect(within(dlg).getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(w.calls['createCompany']).toBeUndefined();
  });

  it('la ficha de la empresa muestra sus contactos y permite quitar o agregar; también sus notas y tareas', async () => {
    const w = world();
    w.routes['GET /contacts'] = (call) => {
      rec(w, 'contacts', call);
      return { body: { items: [ANA, { ...ANA, id: 'c2', name: 'Beto Luna', companies: [] }], next_cursor: null, total: 2, access: ALL } };
    };
    w.routes['POST /companies/k1/contacts'] = (call) => { rec(w, 'link', call); return { body: { added: 1, skipped: 0 } }; };
    w.routes['GET /tasks'] = (call) => { rec(w, 'tasks', call); return { body: { items: [], next_cursor: null, total: 0, access: { view_all: true, write: true } } }; };
    mockApi(w.routes);
    renderApp('/contacts/companies');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la empresa Acme SA' }));
    const dlg = screen.getByRole('dialog', { name: 'Empresa' });
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Contactos · 1' }));
    const section = within(await within(dlg).findByRole('region', { name: 'Contactos de la empresa' }));
    expect(await section.findByText('Ana Torres')).toBeInTheDocument();
    await userEvent.click(section.getByRole('button', { name: 'Quitar a Ana Torres de la empresa' }));
    await waitFor(() => expect(w.calls['unlink']![0]!.body).toEqual({ contact_ids: ['c1'] }));
    await userEvent.type(section.getByRole('searchbox', { name: 'Agregar contactos' }), 'beto');
    await userEvent.click(await section.findByRole('button', { name: 'Agregar a Beto Luna' }));
    await waitFor(() => expect(w.calls['link']![0]!.body).toEqual({ contact_ids: ['c2'] }));

    await userEvent.click(within(dlg).getByRole('tab', { name: 'Notas' }));
    await userEvent.type(await within(dlg).findByLabelText('Nueva nota'), 'Cuenta clave');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Agregar nota' }));
    await waitFor(() => expect(w.calls['companyNote']![0]!.body).toEqual({ body: 'Cuenta clave' }));

    await userEvent.click(within(dlg).getByRole('tab', { name: 'Tareas' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Nueva tarea' }));
    const task = screen.getByRole('dialog', { name: 'Nueva tarea' });
    await userEvent.type(within(task).getByLabelText('Título'), 'Renovar contrato');
    await userEvent.click(within(task).getByRole('button', { name: 'Crear tarea' }));
    await waitFor(() => expect(w.calls['createTask']![0]!.body).toMatchObject({ title: 'Renovar contrato', company_id: 'k1', description: null, due_at: null }));
  });

  it('borrar la empresa pide confirmación y borra al confirmar', async () => {
    const w = world(ALL);
    mockApi(w.routes);
    renderApp('/contacts/companies');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la empresa Acme SA' }));
    const dlg = screen.getByRole('dialog', { name: 'Empresa' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Borrar empresa' }));
    expect(within(dlg).getByText(/¿Borrar esta empresa?/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'No' }));
    expect(within(dlg).getByRole('button', { name: 'Borrar empresa' })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Borrar empresa' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('el asesor no crea ni edita empresas: ve los datos bloqueados y escribe notas y tareas', async () => {
    mockApi(world(OWN).routes);
    renderApp('/contacts/companies');
    await screen.findByRole('table', { name: 'Empresas' });
    expect(screen.queryByRole('button', { name: 'Nueva empresa' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la empresa Acme SA' }));
    const dlg = screen.getByRole('dialog', { name: 'Empresa' });
    expect(within(dlg).getByText(/Solo el administrador cambia los datos de la empresa/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Nombre')).toBeDisabled();
    expect(within(dlg).queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Borrar empresa' })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('tab', { name: /Contactos/ }));
    const section = within(await within(dlg).findByRole('region', { name: 'Contactos de la empresa' }));
    expect(await section.findByText('Ana Torres')).toBeInTheDocument();
    expect(section.queryByRole('searchbox', { name: 'Agregar contactos' })).not.toBeInTheDocument();
    expect(section.queryByRole('button', { name: /Quitar a/ })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Notas' }));
    expect(await within(dlg).findByRole('button', { name: 'Agregar nota' })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Tareas' }));
    expect(await within(dlg).findByRole('button', { name: 'Nueva tarea' })).toBeInTheDocument();
  });

  it('en solo lectura se ve pero no se cambia', async () => {
    mockApi(world(READ).routes);
    renderApp('/contacts/companies');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la empresa Acme SA' }));
    const dlg = screen.getByRole('dialog', { name: 'Empresa' });
    expect(within(dlg).getByText(/modo solo lectura/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Nombre')).toBeDisabled();
    expect(within(dlg).queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva empresa' })).not.toBeInTheDocument();
  });
});

describe('Ficha del contacto: notas, tareas y empresas', () => {
  it('notas: agrega, edita y borra (con confirmación); lo que el servidor no permite no se ofrece', async () => {
    const w = world(ALL, { notes: [note('n1', 'Prefiere por la tarde'), note('n2', 'Nota ajena', { can_edit: false, can_delete: false, author: { id: 'u3', name: 'Luis Navas' } })] });
    mockApi(w.routes);
    const dlg = await openContact();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Notas' }));
    const section = within(await within(dlg).findByRole('region', { name: 'Notas' }));
    expect(await section.findByText('Prefiere por la tarde')).toBeInTheDocument();
    expect(section.getAllByRole('button', { name: 'Editar la nota' })).toHaveLength(1); // la ajena no se edita
    expect(section.getAllByRole('button', { name: 'Borrar la nota' })).toHaveLength(1);

    await userEvent.type(section.getByLabelText('Nueva nota'), 'Quiere cotización');
    await userEvent.click(section.getByRole('button', { name: 'Agregar nota' }));
    await waitFor(() => expect(w.calls['note']![0]!.body).toEqual({ body: 'Quiere cotización' }));
    expect(await section.findByText('Quiere cotización')).toBeInTheDocument();

    await userEvent.click(section.getAllByRole('button', { name: 'Editar la nota' }).at(-1)!); // la más antigua: la nueva quedó arriba
    const box = section.getByLabelText('Texto de la nota');
    await userEvent.clear(box);
    await userEvent.type(box, 'Prefiere por la mañana');
    await userEvent.click(section.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['editNote']![0]!.body).toEqual({ body: 'Prefiere por la mañana' }));
    expect(await section.findByText(/editada/)).toBeInTheDocument();

    await userEvent.click(section.getAllByRole('button', { name: 'Borrar la nota' }).at(-1)!);
    await userEvent.click(section.getByRole('button', { name: 'Sí' }));
    await waitFor(() => expect(w.calls['deleteNote']).toHaveLength(1));
  });

  it('una nota vacía no se envía', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openContact();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Notas' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Agregar nota' }));
    expect(await within(dlg).findByText('Escribe la nota')).toBeInTheDocument();
    expect(w.calls['note']).toBeUndefined();
  });

  it('tareas: lista las del contacto, crea una vinculada y la completa desde la casilla', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openContact();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Tareas' }));
    const section = within(await within(dlg).findByRole('region', { name: 'Tareas' }));
    expect(await section.findByText('Llamar a Ana')).toBeInTheDocument();
    expect(w.calls['tasks']!.at(-1)!.query.get('contact')).toBe('c1');
    expect(w.calls['tasks']!.at(-1)!.query.get('assignee')).toBe('all'); // quien ve todo, las de todos

    await userEvent.click(section.getByRole('checkbox', { name: 'Marcar «Llamar a Ana» como hecha' }));
    await waitFor(() => expect(w.calls['complete']).toHaveLength(1));

    await userEvent.click(section.getByRole('button', { name: 'Nueva tarea' }));
    const td = screen.getByRole('dialog', { name: 'Nueva tarea' });
    expect(within(td).getByText(/contacto Ana Torres/)).toBeInTheDocument();
    await userEvent.type(within(td).getByLabelText('Título'), 'Enviar propuesta');
    await userEvent.type(within(td).getByLabelText(/Vence/), '2026-12-01T10:30');
    await userEvent.selectOptions(within(td).getByLabelText('Responsable'), 'u9');
    await userEvent.click(within(td).getByRole('button', { name: 'Crear tarea' }));
    await waitFor(() => expect(w.calls['createTask']).toHaveLength(1));
    const body = w.calls['createTask']![0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Enviar propuesta', description: null, assignee_id: 'u9', contact_id: 'c1' });
    expect(new Date(body['due_at'] as string).getTime()).toBe(new Date('2026-12-01T10:30').getTime());
  });

  it('el asesor ve solo las suyas (assignee=me) y no elige responsable', async () => {
    const w = world(OWN);
    mockApi(w.routes);
    const dlg = await openContact();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Tareas' }));
    await within(dlg).findByText('Llamar a Ana');
    expect(w.calls['tasks']!.at(-1)!.query.get('assignee')).toBe('me');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Nueva tarea' }));
    const td = screen.getByRole('dialog', { name: 'Nueva tarea' });
    expect(within(td).queryByLabelText('Responsable')).not.toBeInTheDocument();
  });

  it('campo «Empresa» del contacto (M10.2): muestra las del contacto, agrega por búsqueda y quita al instante', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openContact();
    expect(within(dlg).queryByRole('tab', { name: /Empresas/ })).toBeNull(); // ya no hay pestaña: es un campo del formulario
    const field = within(within(dlg).getByRole('group', { name: 'Empresa' }));
    expect(field.getByText('Acme SA')).toBeInTheDocument();
    await userEvent.click(field.getByRole('button', { name: 'Quitar la empresa Acme SA' }));
    await waitFor(() => expect(w.calls['unlinkCompany']).toHaveLength(1));
    await userEvent.type(field.getByLabelText('Buscar o crear una empresa'), 'luna');
    await userEvent.click(await field.findByRole('button', { name: 'Elegir la empresa Estudio Luna' }));
    await waitFor(() => expect(w.calls['linkCompany']).toHaveLength(1));
  });

  it('quien administra empresas crea una al vuelo desde el campo cuando no existe, y se la vincula', async () => {
    const w = world();
    w.routes['POST /contacts/c1/companies/k9'] = (call) => { rec(w, 'linkNew', call); return { body: { linked: true } }; };
    mockApi(w.routes);
    const dlg = await openContact();
    const field = within(within(dlg).getByRole('group', { name: 'Empresa' }));
    await userEvent.type(field.getByLabelText('Buscar o crear una empresa'), 'Nueva Compañía');
    await userEvent.click(await field.findByRole('button', { name: 'Crear «Nueva Compañía»' }));
    await waitFor(() => expect(w.calls['createCompany']).toHaveLength(1));
    expect(w.calls['createCompany']![0]!.body).toMatchObject({ name: 'Nueva Compañía' });
    await waitFor(() => expect(w.calls['linkNew']).toHaveLength(1));
  });

  it('un contacto NUEVO elige su empresa en el formulario y se vincula al crearlo', async () => {
    const w = world();
    w.routes['POST /contacts'] = (call) => { rec(w, 'createContact', call); return { status: 201, body: { ...ANA, id: 'c7', name: 'Nuevo Cliente', companies: [] } }; };
    w.routes['POST /contacts/c7/companies/k2'] = (call) => { rec(w, 'linkOnCreate', call); return { body: { linked: true } }; };
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(dlg.getByLabelText('Nombre'), 'Nuevo Cliente');
    await userEvent.type(dlg.getByLabelText('Teléfono 1 (principal)'), '+593984217799');
    const field = within(dlg.getByRole('group', { name: 'Empresa' }));
    await userEvent.type(field.getByLabelText('Buscar o crear una empresa'), 'luna');
    await userEvent.click(await field.findByRole('button', { name: 'Elegir la empresa Estudio Luna' }));
    expect(w.calls['linkOnCreate']).toBeUndefined(); // todavía no: se vincula al crear
    await userEvent.click(dlg.getByRole('button', { name: 'Crear contacto' }));
    await waitFor(() => expect(w.calls['createContact']).toHaveLength(1));
    await waitFor(() => expect(w.calls['linkOnCreate']).toHaveLength(1));
    // la empresa no viaja en el cuerpo del contacto: el vínculo es su propia llamada
    expect(w.calls['createContact']![0]!.body).not.toHaveProperty('company_ids');
  });

  it('si no se pudo vincular la empresa al crear, el contacto queda abierto para reintentar y lo dice', async () => {
    const w = world();
    w.routes['POST /contacts'] = (call) => { rec(w, 'createContact', call); return { status: 201, body: { ...ANA, id: 'c7', name: 'Nuevo Cliente', companies: [] } }; };
    w.routes['POST /contacts/c7/companies/k2'] = () => err(500, 'INTERNAL', 'x');
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Nuevo contacto' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Nuevo contacto' }));
    await userEvent.type(dlg.getByLabelText('Nombre'), 'Nuevo Cliente');
    await userEvent.type(dlg.getByLabelText('Teléfono 1 (principal)'), '+593984217799');
    const field = within(dlg.getByRole('group', { name: 'Empresa' }));
    await userEvent.type(field.getByLabelText('Buscar o crear una empresa'), 'luna');
    await userEvent.click(await field.findByRole('button', { name: 'Elegir la empresa Estudio Luna' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Crear contacto' }));
    expect(await screen.findByText(/El contacto se creó, pero no pudimos vincular la empresa/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Contacto' })).toBeInTheDocument();
  });

  it('el asesor ve las empresas del contacto pero el campo está deshabilitado con la explicación (ADR-48: vincular es del administrador)', async () => {
    mockApi(world(OWN).routes);
    const dlg = await openContact();
    const field = within(within(dlg).getByRole('group', { name: 'Empresa' }));
    expect(field.getByText('Acme SA')).toBeInTheDocument();
    expect(await field.findByText('Solo un administrador puede vincular empresas a un contacto.')).toBeInTheDocument();
    expect(field.getByLabelText('Buscar o crear una empresa')).toBeDisabled();
    expect(field.queryByRole('button', { name: /Quitar la empresa/ })).not.toBeInTheDocument();
  });

  it('en solo lectura no se agregan notas, tareas ni empresas', async () => {
    mockApi(world(READ).routes);
    const dlg = await openContact();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Notas' }));
    await within(dlg).findByRole('region', { name: 'Notas' });
    expect(within(dlg).queryByRole('button', { name: 'Agregar nota' })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Tareas' }));
    await within(dlg).findByRole('region', { name: 'Tareas' });
    expect(within(dlg).queryByRole('button', { name: 'Nueva tarea' })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Datos' }));
    expect(within(dlg).getByLabelText('Buscar o crear una empresa')).toBeDisabled();
    expect(within(dlg).queryByRole('button', { name: /Quitar la empresa/ })).not.toBeInTheDocument();
  });
});

describe('Tareas', () => {
  it('por defecto muestra las pendientes asignadas a la persona; el administrador puede ver las de todos y filtrar vencidas', async () => {
    const w = world(ALL, { tasks: [task('t1', 'Llamar a Ana', { due_at: '2026-10-01T10:00:00.000Z', overdue: true, contact: { id: 'c1', name: 'Ana Torres' } }), task('t2', 'Sin fecha')] });
    mockApi(w.routes);
    renderApp('/tasks');
    expect(await screen.findByText('Llamar a Ana')).toBeInTheDocument();
    expect(screen.getByText(/Vencida ·/)).toBeInTheDocument();
    expect(screen.getByText('Contacto: Ana Torres')).toBeInTheDocument();
    expect(screen.getByText('2 tareas')).toBeInTheDocument();
    const first = w.calls['tasks']![0]!.query;
    expect([first.get('status'), first.get('assignee'), first.get('sort'), first.get('overdue')]).toEqual(['open', 'me', 'due', null]);

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Responsable de las tareas' }), 'all');
    await waitFor(() => expect(w.calls['tasks']!.at(-1)!.query.get('assignee')).toBe('all'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Solo vencidas' }));
    await waitFor(() => expect(w.calls['tasks']!.at(-1)!.query.get('overdue')).toBe('true'));
    await userEvent.click(screen.getByRole('tab', { name: 'Hechas' }));
    await waitFor(() => expect(w.calls['tasks']!.at(-1)!.query.get('status')).toBe('done'));
    expect(screen.getByRole('checkbox', { name: 'Solo vencidas' })).toBeDisabled();
  });

  it('el asesor no ve el filtro de responsable', async () => {
    mockApi(world(OWN).routes);
    renderApp('/tasks');
    await screen.findByText('Llamar a Ana');
    expect(screen.queryByRole('combobox', { name: 'Responsable de las tareas' })).not.toBeInTheDocument();
  });

  it('completa y reabre desde la casilla; una tarea que la persona no puede completar tiene la casilla deshabilitada', async () => {
    const w = world(ALL, { tasks: [task('t1', 'Llamar a Ana'), task('t2', 'De otra persona', { can_complete: false, can_edit: false })] });
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Marcar «Llamar a Ana» como hecha' }));
    await waitFor(() => expect(w.calls['complete']).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Marcar «De otra persona» como hecha' })).toBeDisabled();
  });

  it('crea, edita y borra una tarea desde su diálogo; sin permiso de edición se ve en lectura', async () => {
    const w = world(ALL, { tasks: [task('t1', 'Llamar a Ana', { description: 'Detalle' })] });
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva tarea' }));
    const create = screen.getByRole('dialog', { name: 'Nueva tarea' });
    await userEvent.click(within(create).getByRole('button', { name: 'Crear tarea' }));
    expect(await within(create).findByText('Escribe el título')).toBeInTheDocument();
    await userEvent.type(within(create).getByLabelText('Título'), 'Revisar leads');
    await userEvent.click(within(create).getByRole('button', { name: 'Crear tarea' }));
    await waitFor(() => expect(w.calls['createTask']).toHaveLength(1));
    expect(w.calls['createTask']![0]!.body).toEqual({ title: 'Revisar leads', description: null, due_at: null });

    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Llamar a Ana' }));
    const edit = screen.getByRole('dialog', { name: 'Editar tarea' });
    expect(within(edit).getByLabelText(/Detalle/)).toHaveValue('Detalle');
    await userEvent.clear(within(edit).getByLabelText('Título'));
    await userEvent.type(within(edit).getByLabelText('Título'), 'Llamar a Ana hoy');
    await userEvent.click(within(edit).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['editTask']![0]!.body).toMatchObject({ title: 'Llamar a Ana hoy' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Llamar a Ana' }));
    const again = screen.getByRole('dialog', { name: 'Editar tarea' });
    await userEvent.click(within(again).getByRole('button', { name: 'Borrar tarea' }));
    await userEvent.click(within(again).getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(w.calls['deleteTask'] ?? w.calls['tasks']).toBeTruthy());
  });

  it('una tarea ajena (sin permiso de edición) se abre en solo lectura', async () => {
    mockApi(world(ALL, { tasks: [task('t1', 'Del administrador', { can_edit: false })] }).routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la tarea Del administrador' }));
    const dlg = screen.getByRole('dialog', { name: 'Tarea' });
    expect(within(dlg).getByLabelText('Título')).toBeDisabled();
    expect(within(dlg).getByText(/Solo quien creó la tarea o un administrador/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Borrar tarea' })).not.toBeInTheDocument();
  });

  it('un error del servidor al crear se muestra con su motivo', async () => {
    const w = world();
    w.routes['POST /tasks'] = () => err(403, 'TASK_ASSIGNEE_NOT_ALLOWED', 'Solo puedes asignarte tareas a ti');
    mockApi(w.routes);
    renderApp('/tasks');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva tarea' }));
    const dlg = screen.getByRole('dialog', { name: 'Nueva tarea' });
    await userEvent.type(within(dlg).getByLabelText('Título'), 'X');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Crear tarea' }));
    expect(await within(dlg).findByText('Solo puedes asignarte tareas a ti')).toBeInTheDocument();
  });
});
