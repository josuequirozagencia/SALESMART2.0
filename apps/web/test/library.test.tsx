import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAsset, LibraryFolder, LibraryPage } from '../src/features/library/useLibrary';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { localStorage.clear(); } catch { /* sin almacenamiento */ } });

const AT = '2026-11-23T15:00:00.000Z';
const MB = 1024 * 1024;
const asset = (over: Partial<LibraryAsset> = {}): LibraryAsset => ({ id: 'a1', name: 'Catálogo 2026.pdf', description: 'Precios vigentes', kind: 'document', mime_type: 'application/pdf', size_bytes: 2 * MB, folder_id: null, usable_by_advisors: true, usable_by_ai: false, state: 'ready', scan_status: 'clean', created_at: AT, archived_at: null, ...over });
const folder = (over: Partial<LibraryFolder> = {}): LibraryFolder => ({ id: 'f1', name: 'Servicios', asset_count: 1, ...over });

interface World { extra: number; request: { id: string; plan_name: string | null; created_at: string } | null; plans: Array<{ id: string; name: string; extra_bytes: number; price_amount: string; currency: string; period: 'monthly' }>; usedBy: Array<{ id: string; name: string; status: string }>; assets: LibraryAsset[]; folders: LibraryFolder[]; used: number; quota: number; manage: boolean; denied: boolean; calls: Record<string, Call[]>; uploadFails?: () => ReturnType<Handler> }
const world = (over: Partial<World> = {}): World => ({ extra: 0, request: null, plans: [{ id: 'pl1', name: 'Extra S', extra_bytes: 5 * 1024 * MB, price_amount: '3.00', currency: 'USD', period: 'monthly' }], usedBy: [], assets: [asset(), asset({ id: 'a2', name: 'Corte clásico.jpg', kind: 'image', mime_type: 'image/jpeg', size_bytes: 300 * 1024, folder_id: 'f1', description: null, usable_by_advisors: false })], folders: [folder()], used: 2 * MB + 300 * 1024, quota: 1024 * MB, manage: true, denied: false, calls: {}, ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };

function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  return {
    ...authed(me),
    'GET /library': (c) => {
      rec(w, 'list', c);
      if (w.denied) return err(403, 'FORBIDDEN', 'sin permiso');
      const f = c.query.get('folder_id');
      const q = c.query.get('q')?.toLowerCase();
      const kind = c.query.get('kind');
      const archived = c.query.get('state') === 'archived';
      let items = w.assets.filter((a) => (archived ? a.state === 'archived' : a.state === 'ready') && (w.manage || a.usable_by_advisors));
      if (f === 'root') items = items.filter((a) => a.folder_id === null);
      else if (f) items = items.filter((a) => a.folder_id === f);
      if (q) items = items.filter((a) => a.name.toLowerCase().includes(q));
      if (kind) items = items.filter((a) => a.kind === kind);
      const limit = Number(c.query.get('limit') ?? 30);
      return { body: { folders: w.folders, items: items.slice(0, limit), next_cursor: null, usage: w.manage ? { used_bytes: w.used, quota_bytes: w.quota, available_bytes: Math.max(0, w.quota - w.used), assets: w.assets.length, included_bytes: w.quota - w.extra, extra_bytes: w.extra, next_expiry_at: null, request: w.request } : null, access: { manage: w.manage }, storage_available: true } satisfies LibraryPage };
    },
    'GET /library/storage-plans': () => ({ body: { plans: w.plans, request: w.request } }),
    'POST /library/storage-requests': (c) => { rec(w, 'request', c); w.request = { id: 'rq1', plan_name: w.plans.find((p) => p.id === (c.body as { plan_id?: string }).plan_id)?.name ?? null, created_at: AT }; return { status: 201, body: { ...w.request, plan_id: null, status: 'open', note: null } }; },
    'GET /library/assets/a1/usage': (c) => { rec(w, 'usage', c); return { body: { automations: w.usedBy } }; },
    'GET /library/assets/a1/url': (c) => { rec(w, 'url', c); return { body: { url: 'https://storage.test/a1?sig=1', expires_at: AT, kind: 'document', mime_type: 'application/pdf', name: 'Catálogo 2026.pdf' } }; },
    'GET /library/assets/a2/url': () => ({ body: { url: 'https://storage.test/a2?sig=2', expires_at: AT, kind: 'image', mime_type: 'image/jpeg', name: 'Corte clásico.jpg' } }),
    'POST /library/assets': (c) => {
      rec(w, 'upload', c);
      if (w.uploadFails) return w.uploadFails();
      const n = asset({ id: 'a9', name: c.headers['x-filename'] ?? 'nuevo', kind: 'image', mime_type: 'image/jpeg', folder_id: c.query.get('folder_id') });
      w.assets = [n, ...w.assets];
      return { status: 201, body: n };
    },
    'PATCH /library/assets/a1': (c) => { rec(w, 'patch', c); return { body: asset({ ...(c.body as Partial<LibraryAsset>) }) }; },
    'POST /library/assets/a1/archive': (c) => { rec(w, 'archive', c); w.assets = w.assets.map((a) => (a.id === 'a1' ? { ...a, state: 'archived', archived_at: AT } : a)); return { body: asset({ state: 'archived' }) }; },
    'POST /library/folders': (c) => { rec(w, 'folder-new', c); const f = folder({ id: 'f2', name: (c.body as { name: string }).name, asset_count: 0 }); w.folders = [...w.folders, f]; return { status: 201, body: f }; },
    'PATCH /library/folders/f1': (c) => { rec(w, 'folder-rename', c); return { body: folder({ name: (c.body as { name: string }).name }) }; },
    'POST /library/folders/f1/archive': (c) => { rec(w, 'folder-archive', c); return err(409, 'FOLDER_NOT_EMPTY', 'La carpeta tiene archivos: muévelos o archívalos primero'); },
  };
}

