import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAccess, ContactImport, ContactTag, CustomField, ImportPreview } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const ALL: ContactAccess = { view_all: true, write: true, delete: true, import: true, export: true };
const ADVISOR: ContactAccess = { view_all: false, write: true, delete: false, import: false, export: false };
const tag = (id: string, name: string): ContactTag => ({ id, name, color: '#6a44f2', system_key: null, is_system: false });
const LEAD: ContactTag = { id: 't-lead', name: 'Lead', color: '#2563eb', system_key: 'lead', is_system: true };
const VIP = tag('t-vip', 'VIP');
const CIUDAD: CustomField = { id: 'f-ciudad', entity: 'contact', name: 'Ciudad', key: 'ciudad', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: '2026-10-10T15:00:00.000Z' };
const ANA: Contact = { id: 'c1', name: 'Ana Torres', email: 'a@x.test', phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies: [], attribution: null, created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z' };

const imp = (over: Partial<ContactImport> = {}): ContactImport => ({
  id: 'imp1', file_name: 'clientes.csv', status: 'staging', total_rows: 3, staged_rows: 0, headers: ['Nombre', 'Celular', 'Ciudad', 'Notas'], mapping: ['name', 'phone', 'cf:ciudad', 'ignore'],
  options: { duplicates: 'skip', country_prefix: '+593', consent: 'unknown', tag_id: null, owner_id: null },
  counts: { created: 0, updated: 0, skipped: 0, rejected: 0, pending: 3 }, legal_basis_at: null, created_at: '2026-10-17T15:00:00.000Z', started_at: null, finished_at: null, ...over,
});
const PREVIEW: ImportPreview = { total: 3, new: 2, duplicates_existing: 1, duplicates_in_file: 0, invalid: 0, samples: [] };
const CSV = 'Nombre,Celular,Ciudad,Notas\nAna,0984217730,Quito,x\nBeto,0991112233,Cuenca,y\nCarla,0987654321,Lima,z\n';

interface World { routes: Record<string, Handler>; imp: ContactImport; calls: { create: Call[]; rows: Call[]; patch: Call[]; start: Call[]; process: number; exports: Call[]; cancel: number } }

function world(access: ContactAccess = ALL, over: { history?: ContactImport[]; preview?: ImportPreview; createError?: ReturnType<typeof err>; processFails?: number } = {}): World {
  const w: World = { routes: {}, imp: imp(), calls: { create: [], rows: [], patch: [], start: [], process: 0, exports: [], cancel: 0 } };
  let processFails = over.processFails ?? 0;
  w.routes = {
    ...authed(access.view_all ? ME_ADMIN : ME_ADVISOR),
    'GET /contacts': () => ({ body: { items: [ANA], next_cursor: null, total: 1, access } }),
    'GET /contacts/owners': () => ({ body: { items: [{ id: 'u9', name: 'Carolina Vera', email: 'c@x.test', role: 'advisor' }] } }),
    'GET /tags': () => ({ body: { items: [LEAD, VIP], access: { manage: true } } }),
    'GET /custom-fields': () => ({ body: { items: [CIUDAD], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: [] } }),
    'GET /contact-imports': () => ({ body: { items: over.history ?? [] } }),
    'POST /contact-imports': (call) => {
      w.calls.create.push(call);
      if (over.createError) return over.createError;
      const b = call.body as { file_name: string; total_rows: number; headers: string[]; mapping: string[] };
      w.imp = imp({ file_name: b.file_name, total_rows: b.total_rows, headers: b.headers, mapping: b.mapping, counts: { created: 0, updated: 0, skipped: 0, rejected: 0, pending: b.total_rows } });
      return { status: 201, body: w.imp };
    },
    'POST /contact-imports/imp1/rows': (call) => {
      w.calls.rows.push(call);
      const b = call.body as { from: number; rows: string[][] };
      const staged = b.from - 1 + b.rows.length;
      w.imp = { ...w.imp, staged_rows: staged, status: staged >= w.imp.total_rows ? 'ready' : 'staging' };
      return { body: w.imp };
    },
    'GET /contact-imports/imp1': () => ({ body: w.imp }),
    'GET /contact-imports/imp1/preview': () => ({ body: over.preview ?? PREVIEW }),
    'PATCH /contact-imports/imp1': (call) => {
      w.calls.patch.push(call);
      w.imp = { ...w.imp, options: { ...w.imp.options, ...(call.body as { options: object }).options } };
      return { body: w.imp };
    },
    'POST /contact-imports/imp1/start': (call) => {
      w.calls.start.push(call);
      w.imp = { ...w.imp, status: 'running', started_at: '2026-10-17T15:01:00.000Z', legal_basis_at: (call.body as { legal_basis?: boolean }).legal_basis ? '2026-10-17T15:01:00.000Z' : null };
      return { body: w.imp };
    },
    'POST /contact-imports/imp1/process': () => {
      w.calls.process += 1;
      if (processFails > 0) { processFails -= 1; return err(500, 'INTERNAL_ERROR'); }
      w.imp = { ...w.imp, status: 'done', finished_at: '2026-10-17T15:02:00.000Z', counts: { created: 2, updated: 0, skipped: 1, rejected: 0, pending: 0 } };
      return { body: w.imp };
    },
    'POST /contact-imports/imp1/cancel': () => { w.calls.cancel += 1; w.imp = { ...w.imp, status: 'cancelled' }; return { body: w.imp }; },
    'GET /contact-imports/imp1/report': () => ({ text: '\uFEFFNombre,Celular,Ciudad,Notas,Estado,Motivo\r\nAna,0984217730,Quito,x,Omitida,Ya existe\r\n', headers: { 'content-disposition': 'attachment; filename="clientes-reporte.csv"' } }),
    'POST /contacts/export': (call) => {
      w.calls.exports.push(call);
      return { text: '\uFEFFNombre\r\nAna Torres\r\n', headers: { 'content-disposition': 'attachment; filename="contactos-2026-10-17.csv"', 'x-export-count': '1' } };
    },
  };
  return w;
}

const file = (text = CSV, name = 'clientes.csv') => new File([text], name, { type: 'text/csv' });
const downloads: string[] = [];
function stubDownloads() {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
}
beforeEach(() => { downloads.length = 0; stubDownloads(); });

async function openImport() {
  renderApp('/contacts');
  await userEvent.click(await screen.findByRole('button', { name: 'Importar' }));
  return screen.getByRole('dialog', { name: 'Importar contactos' });
}

describe('Importar y exportar · permisos', () => {
  it('el administrador ve Importar y Exportar; el asesor no', async () => {
    mockApi(world(ALL).routes);
    renderApp('/contacts');
    expect(await screen.findByRole('button', { name: 'Importar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeInTheDocument();
  });
  it('sin permiso no aparecen', async () => {
    mockApi(world(ADVISOR).routes);
    renderApp('/contacts');
    await screen.findByText('Ana Torres');
    expect(screen.queryByRole('button', { name: 'Importar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
  });
});

describe('Importar contactos', () => {
  it('flujo completo: archivo → columnas sugeridas → revisión con opciones → importación → resultado con reporte', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file());

    // Mapeo sugerido por los encabezados
    expect(await within(dlg).findByText(/3 filas · 4 columnas/)).toBeInTheDocument();
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Nombre»' })).toHaveValue('name');
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Celular»' })).toHaveValue('phone');
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Ciudad»' })).toHaveValue('cf:ciudad');
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Notas»' })).toHaveValue('ignore');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Revisar' }));

    // Se creó con huella, encabezados y mapeo; las filas se subieron por lotes con su posición
    await within(dlg).findByText(/Importar 2 contactos/);
    const created = w.calls.create[0]!.body as { file_name: string; file_hash: string; total_rows: number; headers: string[]; mapping: string[] };
    expect(created).toMatchObject({ file_name: 'clientes.csv', total_rows: 3, headers: ['Nombre', 'Celular', 'Ciudad', 'Notas'], mapping: ['name', 'phone', 'cf:ciudad', 'ignore'] });
    expect(created.file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.calls.rows.map((c) => c.body)).toEqual([{ from: 1, rows: [['Ana', '0984217730', 'Quito', 'x'], ['Beto', '0991112233', 'Cuenca', 'y'], ['Carla', '0987654321', 'Lima', 'z']] }]);

    // Revisión: contadores y opciones
    expect(within(dlg).getByText('nuevos').closest('li')).toHaveTextContent('2');
    expect(within(dlg).getByText('ya existen').closest('li')).toHaveTextContent('1');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Si el teléfono ya existe' }), 'update_empty');
    await waitFor(() => expect(w.calls.patch.at(-1)!.body).toEqual({ options: { duplicates: 'update_empty' } }));
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Etiqueta' }), 't-vip');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Responsable de los importados' }), 'u9');
    expect(within(dlg).queryByRole('option', { name: 'Lead' })).not.toBeInTheDocument(); // las etiquetas del sistema no se ofrecen
    await waitFor(() => expect(w.calls.patch.map((c) => c.body)).toContainEqual({ options: { owner_id: 'u9' } }));

    // Empezar y terminar
    await userEvent.click(within(dlg).getByRole('button', { name: /Importar 3 contactos/ }));
    expect(await within(dlg).findByText('Importación terminada.')).toBeInTheDocument();
    expect(w.calls.start[0]!.body).toEqual({});
    expect(w.calls.process).toBe(1);
    expect(within(dlg).getByText('creados').closest('li')).toHaveTextContent('2');
    expect(within(dlg).getByText('omitidos').closest('li')).toHaveTextContent('1');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Descargar reporte de omitidos y rechazados' }));
    await waitFor(() => expect(downloads).toEqual(['clientes-reporte.csv']));
  });

  it('«con consentimiento» exige confirmar la base legal antes de poder importar, y la envía', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file());
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Revisar' }));
    await within(dlg).findByText(/Importar 2 contactos/);
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Consentimiento' }), 'granted');
    const confirm = await within(dlg).findByRole('checkbox', { name: /base legal/ });
    const go = within(dlg).getByRole('button', { name: /Importar 2 contactos/ });
    expect(go).toBeDisabled();
    await userEvent.click(confirm);
    expect(go).toBeEnabled();
    await userEvent.click(go);
    await within(dlg).findByText('Importación terminada.');
    expect(w.calls.start[0]!.body).toEqual({ legal_basis: true });
  });

  it('exige exactamente una columna de teléfono: sin ella no se puede continuar', async () => {
    mockApi(world().routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file());
    await userEvent.selectOptions(await within(dlg).findByRole('combobox', { name: 'Destino de «Celular»' }), 'ignore');
    expect(within(dlg).getByText('Elige exactamente una columna como «Teléfono».')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Revisar' })).toBeDisabled();
    // Un destino solo puede estar en una columna: al repetirlo, la otra vuelve a «No importar»
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Destino de «Notas»' }), 'phone');
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Notas»' })).toHaveValue('phone');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Destino de «Celular»' }), 'phone');
    expect(within(dlg).getByRole('combobox', { name: 'Destino de «Notas»' })).toHaveValue('ignore');
    expect(within(dlg).getByRole('button', { name: 'Revisar' })).toBeEnabled();
  });

  it('un archivo inválido (vacío, sin filas) muestra el motivo y no sube nada', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file('Nombre,Celular\n'));
    expect(await within(dlg).findByText(/solo tiene la fila de encabezados/)).toBeInTheDocument();
    expect(w.calls.create).toHaveLength(0);
  });

  it('si el mismo archivo ya se importó, lo dice y deja reintentar', async () => {
    mockApi(world(ALL, { createError: err(409, 'IMPORT_DUPLICATE_FILE', 'x') }).routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file());
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Revisar' }));
    expect(await within(dlg).findByText(/Este archivo ya se importó/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Revisar' })).toBeEnabled();
  });

  it('si se interrumpe el proceso, se detiene y «Continuar» lo reanuda desde donde quedó', async () => {
    const w = world(ALL, { processFails: 1 });
    mockApi(w.routes);
    const dlg = await openImport();
    await userEvent.upload(within(dlg).getByLabelText('Archivo CSV'), file());
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Revisar' }));
    await userEvent.click(await within(dlg).findByRole('button', { name: /Importar 2 contactos/ }));
    expect(await within(dlg).findByText(/Tuvimos un problema de nuestro lado/)).toBeInTheDocument();
    expect(within(dlg).queryByText('Importación terminada.')).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Continuar' }));
    expect(await within(dlg).findByText('Importación terminada.')).toBeInTheDocument();
    expect(w.calls.process).toBe(2);
  });

  it('el historial permite retomar una importación lista, cancelarla y descargar el reporte de una terminada', async () => {
    const ready = imp({ id: 'imp1', status: 'ready', staged_rows: 3 });
    const done = imp({ id: 'imp1', file_name: 'viejo.csv', status: 'done', counts: { created: 5, updated: 0, skipped: 2, rejected: 1, pending: 0 } });
    const w = world(ALL, { history: [ready, { ...done, id: 'imp1', file_name: 'viejo.csv' }] });
    w.imp = ready;
    mockApi(w.routes);
    const dlg = await openImport();
    const items = await within(dlg).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText(/5 nuevos, 0 actualizados, 2 omitidos, 1 rechazados/)).toBeInTheDocument();
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Descargar reporte' }));
    await waitFor(() => expect(downloads).toEqual(['clientes-reporte.csv']));
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Continuar' }));
    expect(await within(dlg).findByText(/Importar 2 contactos/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancelar importación' }));
    await waitFor(() => expect(w.calls.cancel).toBe(1));
  });
});

describe('Exportar contactos', () => {
  async function openExport() {
    renderApp('/contacts');
    await screen.findByText('Ana Torres');
    await userEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    return screen.getByRole('dialog', { name: 'Exportar contactos' });
  }

  it('exporta la vista actual con las columnas visibles y descarga el archivo', async () => {
    const w = world();
    mockApi(w.routes);
    const dlg = await openExport();
    expect(within(dlg).getByRole('radio', { name: /Los contactos de la vista actual \(1\)/ })).toBeChecked();
    expect(within(dlg).queryByRole('radio', { name: /seleccionados/ })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Exportar' }));
    expect(await within(dlg).findByText(/se descargó el archivo con 1 contacto/)).toBeInTheDocument();
    expect(w.calls.exports[0]!.body).toEqual({ scope: 'view', columns: ['name', 'phone', 'owner', 'consent', 'tags', 'created_at'], sort: 'created_at', order: 'desc' });
    expect(downloads).toEqual(['contactos-2026-10-17.csv']);
  });

  it('con contactos seleccionados ofrece exportar solo esos; «todos» ignora filtros y «todas las columnas» no envía columnas', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts');
    await screen.findByText('Ana Torres');
    await userEvent.click(screen.getByRole('checkbox', { name: /Seleccionar a Ana Torres|Seleccionar el contacto Ana Torres/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dlg = screen.getByRole('dialog', { name: 'Exportar contactos' });
    expect(within(dlg).getByRole('radio', { name: 'Los 1 contactos seleccionados' })).toBeChecked();
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Todas las columnas' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Exportar' }));
    await within(dlg).findByText(/se descargó/);
    expect(w.calls.exports[0]!.body).toEqual({ scope: 'selection', ids: ['c1'], sort: 'created_at', order: 'desc' });
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Todos los contactos' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Exportar' }));
    await waitFor(() => expect(w.calls.exports).toHaveLength(2));
    expect(w.calls.exports[1]!.body).toEqual({ scope: 'all', sort: 'created_at', order: 'desc' });
  });

  it('muestra el motivo si el servidor rechaza la exportación (demasiados contactos)', async () => {
    const w = world();
    w.routes['POST /contacts/export'] = () => err(400, 'EXPORT_TOO_LARGE', 'Son más de 20000 contactos: aplica filtros o elige una lista para exportar menos');
    mockApi(w.routes);
    const dlg = await openExport();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Exportar' }));
    expect(await within(dlg).findByText(/Son más de 20000 contactos/)).toBeInTheDocument();
    expect(downloads).toEqual([]);
  });
});
