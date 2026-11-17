import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, TeamMember, TeamMemberFull } from '../src/lib/types';
import type { AudienceItem, Campaign, CampaignAccessInfo, CampaignPreview } from '../src/features/campaigns/useCampaigns';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v17 · 17.2 — «Campañas masivas» (ADR-72): la pantalla del prototipo (una sola pantalla con cinco secciones), el menú, el bloqueo por plan, el alcance del asesor y el tope diario por asesor.

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ADMIN: CampaignAccessInfo = { plan_enabled: true, read: true, send: true, view_all: true, manage_limits: true, manage_settings: true, cancel_others: true };
const ADVISOR: CampaignAccessInfo = { plan_enabled: true, read: true, send: true, view_all: false, manage_limits: false, manage_settings: false, cancel_others: false };
const OPTIONS = {
  channels: [{ id: 'c-off', name: 'Ventas', kind: 'official' }, { id: 'c-qr', name: 'Chip QR', kind: 'qr' }],
  limits: { official_daily_cap: 1000, qr_min_gap_seconds: 45, official_min_gap_seconds: 5, advisor_daily_cap: null as number | null, max_audience: 5000 },
};
const TEMPLATES = { items: [{ id: 't1', name: 'cupos_octubre', language: 'es', category: 'marketing', body: 'Hola {{1}}, tenemos cupos para el {{2}}.', header: null, footer: null, variables: [{ id: 'body:1', part: 'body', key: '1', example: 'Ana' }, { id: 'body:2', part: 'body', key: '2', example: 'viernes' }] }] };
const PEOPLE: AudienceItem[] = [
  { id: 'k1', name: 'Ana Lema', phone: '+593988000001', state: 'eligible' },
  { id: 'k2', name: 'Beto Vera', phone: '+593988000002', state: 'eligible' },
  { id: 'k3', name: 'Pidió Baja', phone: '+593988000003', state: 'revoked' },
  { id: 'k4', name: 'Sin Permiso', phone: '+593988000004', state: 'no_consent' },
];
const DRAFT: Campaign = {
  id: 'cmp1', name: 'Recordatorio de cupos', status: 'draft', status_reason: null, mode: 'text', channel: { id: 'c-qr', name: 'Chip QR', kind: 'qr' }, template_id: null, template_params: {}, body: 'Hola {{primer_nombre}}',
  audience: { source: 'all' }, include_unknown_consent: false, scheduled_at: null, gap_seconds: 60, daily_cap: 50, created_by: { id: 'u1', name: 'Ana Pérez' }, created_at: '2026-11-16T10:00:00.000Z', updated_at: '2026-11-16T10:00:00.000Z',
  launched_at: null, finished_at: null, counts: { total: 0, by_status: {}, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 }, can_edit: true, can_pause: false, can_resume: false, can_cancel: false,
};
const RUNNING: Campaign = { ...DRAFT, id: 'cmpR', name: 'En curso hoy', status: 'running', mode: 'template', channel: { id: 'c-off', name: 'Ventas', kind: 'official' }, template_id: 't1', counts: { total: 10, by_status: {}, sent: 4, delivered: 3, read: 1, replied: 0, failed: 1, skipped: 2 }, can_edit: false, can_pause: true, can_resume: false, can_cancel: true };
const PAUSED: Campaign = { ...RUNNING, id: 'cmpP', name: 'Pausada por límite', status: 'paused', status_reason: 'WhatsApp limitó los envíos de este número. La campaña quedó pausada: reanúdala más tarde.', can_pause: false, can_resume: true };
const previewFor = (over: Partial<CampaignPreview> = {}): CampaignPreview => ({
  campaign_id: null,
  audience: { in_scope: 4, out_of_scope: 0, eligible: 2, skipped: { revoked: 1, excluded: 0, no_phone: 0, no_consent: 1, duplicate: 0 }, sample: [{ id: 'k1', name: 'Ana Lema' }] },
  limits: { channel_kind: 'official', daily_cap: 100, channel_cap: 1000, advisor_cap: null, min_gap_seconds: 5 },
  estimate: { days: 1, first_day_minutes: 1 },
  message: null,
  warnings: ['official_marketing_cost'],
  ...over,
});

interface World { access: CampaignAccessInfo; items: Campaign[]; previews: Call[]; creates: Call[]; actions: Call[]; options: typeof OPTIONS; created: Campaign | null; cap: number }
const world = (over: Partial<World> = {}): World => ({ access: ADMIN, items: [DRAFT], previews: [], creates: [], actions: [], options: OPTIONS, created: null, cap: 1000, ...over });