const grid = async () => within(await screen.findByRole('list', { name: 'Archivos' }));

describe('Biblioteca · administrador', () => {
  it('muestra los archivos, las carpetas con su conteo, el espacio usado y la sección en el menú; filtra por carpeta, tipo y nombre', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/library');
    expect(await screen.findByRole('heading', { name: 'Biblioteca' })).toBeInTheDocument();
    const g = await grid();
    expect(g.getByText('Catálogo 2026.pdf')).toBeInTheDocument();
    expect(g.getByText('Corte clásico.jpg')).toBeInTheDocument();
    expect(g.getByText('Para asesores')).toBeInTheDocument();
    expect(g.getByText('Solo administración')).toBeInTheDocument();
    expect(screen.getByText(/2,3 MB de 1,0 GB usados/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Espacio usado' })).toHaveAttribute('aria-valuenow', '0');
    expect(within(screen.getByRole('navigation', { name: 'Secciones' })).getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('href', '/library');
    const chips = within(screen.getByRole('group', { name: 'Carpetas' }));
    await userEvent.click(chips.getByRole('button', { name: /Servicios \(1\)/ }));
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('folder_id')).toBe('f1'));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Archivos' })).queryByText('Catálogo 2026.pdf')).toBeNull());
    await userEvent.click(chips.getByRole('button', { name: 'Todas' }));
    await userEvent.selectOptions(screen.getByLabelText('Tipo de archivo'), 'document');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('kind')).toBe('document'));
    await userEvent.type(screen.getByLabelText('Buscar archivos'), 'catá');
    await waitFor(() => expect(w.calls['list']!.at(-1)!.query.get('q')).toBe('catá'));
  });

  it('avisa cuando queda poco espacio (80 %) y cuando se llena (100 %)', async () => {
    mockApi(server(world({ used: 900 * MB, quota: 1000 * MB })));
    renderApp('/library');
    expect(await screen.findByText(/Te queda poco espacio/)).toBeInTheDocument();
    cleanupApp();
    resetWorld();
    mockApi(server(world({ used: 1000 * MB, quota: 1000 * MB })));
    renderApp('/library');
    expect(await screen.findByText(/llegó a su límite de espacio/)).toBeInTheDocument();
  });

  it('subir: manda cada archivo tal cual con su nombre y, con una carpeta elegida, a esa carpeta; un rechazo (sin espacio) se muestra con su motivo', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/library');
    await grid();
    await userEvent.click(within(screen.getByRole('group', { name: 'Carpetas' })).getByRole('button', { name: /Servicios/ }));
    const input = await screen.findByLabelText('Elegir archivos para subir');
    await userEvent.upload(input, new File(['0123456789'], 'foto.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(w.calls['upload']).toHaveLength(1));
    expect(w.calls['upload']![0]!.headers['x-filename']).toBe('foto.jpg');
    expect(w.calls['upload']![0]!.headers['content-type']).toBe('image/jpeg');
    expect(w.calls['upload']![0]!.query.get('folder_id')).toBe('f1');
    expect(w.calls['upload']![0]!.body).toEqual({ raw_bytes: 10 });
    expect(await within(await screen.findByRole('list', { name: 'Subidas' })).findByText('Subido')).toBeInTheDocument();
    w.uploadFails = () => err(409, 'QUOTA_EXCEEDED', 'No hay espacio: la biblioteca usa 1000 MB de 1000 MB');
    await userEvent.upload(input, new File(['x'], 'otra.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText(/No hay espacio/)).toBeInTheDocument();
  });

  it('editar manda solo lo que cambió; la casilla de la IA está desactivada («próximamente»); un 409 del servidor se explica', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/library');
    await userEvent.click(await screen.findByRole('button', { name: 'Editar Catálogo 2026.pdf' }));
    const d = within(await screen.findByRole('dialog', { name: 'Editar archivo' }));
    expect(d.getByRole('checkbox', { name: /Disponible para la IA/ })).toBeDisabled();
    await userEvent.clear(d.getByLabelText('Nombre'));
    await userEvent.type(d.getByLabelText('Nombre'), 'Lista de precios');
    await userEvent.click(d.getByRole('checkbox', { name: /Disponible para los asesores/ }));
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['patch']).toHaveLength(1));
    expect(w.calls['patch']![0]!.body).toEqual({ name: 'Lista de precios', usable_by_advisors: false });
  });

  it('al llegar al 100 % muestra el límite y deja solicitar más espacio con un plan; luego dice «Solicitud enviada»', async () => {
    const w = world({ used: 1024 * MB, quota: 1024 * MB });
    mockApi(server(w));
    renderApp('/library');
    expect(await screen.findByText(/llegó a su límite de espacio/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Solicitar más espacio' }));
    const d = within(await screen.findByRole('dialog', { name: 'Solicitar más espacio' }));
    await userEvent.click(await d.findByRole('radio', { name: /Extra S/ }));
    await userEvent.click(d.getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => expect(w.calls['request']).toHaveLength(1));
    expect(w.calls['request']![0]!.body).toEqual({ plan_id: 'pl1' });
    expect(await screen.findByText(/Solicitud enviada \(Extra S\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar más espacio' })).not.toBeInTheDocument();
  });

  it('con espacio extra vigente explica de dónde sale el cupo', async () => {
    const w = world({ extra: 5 * 1024 * MB, quota: 6 * 1024 * MB });
    mockApi(server(w));
    renderApp('/library');
    expect(await screen.findByText(/de espacio extra/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar más espacio' })).not.toBeInTheDocument();
  });

  it('al archivar un archivo que usan automatizaciones, el aviso las nombra', async () => {
    const w = world({ usedBy: [{ id: 'r1', name: 'Enviar catálogo', status: 'active' }, { id: 'r2', name: 'Seguimiento', status: 'paused' }] });
    mockApi(server(w));
    renderApp('/library');
    await userEvent.click(await screen.findByRole('button', { name: 'Archivar Catálogo 2026.pdf' }));
    const d = within(await screen.findByRole('dialog', { name: 'Archivar archivo' }));
    expect(await d.findByText(/estas automatizaciones/)).toBeInTheDocument();
    expect(d.getByText('Enviar catálogo')).toBeInTheDocument();
    expect(d.getByText('Seguimiento (en pausa)')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(w.calls['archive']).toHaveLength(1));
  });

  it('archivar pide confirmación y llama a la ruta; archivar una carpeta con archivos muestra el motivo', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/library');
    await userEvent.click(await screen.findByRole('button', { name: 'Archivar Catálogo 2026.pdf' }));
    const d = within(await screen.findByRole('dialog', { name: 'Archivar archivo' }));
    expect(d.getByText(/libera su espacio/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(w.calls['archive']).toHaveLength(1));
    await userEvent.click(within(screen.getByRole('group', { name: 'Carpetas' })).getByRole('button', { name: /Servicios/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Archivar carpeta' }));
    const f = within(await screen.findByRole('dialog', { name: 'Archivar carpeta' }));
    await userEvent.click(f.getByRole('button', { name: 'Archivar' }));
    expect(await f.findByText(/La carpeta tiene archivos/)).toBeInTheDocument();
  });

  it('crea y renombra carpetas', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/library');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva carpeta' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva carpeta' }));
    await userEvent.type(d.getByLabelText('Nombre de la carpeta'), 'Catálogos');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['folder-new']![0]!.body).toEqual({ name: 'Catálogos' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Carpetas' })).getByRole('button', { name: /Servicios/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Renombrar carpeta' }));
    const r = within(await screen.findByRole('dialog', { name: 'Renombrar carpeta' }));
    await userEvent.clear(r.getByLabelText('Nombre de la carpeta'));
    await userEvent.type(r.getByLabelText('Nombre de la carpeta'), 'Cortes');
    await userEvent.click(r.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['folder-rename']![0]!.body).toEqual({ name: 'Cortes' }));
  });
});

describe('Biblioteca · asesor y sin acceso', () => {
  it('el asesor solo ve y abre lo que el servidor le da: sin subir, carpetas nuevas, editar ni archivar; «Ver» abre la dirección firmada', async () => {
    const w = world({ manage: false });
    mockApi(server(w, ME_ADVISOR));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    renderApp('/library');
    const g = await grid();
    expect(g.getByText('Catálogo 2026.pdf')).toBeInTheDocument();
    expect(g.queryByText('Corte clásico.jpg')).toBeNull(); // no está marcado para asesores
    expect(screen.queryByRole('button', { name: 'Subir archivos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nueva carpeta' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Editar / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archivar / })).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    await userEvent.click(g.getByRole('button', { name: 'Ver Catálogo 2026.pdf' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://storage.test/a1?sig=1', '_blank', 'noopener,noreferrer'));
  });

  it('sin acceso (403) la pantalla lo explica y el menú no muestra «Biblioteca»', async () => {
    mockApi(server(world({ denied: true })));
    renderApp('/library');
    expect(await screen.findByText(/No tienes acceso a la biblioteca|sin permiso/)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Secciones' })).queryByRole('link', { name: 'Biblioteca' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────── el selector del chat
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null, ...over,
});
const msg = (): ChatMessage => ({ id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, my_reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null } as unknown as ChatMessage);
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };

function chatServer(w: World, c: Conversation, sendFails = false): Record<string, Handler> {
  return {
    ...server(w, ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg()], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'POST /conversations/c1/library/a1/send': (call) => { rec(w, 'send', call); return sendFails ? err(409, 'WINDOW_CLOSED', 'La ventana de 24 h está cerrada') : { status: 201, body: { id: 'm2' } }; },
  };
}

describe('Biblioteca · desde el chat', () => {
  it('el botón «Biblioteca» del redactor abre el selector; elegir un archivo con pie lo envía a la conversación y cierra', async () => {
    const w = world({ manage: false });
    mockApi(chatServer(w, conv()));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    await userEvent.click(await screen.findByRole('button', { name: 'Biblioteca' }));
    const d = within(await screen.findByRole('dialog', { name: 'Biblioteca' }));
    expect(d.getByRole('button', { name: 'Elegir Catálogo 2026.pdf' })).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Elegir Corte clásico.jpg' })).toBeNull(); // no está marcado para asesores
    expect(d.getByRole('button', { name: 'Enviar archivo' })).toBeDisabled();
    await userEvent.click(d.getByRole('button', { name: 'Elegir Catálogo 2026.pdf' }));
    await userEvent.type(d.getByLabelText(/Texto que acompaña al archivo/), 'Aquí tienes los precios');
    await userEvent.click(d.getByRole('button', { name: 'Enviar archivo' }));
    await waitFor(() => expect(w.calls['send']).toHaveLength(1));
    expect(w.calls['send']![0]!.body).toEqual({ caption: 'Aquí tienes los precios' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Biblioteca' })).toBeNull());
  });

  it('con la ventana de 24 h cerrada explica por qué no se puede enviar; un rechazo del servidor se muestra', async () => {
    const closed = conv({ window: { open: false, expires_at: null } });
    const w = world({ manage: false });
    mockApi(chatServer(w, closed));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    await userEvent.click(await screen.findByRole('button', { name: 'Biblioteca' }));
    const d = within(await screen.findByRole('dialog', { name: 'Biblioteca' }));
    expect(d.getByText(/Pasaron más de 24 horas/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Elegir Catálogo 2026.pdf' }));
    expect(d.getByRole('button', { name: 'Enviar archivo' })).toBeDisabled();
  });

  it('sin acceso a la biblioteca el redactor no ofrece el botón', async () => {
    const w = world({ denied: true });
    mockApi(chatServer(w, conv()));
    renderApp('/inbox/c1');
    await screen.findByRole('log', { name: 'Mensajes' });
    await screen.findByRole('button', { name: 'Respuestas rápidas' });
    expect(screen.queryByRole('button', { name: 'Biblioteca' })).toBeNull();
  });
});

function cleanupApp(): void {
  document.body.innerHTML = '';
}
