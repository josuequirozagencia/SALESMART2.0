import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Campaign, CampaignAccessInfo, GeneratedVariants } from '../src/features/campaigns/useCampaigns';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v17 · variantes del mensaje con IA (solo por WhatsApp QR; ADR-72): generar, revisar, editar, quitar y guardar con la campaña.

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ADMIN: CampaignAccessInfo = { plan_enabled: true, read: true, send: true, view_all: true, manage_limits: true, manage_settings: true, cancel_others: true };
const OPTIONS = {
  channels: [{ id: 'c-off', name: 'Ventas', kind: 'official' }, { id: 'c-qr', name: 'Chip QR', kind: 'qr' }],
  limits: { official_daily_cap: 1000, qr_min_gap_seconds: 45, official_min_gap_seconds: 5, advisor_daily_cap: null, max_audience: 5000 },
};
const TEXT = 'Hola {{primer_nombre}}, tenemos cupos esta semana.';
const GENERATED = ['Buen día {{primer_nombre}}, esta semana hay cupos.', '{{primer_nombre}}, te cuento que tenemos cupos esta semana.', 'Qué tal {{primer_nombre}}: abrimos cupos esta semana.'];
const DRAFT: Campaign = {
  id: 'cmp1', name: 'Con versiones', status: 'draft', status_reason: null, mode: 'text', channel: { id: 'c-qr', name: 'Chip QR', kind: 'qr' }, template_id: null, template_params: {}, body: TEXT, body_variants: ['Otra forma de decirlo {{primer_nombre}}.'],
  audience: { source: 'all' }, include_unknown_consent: false, scheduled_at: null, gap_seconds: 60, daily_cap: 50, created_by: { id: 'u1', name: 'Ana Pérez' }, created_at: '2026-11-16T10:00:00.000Z', updated_at: '2026-11-16T10:00:00.000Z',
  launched_at: null, finished_at: null, counts: { total: 0, by_status: {}, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 }, can_edit: true, can_pause: false, can_resume: false, can_cancel: false,
};

interface World { items: Campaign[]; generates: Call[]; creates: Call[]; updates: Call[]; launches: Call[] }
const world = (over: Partial<World> = {}): World => ({ items: [], generates: [], creates: [], updates: [], launches: [], ...over });

function server(w: World, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: [] } }),
    'GET /campaigns/access': () => ({ body: ADMIN }),
    'GET /campaigns/options': () => ({ body: OPTIONS }),
    'GET /campaigns': () => ({ body: { items: w.items, next_cursor: null } }),
    'GET /campaigns/settings': () => ({ body: { official_daily_cap: 1000, default_cap: 1000 } }),
    'GET /campaigns/channels/c-off/templates': () => ({ body: { items: [] } }),
    'POST /campaigns/preview': () => ({ body: { campaign_id: null, audience: { in_scope: 2, out_of_scope: 0, eligible: 2, skipped: { revoked: 0, excluded: 0, no_phone: 0, no_consent: 0, duplicate: 0 }, sample: [] }, limits: { channel_kind: 'qr', daily_cap: 50, channel_cap: 175, advisor_cap: null, min_gap_seconds: 45 }, estimate: { days: 1, first_day_minutes: 1 }, message: null, warnings: ['qr_unofficial_risk'] } }),
    'POST /campaigns/audience': () => ({ body: { items: [], total: 0, next_cursor: null } }),
    'POST /campaigns/variants': (c) => {
      w.generates.push(c);
      const b = c.body as { count: number };
      const body: GeneratedVariants = { variants: GENERATED.slice(0, b.count), requested: b.count, rejected: 2, credits_used: 3, remaining_today: 19 };
      return { body };
    },
    'POST /campaigns': (c) => { w.creates.push(c); return { status: 201, body: { ...DRAFT, id: 'cmp9', body_variants: (c.body as { body_variants?: string[] }).body_variants ?? [] } }; },
    'PATCH /campaigns/cmp1': (c) => { w.updates.push(c); return { body: { ...DRAFT, ...(c.body as object) } }; },
    'POST /campaigns/cmp1/launch': (c) => { w.launches.push(c); return { status: 201, body: { ...DRAFT, status: 'running', can_edit: false } }; },
    ...extra,
  };
}