function server(w: World, me: Me = ME_ADMIN, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(me),
    'GET /custom-fields': () => ({ body: { items: [{ id: 'f1', entity: 'contact', name: 'Ciudad', key: 'ciudad', type: 'text', options: null, required: false, show_in_form: true, position: 0, archived_at: null, created_at: '2026-10-01T00:00:00.000Z' }], access: { manage: me.role === 'client_admin' } } }),
    'GET /contact-lists': () => ({ body: { items: [{ id: 'l1', name: 'Interesados en uñas', kind: 'fixed', filters: {}, columns: null, sort: null, shared: true, mine: true, member_count: 12, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }] } }),
    'GET /campaigns/access': () => ({ body: w.access }),
    'GET /campaigns/options': () => ({ body: w.options }),
    'GET /campaigns': () => ({ body: { items: w.items, next_cursor: null } }),
    'GET /campaigns/channels/c-off/templates': () => ({ body: TEMPLATES }),
    'POST /campaigns/preview': (c) => {
      w.previews.push(c);
      const b = c.body as { channel_id?: string | null; mode?: string | null; body?: string | null };
      const qr = b.channel_id === 'c-qr';
      return { body: previewFor({ limits: { channel_kind: qr ? 'qr' : 'official', daily_cap: qr ? 50 : 100, channel_cap: qr ? 175 : 1000, advisor_cap: w.options.limits.advisor_daily_cap, min_gap_seconds: qr ? 45 : 5 }, ...(qr && b.body ? { message: { text: b.body.replace('{{primer_nombre}}', 'Ana'), missing: [], contact: { id: 'k1', name: 'Ana Lema' } }, warnings: ['qr_unofficial_risk'] } : {}) }) };
    },
    'POST /campaigns/audience': () => ({ body: { items: PEOPLE, total: PEOPLE.length, next_cursor: null } }),
    'POST /campaigns': (c) => {
      w.creates.push(c);
      const sent = c.body as { name: string; channel_id: string; scheduled_at?: string | null };
      w.created = { ...DRAFT, id: 'cmp2', name: sent.name, scheduled_at: sent.scheduled_at ?? null, ...(sent.channel_id === 'c-off' ? { mode: 'template' as const, channel: { id: 'c-off', name: 'Ventas', kind: 'official' as const }, template_id: 't1', body: null } : {}) };
      return { status: 201, body: w.created };
    },
    'PATCH /campaigns/cmp2': (c) => { w.actions.push(c); return { body: { ...w.created, ...(c.body as object) } }; },
    'POST /campaigns/cmp2/launch': (c) => { w.actions.push(c); return { status: 201, body: { ...w.created, status: 'running', can_edit: false, can_pause: true, can_cancel: true } }; },
    'POST /campaigns/cmpR/pause': (c) => { w.actions.push(c); return { body: { ...RUNNING, status: 'paused', can_pause: false, can_resume: true } }; },
    'POST /campaigns/cmpP/resume': (c) => { w.actions.push(c); return { body: { ...PAUSED, status: 'running', status_reason: null } }; },
    'POST /campaigns/cmpR/cancel': (c) => { w.actions.push(c); return { body: { ...RUNNING, status: 'cancelled', can_pause: false, can_cancel: false } }; },
    'GET /campaigns/settings': () => ({ body: { official_daily_cap: w.cap, default_cap: 1000 } }),
    'PUT /campaigns/settings': (c) => { w.actions.push(c); w.cap = (c.body as { official_daily_cap: number }).official_daily_cap; return { body: { official_daily_cap: w.cap, default_cap: 1000 } }; },
    ...extra,
  };
}

describe('el menú y el plan', () => {
  it('con acceso aparece «Campañas masivas» en el menú (grupo Comunicación) y lleva a la pantalla con su título y su tabla', async () => {
    mockApi(server(world()));
    renderApp('/campaigns');
    expect(await screen.findByRole('heading', { level: 1, name: 'Campañas masivas' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones' });
    expect(await within(nav).findByRole('link', { name: 'Campañas masivas' })).toHaveAttribute('href', '/campaigns');
    expect(within(nav).getByText('Comunicación')).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Recordatorio de cupos')).toBeInTheDocument();
    expect(within(table).getByText('Borrador')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Creada por' })).toBeInTheDocument();
    expect(within(table).getByText('Chip QR · texto libre')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Resultados de Recordatorio de cupos' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Reglas de protección' })).toBeInTheDocument();
  });

  it('sin permiso la sección no aparece en el menú; con un plan que no la incluye aparece BLOQUEADA y la pantalla lo explica', async () => {
    const none = world({ access: { ...ADVISOR, read: false, send: false } });
    mockApi(server(none, ME_ADVISOR));
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola, / });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Campañas masivas' })).not.toBeInTheDocument());
    vi.unstubAllGlobals();
    resetWorld();
    mockApi(server(world({ access: { ...ADMIN, plan_enabled: false } })));
    renderApp('/campaigns');
    expect(await screen.findByRole('region', { name: 'Campañas no incluidas en el plan' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Nueva campaña' })).not.toBeInTheDocument();
    expect((await screen.findAllByLabelText('No incluida en tu plan')).length).toBeGreaterThan(0);
  });
});

describe('el asesor', () => {
  it('ve «Mis campañas masivas», su alcance (sus contactos y el resto bloqueado) y su tope; sin la columna «Creada por» ni la declaración de consentimiento', async () => {
    const w = world({ access: ADVISOR, options: { ...OPTIONS, limits: { ...OPTIONS.limits, advisor_daily_cap: 80 } } });
    mockApi(server(w, ME_ADVISOR, { 'POST /campaigns/preview': () => ({ body: previewFor({ audience: { in_scope: 12, out_of_scope: 30, eligible: 12, skipped: { revoked: 0, excluded: 0, no_phone: 0, no_consent: 0, duplicate: 0 }, sample: [] } }) }) }));
    renderApp('/campaigns');
    expect(await screen.findByRole('heading', { level: 1, name: 'Mis campañas masivas' })).toBeInTheDocument();
    const scope = await screen.findByRole('region', { name: 'Alcance de tus campañas' });
    await within(scope).findByText(/Mis contactos · 12/);
    expect(within(scope).getByText(/Resto de la empresa · 30/)).toBeInTheDocument();
    expect(within(scope).getByText(/tope diario de envíos: 80/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Creada por' })).not.toBeInTheDocument();
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    expect(within(form).queryByRole('checkbox', { name: /Incluir contactos sin consentimiento/i })).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Mis contactos' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Quién puede enviar campañas' })).not.toBeInTheDocument();
  });
});

describe('destinatarios', () => {
  it('cada contacto con su motivo: «No contactar» y «Sin consentimiento definido» no se pueden marcar; desmarcar uno cambia la vista previa; «Todos» lo deshace', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    const group = await within(form).findByRole('group', { name: 'Destinatarios' });
    const ana = await within(group).findByRole('checkbox', { name: 'Ana Lema: Recibirá el mensaje' });
    expect(ana).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Pidió Baja: No contactar' })).toBeDisabled();
    expect(within(group).getByRole('checkbox', { name: 'Sin Permiso: Sin consentimiento definido' })).toBeDisabled();
    await userEvent.click(ana);
    expect(await within(group).findByRole('checkbox', { name: 'Ana Lema: Desmarcado' })).not.toBeChecked();
    await waitFor(() => expect(w.previews.some((p) => (p.body as { audience: { excluded_contact_ids?: string[] } }).audience.excluded_contact_ids?.[0] === 'k1')).toBe(true));
    await userEvent.click(within(form).getByRole('button', { name: 'Todos' }));
    expect(await within(group).findByRole('checkbox', { name: 'Ana Lema: Recibirá el mensaje' })).toBeChecked();
    await userEvent.click(within(form).getByRole('button', { name: 'Ninguno' }));
    expect(await within(group).findByRole('checkbox', { name: 'Beto Vera: Desmarcado' })).not.toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'Ana Lema: Desmarcado' })).not.toBeChecked();
  });

  it('el administrador declara el permiso de los contactos sin consentimiento con una casilla; el conteo muestra a quién se excluye y por qué', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    expect(await within(form).findByText(/1 excluidos por «no contactar»/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('checkbox', { name: /Incluir contactos sin consentimiento/i }));
    await waitFor(() => expect(w.previews.some((p) => (p.body as { include_unknown_consent?: boolean }).include_unknown_consent === true)).toBe(true));
  });
});