async function openQrForm(w: World, extra: Record<string, Handler> = {}) {
  mockApi(server(w, extra));
  renderApp('/campaigns');
  const form = await screen.findByRole('form', { name: 'Nueva campaña' });
  await userEvent.selectOptions(await within(form).findByRole('combobox', { name: 'Conexión' }), 'c-qr');
  const area = within(form).getByRole('textbox', { name: 'Mensaje' });
  await userEvent.clear(area);
  await userEvent.click(area);
  await userEvent.paste(TEXT);
  return form;
}

describe('versiones del mensaje con IA', () => {
  it('por QR: genera versiones con el texto y la cantidad pedidos, las muestra para revisarlas (editar, quitar) y las guarda con la campaña; las vacías no se mandan', async () => {
    const w = world();
    const form = await openQrForm(w);
    const section = within(within(form).getByRole('region', { name: 'Versiones del mensaje' }));
    expect(section.getByText(/Escríbelo una vez. La IA crea versiones distintas/)).toBeInTheDocument();
    await userEvent.clear(section.getByRole('spinbutton', { name: 'Cantidad' }));
    await userEvent.type(section.getByRole('spinbutton', { name: 'Cantidad' }), '3');
    await userEvent.click(section.getByRole('button', { name: 'Generar versiones' }));
    await waitFor(() => expect(w.generates).toHaveLength(1));
    expect(w.generates[0]!.body).toEqual({ text: TEXT, count: 3 });
    expect(await section.findByText(/Se agregaron 3 versiones \(usó 3 créditos; se descartaron 2 que no respetaban tu mensaje\)\. Revísalas antes de enviar\./)).toBeInTheDocument();
    expect(section.getByRole('textbox', { name: 'Versión 2' })).toHaveValue(GENERATED[0]);
    expect(section.getByRole('textbox', { name: 'Versión 4' })).toHaveValue(GENERATED[2]);
    expect(section.getByText('Cada contacto recibirá una de las 4 versiones (la principal y 3 más).')).toBeInTheDocument();
    // la persona las revisa: edita una, quita otra y agrega una vacía que no debe mandarse
    const v3 = section.getByRole('textbox', { name: 'Versión 3' });
    await userEvent.clear(v3);
    await userEvent.type(v3, 'Mi versión propia');
    await userEvent.click(section.getByRole('button', { name: 'Quitar versión 2' }));
    expect(section.getByRole('textbox', { name: 'Versión 2' })).toHaveValue('Mi versión propia');
    await userEvent.click(section.getByRole('button', { name: '+ Escribir versión' }));
    expect(section.getByRole('textbox', { name: 'Versión 4' })).toHaveValue('');
    await userEvent.type(within(form).getByLabelText(/1 · Nombre/), 'Cupos con versiones');
    await userEvent.click(within(form).getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(w.creates).toHaveLength(1));
    expect(w.creates[0]!.body).toMatchObject({ mode: 'text', body: TEXT, body_variants: ['Mi versión propia', GENERATED[2]] });
  });

  it('no se ofrece por WhatsApp oficial (solo plantillas) y sin texto no se puede generar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    const form = await screen.findByRole('form', { name: 'Nueva campaña' });
    await within(form).findByRole('combobox', { name: 'Conexión' });
    expect(within(form).queryByRole('region', { name: 'Versiones del mensaje' })).not.toBeInTheDocument(); // la conexión elegida por omisión es la oficial
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Conexión' }), 'c-qr');
    const section = within(await within(form).findByRole('region', { name: 'Versiones del mensaje' }));
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Mensaje' }));
    expect(section.getByRole('button', { name: 'Generar versiones' })).toBeDisabled();
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Conexión' }), 'c-off');
    expect(within(form).queryByRole('region', { name: 'Versiones del mensaje' })).not.toBeInTheDocument();
  });

  it('el límite es de 10 versiones: la cantidad pedida se ajusta a lo que queda y al llegar a 10 no se puede pedir más', async () => {
    const w = world({ items: [{ ...DRAFT, body_variants: Array.from({ length: 8 }, (_, i) => `Versión escrita ${i} {{primer_nombre}}`) }] });
    mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: /Editar Con versiones/ }));
    const form = await screen.findByRole('form', { name: 'Editar campaña' });
    const section = within(within(form).getByRole('region', { name: 'Versiones del mensaje' }));
    const qty = section.getByRole('spinbutton', { name: 'Cantidad' });
    expect(qty).toHaveAttribute('max', '2'); // quedan 2 lugares
    await userEvent.click(section.getByRole('button', { name: 'Generar versiones' }));
    await waitFor(() => expect(w.generates).toHaveLength(1));
    expect((w.generates[0]!.body as { count: number }).count).toBe(2);
    await section.findByText(/Se agregaron 2 versiones/);
    expect(section.getByText('Llegaste al máximo de 10 versiones.')).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Generar versiones' })).toBeDisabled();
    expect(section.getByRole('button', { name: '+ Escribir versión' })).toBeDisabled();
  });

  it('si la IA no está disponible, no hay créditos o se llegó al tope, el motivo se muestra y lo escrito no se pierde', async () => {
    const w = world();
    let reply: ReturnType<typeof err> = err(409, 'AI_NO_CREDITS', 'No hay créditos suficientes para esta operación');
    const form = await openQrForm(w, { 'POST /campaigns/variants': () => reply });
    const section = within(within(form).getByRole('region', { name: 'Versiones del mensaje' }));
    await userEvent.click(section.getByRole('button', { name: 'Generar versiones' }));
    expect(await section.findByRole('alert')).toHaveTextContent('No hay créditos suficientes para esta operación');
    reply = err(409, 'VARIANTS_DAILY_LIMIT', 'Hoy ya pediste versiones 20 veces. Puedes escribir las tuyas o volver mañana');
    await userEvent.click(section.getByRole('button', { name: 'Generar versiones' }));
    await waitFor(() => expect(section.getByRole('alert')).toHaveTextContent('Hoy ya pediste versiones 20 veces'));
    reply = err(503, 'AI_NOT_CONFIGURED', 'La generación con IA aún no está configurada. Avisa al administrador de la plataforma');
    await userEvent.click(section.getByRole('button', { name: 'Generar versiones' }));
    await waitFor(() => expect(section.getByRole('alert')).toHaveTextContent('aún no está configurada'));
    expect(within(form).getByRole('textbox', { name: 'Mensaje' })).toHaveValue(TEXT); // el mensaje escrito sigue ahí
  });

  it('al editar un borrador aparecen sus versiones guardadas; el envío dice cuántas versiones salen', async () => {
    const w = world({ items: [DRAFT] });
    mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: /Editar Con versiones/ }));
    const form = await screen.findByRole('form', { name: 'Editar campaña' });
    const section = within(within(form).getByRole('region', { name: 'Versiones del mensaje' }));
    expect(section.getByRole('textbox', { name: 'Versión 2' })).toHaveValue('Otra forma de decirlo {{primer_nombre}}.');
    await userEvent.click(within(form).getByRole('button', { name: 'Enviar campaña' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Enviar campaña' }));
    expect(await dlg.findByText('Cada contacto recibirá una de las 2 versiones del mensaje.')).toBeInTheDocument();
    expect(w.updates[0]!.body).toMatchObject({ body_variants: ['Otra forma de decirlo {{primer_nombre}}.'] });
  });
});