describe('guardar el borrador', () => {
  it('por QR: aviso de riesgo, texto con variables, pausa mínima de 45 s; guarda con Idempotency-Key y el cuerpo esperado', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Conexión' }), 'c-qr');
    expect(await within(form).findByText(/Conexión no oficial/)).toBeInTheDocument();
    expect(within(form).getByText('WhatsApp QR · no oficial')).toBeInTheDocument();
    const gap = within(form).getByLabelText(/Pausa entre mensajes/);
    expect(gap).toHaveAttribute('min', '45');
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Cupos de octubre');
    const area = within(form).getByRole('textbox', { name: 'Mensaje' });
    await userEvent.clear(area);
    await userEvent.type(area, 'Hola ');
    await userEvent.click(within(form).getByRole('button', { name: '{{primer_nombre}}' }));
    expect(await within(form).findByText('Hola Ana')).toBeInTheDocument(); // vista previa con un contacto real
    await userEvent.click(within(form).getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(w.creates).toHaveLength(1));
    const c = w.creates[0]!;
    expect(c.headers['idempotency-key']).toMatch(/^web-/);
    expect(c.body).toMatchObject({ name: 'Cupos de octubre', channel_id: 'c-qr', mode: 'text', body: 'Hola {{primer_nombre}}', audience: { source: 'all' }, gap_seconds: 60, scheduled_at: null });
    expect(await screen.findByText(/Campaña «Cupos de octubre» guardada como borrador/)).toBeInTheDocument();
  });

  it('por WhatsApp oficial: solo plantillas aprobadas, una casilla de dato por variable, aviso de costo de marketing; no se guarda con datos incompletos', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Seguimiento');
    expect(within(form).getByRole('button', { name: 'Guardar borrador' })).toBeDisabled(); // falta la plantilla
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Plantilla' }), 't1');
    expect(within(form).getByText('Plantilla de marketing: tiene costo en Meta')).toBeInTheDocument();
    expect(within(form).getByLabelText(/Variable \{\{1\}\}/)).toHaveValue('{{primer_nombre}}');
    expect(within(form).getByRole('button', { name: 'Guardar borrador' })).toBeDisabled(); // falta el dato de {{2}}
    await userEvent.type(within(form).getByLabelText(/Variable \{\{2\}\}/), 'viernes');
    await userEvent.click(within(form).getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(w.creates).toHaveLength(1));
    expect(w.creates[0]!.body).toMatchObject({ channel_id: 'c-off', mode: 'template', template_id: 't1', template_params: { 'body:1': '{{primer_nombre}}', 'body:2': 'viernes' }, gap_seconds: 60 });
  });

  it('una regla del servidor (por ejemplo el tope diario) se muestra tal cual, con la causa, y no se pierde lo escrito', async () => {
    const w = world();
    mockApi(server(w, ME_ADMIN, { 'POST /campaigns': () => err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'daily_cap', code: 'cap_exceeded', message: 'El máximo por día es 14' }] } } }) }));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Conexión' }), 'c-qr');
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Demasiado');
    await userEvent.click(within(form).getByRole('button', { name: 'Guardar borrador' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('El máximo por día es 14');
    expect(within(form).getByLabelText(/1 · Nombre/)).toHaveValue('Demasiado');
  });

  it('por QR el envío todavía no existe (llega en la próxima versión): el botón está desactivado y se explica; guardar el borrador sigue funcionando; los resultados de un borrador están en cero', async () => {
    mockApi(server(world()));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Conexión' }), 'c-qr');
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Solo borrador');
    expect(await within(form).findByText(/El envío por WhatsApp QR llega en la próxima versión/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Enviar campaña' })).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Guardar borrador' })).toBeEnabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Recordatorio de cupos' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Recordatorio de cupos' }));
    expect(dlg.getByText('Destinatarios')).toBeInTheDocument();
    expect(dlg.getByText(/es un borrador/)).toBeInTheDocument();
  });

  it('por WhatsApp oficial: «Enviar campaña» guarda el borrador, pide la confirmación con lo que va a pasar y lanza con Idempotency-Key; la tabla muestra la campaña en curso', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Seguimiento');
    expect(within(form).getByRole('button', { name: 'Enviar campaña' })).toBeDisabled(); // falta la plantilla
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Plantilla' }), 't1');
    await userEvent.type(within(form).getByLabelText(/Variable \{\{2\}\}/), 'viernes');
    await userEvent.click(await within(form).findByRole('button', { name: 'Enviar campaña' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Enviar campaña' }));
    expect(await dlg.findByText(/se enviará a/)).toHaveTextContent('2 destinatarios por Ventas con la plantilla cupos_octubre');
    expect(dlg.getByText(/Un mensaje cada 60 segundos, hasta 100 por día/)).toBeInTheDocument();
    expect(dlg.getByText(/Las plantillas de marketing tienen costo en Meta/)).toBeInTheDocument();
    expect(dlg.getByText(/Quien pidió la baja o no dio su consentimiento no recibe nada/)).toBeInTheDocument();
    expect(w.creates).toHaveLength(1);
    await userEvent.click(dlg.getByRole('button', { name: 'Confirmar y enviar' }));
    expect(await screen.findByText(/Campaña «Seguimiento» en curso/)).toBeInTheDocument();
    const launch = w.actions.find((c) => c.path === '/campaigns/cmp2/launch')!;
    expect(launch.method).toBe('POST');
    expect(launch.headers['idempotency-key']).toMatch(/^web-/);
  });

  it('volver de la confirmación no pierde el borrador: «Enviar» de nuevo cambia el mismo borrador (no crea otro)', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Seguimiento');
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Plantilla' }), 't1');
    await userEvent.type(within(form).getByLabelText(/Variable \{\{2\}\}/), 'viernes');
    await userEvent.click(within(form).getByRole('button', { name: 'Enviar campaña' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Enviar campaña' })).getByRole('button', { name: 'Volver' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Enviar campaña' }));
    await screen.findByRole('dialog', { name: 'Enviar campaña' });
    expect(w.creates).toHaveLength(1);
    expect(w.actions.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('programar: el botón cambia a «Programar campaña» y la confirmación dice cuándo saldrá', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Programada');
    await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Plantilla' }), 't1');
    await userEvent.type(within(form).getByLabelText(/Variable \{\{2\}\}/), 'viernes');
    await userEvent.click(within(form).getByRole('button', { name: 'Programar' }));
    const future = new Date(Date.now() + 2 * 86_400_000);
    const pad = (x: number): string => String(x).padStart(2, '0');
    fireEvent.change(within(form).getByLabelText('Día y hora de envío'), { target: { value: `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:30` } });
    await userEvent.click(await within(form).findByRole('button', { name: 'Programar campaña' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Programar campaña' }));
    expect(await dlg.findByText(/Saldrá el/)).toBeInTheDocument();
    expect((w.creates[0]!.body as { scheduled_at: string }).scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('pausar, reanudar y cancelar desde la tabla', () => {
  it('una campaña en curso se pausa; la pausada muestra su motivo y se reanuda; cancelar pide confirmación y no se deshace', async () => {
    const w = world({ items: [RUNNING, PAUSED] });
    mockApi(server(w));
    renderApp('/campaigns');
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('En curso')).toBeInTheDocument();
    expect(within(table).getByText(/WhatsApp limitó los envíos de este número/)).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Pausar En curso hoy' }));
    await waitFor(() => expect(w.actions.some((c) => c.path === '/campaigns/cmpR/pause')).toBe(true));
    expect(await screen.findByText(/Campaña «En curso hoy» pausada/)).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Reanudar Pausada por límite' }));
    await waitFor(() => expect(w.actions.some((c) => c.path === '/campaigns/cmpP/resume')).toBe(true));
    await userEvent.click(within(table).getByRole('button', { name: 'Cancelar En curso hoy' }));
    const ask = within(await screen.findByRole('dialog', { name: '¿Cancelar la campaña?' }));
    expect(ask.getByText(/No se puede deshacer/)).toBeInTheDocument();
    expect(w.actions.some((c) => c.path === '/campaigns/cmpR/cancel')).toBe(false); // todavía no
    await userEvent.click(ask.getByRole('button', { name: 'Sí, cancelar' }));
    await waitFor(() => expect(w.actions.some((c) => c.path === '/campaigns/cmpR/cancel')).toBe(true));
    expect(await screen.findByText(/Campaña «En curso hoy» cancelada/)).toBeInTheDocument();
  });

  it('un asesor sin permiso de las ajenas no ve los botones de una campaña que no puede tocar; los números se muestran acumulados', async () => {
    mockApi(server(world({ access: ADVISOR, items: [{ ...RUNNING, can_pause: false, can_cancel: false }] }), ME_ADVISOR));
    renderApp('/campaigns');
    const table = await screen.findByRole('table');
    await within(table).findByText('En curso hoy');
    expect(within(table).queryByRole('button', { name: /Pausar|Cancelar/ })).not.toBeInTheDocument();
    const row = within(await within(table).findByRole('row', { name: /En curso hoy/ }));
    expect(row.getAllByText('10')[0]).toBeInTheDocument(); // destinatarios
    expect(row.getByText('4')).toBeInTheDocument(); // enviados
  });
});

describe('tope diario de la empresa', () => {
  it('quien administra las conexiones lo ve y lo cambia', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const card = await screen.findByRole('region', { name: 'Tope diario de la empresa' });
    const input = within(card).getByLabelText('Mensajes por día');
    await waitFor(() => expect(input).toHaveValue(1000));
    await userEvent.clear(input);
    await userEvent.type(input, '300');
    await userEvent.click(within(card).getByRole('button', { name: 'Guardar tope' }));
    expect(await within(card).findByText('Tope guardado.')).toBeInTheDocument();
    expect(w.actions.find((c) => c.method === 'PUT')!.body).toEqual({ official_daily_cap: 300 });
  });

  it('el asesor no ve la tarjeta del tope de la empresa', async () => {
    mockApi(server(world({ access: ADVISOR }), ME_ADVISOR));
    renderApp('/campaigns');
    await screen.findByRole('heading', { level: 1, name: 'Mis campañas masivas' });
    await screen.findByRole('region', { name: 'Reglas de protección' });
    expect(screen.queryByRole('region', { name: 'Tope diario de la empresa' })).not.toBeInTheDocument();
  });
});

describe('tope diario por asesor en la ficha de la persona', () => {
  const member = (user_id: string, name: string, over: Partial<TeamMember> = {}): TeamMember => ({ user_id, name, email: `${name.split(' ')[0]!.toLowerCase()}@empresa.test`, phone: null, role: 'advisor', status: 'active', joined_at: '2026-10-01T10:00:00.000Z', deactivated_at: null, custom_permissions: false, last_access_at: null, departments: [], ...over });
  const PEOPLE_T = [member('u1', 'Ana Pérez', { role: 'client_admin' }), member('u2', 'Luis Navas')];
  const full = (m: TeamMember): TeamMemberFull => ({ ...m, hours: null, overrides: { grant: [], deny: [] }, template: [], effective: [], open_conversations: 0 });
  const usersServer = (w: World, puts: Call[]): Record<string, Handler> => ({
    ...server(w),
    'GET /users': () => ({ body: { items: PEOPLE_T, invitations: [] } }),
    'GET /users/permissions/catalog': () => ({ body: { roles: [], groups: [] } }),
    'GET /queues': () => ({ body: { items: [], limits: { max_queues: 20 } } }),
    'GET /users/u1': () => ({ body: full(PEOPLE_T[0]!) }),
    'GET /users/u2': () => ({ body: full(PEOPLE_T[1]!) }),
    'GET /campaigns/advisor-limits': () => ({ body: { items: [{ user_id: 'u2', daily_cap: 40, updated_at: '2026-11-16T10:00:00.000Z' }] } }),
    'PUT /campaigns/advisor-limits/u2': (c) => { puts.push(c); return { body: { user_id: 'u2', daily_cap: (c.body as { daily_cap: number }).daily_cap, updated_at: '2026-11-16T11:00:00.000Z' } }; },
  });

  it('un asesor muestra su tope guardado y se cambia aquí; un administrador no tiene tope; sin permiso de administrar al equipo o sin plan, la sección no existe', async () => {
    const puts: Call[] = [];
    mockApi(usersServer(world(), puts));
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir a Luis Navas' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Luis Navas' }));
    const section = await dlg.findByRole('region', { name: 'Campañas masivas' });
    const input = within(section).getByLabelText('Tope diario');
    await waitFor(() => expect(input).toHaveValue(40));
    await userEvent.clear(input);
    await userEvent.type(input, '25');
    await userEvent.click(within(section).getByRole('button', { name: 'Guardar tope' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ daily_cap: 25 });
    expect(await within(section).findByText('Tope guardado.')).toBeInTheDocument();
    await userEvent.click(dlg.getByRole('button', { name: 'Cerrar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir a Ana Pérez' }));
    const ana = within(await screen.findByRole('dialog', { name: 'Ana Pérez' }));
    await ana.findByRole('tab', { name: 'General' });
    expect(ana.queryByRole('region', { name: 'Campañas masivas' })).not.toBeInTheDocument();
  });

  it('sin el plan de campañas la sección no aparece en la ficha', async () => {
    mockApi(usersServer(world({ access: { ...ADMIN, plan_enabled: false } }), []));
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir a Luis Navas' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Luis Navas' }));
    await dlg.findByRole('tab', { name: 'General' });
    expect(dlg.queryByRole('region', { name: 'Campañas masivas' })).not.toBeInTheDocument();
  });
});
