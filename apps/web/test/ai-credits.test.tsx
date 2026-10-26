import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOrg, AiOrgList, CreditsPage, LedgerItem, PlatformLedgerItem } from '../src/features/ai/useAiCredits';
import { authed, err, ME_ADMIN, ME_ROOT, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const ORG_A = 'a0000000-0000-4000-8000-0000000000a1';
const ORG_B = 'b0000000-0000-4000-8000-0000000000b2';
const AT = '2026-10-26T15:00:00.000Z';

const item = (over: Partial<LedgerItem> = {}): LedgerItem => ({ id: 'l1', kind: 'welcome', credits: 1000, balance_after: 1000, ref: 'Créditos de bienvenida', created_at: AT, ...over });
const page = (over: Partial<CreditsPage> = {}): CreditsPage => ({ balance: 1000, held: 0, available: 1000, items: [item()], next_cursor: null, ...over });

describe('Configuración › Créditos IA (cliente)', () => {
  it('muestra saldo, apartado y disponible y los movimientos; nunca costo, margen ni proveedor', async () => {
    const p = page({ balance: 986, held: 100, available: 886, items: [item({ id: 'l2', kind: 'use', credits: -14, balance_after: 986, ref: 'Agente de ventas' }), item({ id: 'l3', kind: 'grant', credits: 500, balance_after: 1000, ref: 'Regalo del piloto' }), item()] });
    mockApi({ ...authed(ME_ADMIN), 'GET /ai/credits': () => ({ body: p }) });
    const { container } = renderApp('/settings/credits');
    const section = within(await screen.findByRole('region', { name: 'Créditos IA' }));
    expect(await section.findByText('986')).toBeInTheDocument();
    expect(section.getByText('Apartado ahora').nextSibling).toHaveTextContent('100');
    expect(section.getByText('Disponible').nextSibling).toHaveTextContent('886');
    const list = within(section.getByRole('list', { name: 'Movimientos de créditos' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(list.getByText('Agente de ventas')).toBeInTheDocument();
    expect(list.getByText('Regalo del piloto')).toBeInTheDocument();
    expect(list.getByText('Uso')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/margen|costo|openai|USD/i);
    expect(screen.getByRole('link', { name: 'Créditos IA' })).toHaveAttribute('href', '/settings/credits');
  });

  it('sin créditos disponibles avisa que los agentes se pausarán', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /ai/credits': () => ({ body: page({ balance: 0, available: 0, items: [] }) }) });
    renderApp('/settings/credits');
    expect(await screen.findByText(/los agentes de IA se pausarán/)).toBeInTheDocument();
    expect(screen.getByText('Aún no hay movimientos.')).toBeInTheDocument();
  });

  it('«Ver más movimientos» pide la página siguiente con su cursor', async () => {
    const seen: string[] = [];
    mockApi({
      ...authed(ME_ADMIN),
      'GET /ai/credits': (c: Call) => {
        seen.push(c.query.get('cursor') ?? '');
        return c.query.get('cursor') ? { body: page({ items: [item({ id: 'old', ref: 'Antiguo' })], next_cursor: null }) } : { body: page({ items: [item({ id: 'new', kind: 'grant', credits: 5, ref: 'Reciente' })], next_cursor: 'CUR1' }) };
      },
    });
    renderApp('/settings/credits');
    await userEvent.click(await screen.findByRole('button', { name: 'Ver más movimientos' }));
    expect(await screen.findByText('Antiguo')).toBeInTheDocument();
    expect(screen.getByText('Reciente')).toBeInTheDocument();
    expect(seen).toEqual(['', 'CUR1']);
    expect(screen.queryByRole('button', { name: 'Ver más movimientos' })).toBeNull();
  });

  it('si el servidor lo niega (sin permiso) muestra el motivo sin romper la pantalla', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /ai/credits': () => err(403, 'FORBIDDEN', 'No tienes permiso') });
    renderApp('/settings/credits');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Plataforma › Créditos IA (Súper Admin)', () => {
  const org = (over: Partial<AiOrg> = {}): AiOrg => ({ id: ORG_A, name: 'Barbería Norte', state: 'trial', balance: 1000, held: 0, granted: 1000, used: 0, margin_pct: '100.00', margin_override: false, ...over });
  interface World { orgs: AiOrg[]; pricing: { usd_per_credit: string; global_margin_pct: string; updated_at: string }; calls: Record<string, Call[]>; ledger: PlatformLedgerItem[]; grantFails?: () => ReturnType<Handler> }
  const world = (over: Partial<World> = {}): World => ({ orgs: [org(), org({ id: ORG_B, name: 'Estudio Luna', balance: 0, granted: 0 })], pricing: { usd_per_credit: '0.010000', global_margin_pct: '100.00', updated_at: AT }, calls: {}, ledger: [], ...over });
  const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };
  function server(w: World): Record<string, Handler> {
    return {
      ...authed(ME_ROOT),
      'GET /platform/trials': () => ({ body: NO_TRIALS }),
      'GET /platform/ai/organizations': (c) => { rec(w, 'list', c); const q = c.query.get('q')?.toLowerCase(); return { body: { items: w.orgs.filter((o) => !q || o.name.toLowerCase().includes(q)), next_cursor: null, pricing: w.pricing } satisfies AiOrgList }; },
      'PUT /platform/ai/pricing': (c) => { rec(w, 'pricing', c); const b = c.body as { usd_per_credit: string; global_margin_pct: string }; w.pricing = { ...w.pricing, usd_per_credit: Number(b.usd_per_credit).toFixed(6), global_margin_pct: Number(b.global_margin_pct).toFixed(2) }; return { body: w.pricing }; },
      [`PUT /platform/ai/organizations/${ORG_A}/margin`]: (c) => { rec(w, 'margin', c); const m = (c.body as { margin_pct: string | null }).margin_pct; w.orgs = w.orgs.map((o) => (o.id === ORG_A ? { ...o, margin_pct: m ?? w.pricing.global_margin_pct, margin_override: m !== null } : o)); return { body: { id: ORG_A, margin_pct: m ?? '100.00', margin_override: m !== null } }; },
      [`POST /platform/ai/organizations/${ORG_A}/grants`]: (c) => {
        rec(w, 'grant', c);
        if (w.grantFails) return w.grantFails();
        const b = c.body as { credits: number; note: string };
        w.orgs = w.orgs.map((o) => (o.id === ORG_A ? { ...o, balance: o.balance + b.credits, granted: o.granted + b.credits } : o));
        return { status: 201, body: { item: item({ id: 'g1', kind: 'grant', credits: b.credits, ref: b.note }), balance: w.orgs[0]!.balance, replayed: false } };
      },
      [`GET /platform/ai/organizations/${ORG_A}/ledger`]: () => ({ body: { balance: 1000, held: 0, available: 1000, items: w.ledger, next_cursor: null } }),
    };
  }
  const row = async (name: string) => within(within(await screen.findByRole('table', { name: 'Créditos por empresa' })).getByRole('rowheader', { name }).closest('tr')!);

  it('lista las empresas con su saldo y margen, y la pestaña está en el menú de plataforma', async () => {
    mockApi(server(world({ orgs: [org({ balance: 1234, held: 10, granted: 2000, used: 766, margin_pct: '25.50', margin_override: true }), org({ id: ORG_B, name: 'Estudio Luna', balance: 0, granted: 0 })] })));
    renderApp('/platform/ai');
    const a = await row('Barbería Norte');
    expect(a.getByText('1.234')).toBeInTheDocument();
    expect(a.getByText(/25,5|25.5/)).toBeInTheDocument();
    expect(a.getByText('propio')).toBeInTheDocument();
    const b = await row('Estudio Luna');
    expect(b.queryByText('propio')).toBeNull();
    expect(screen.getByRole('link', { name: 'Créditos IA' })).toHaveAttribute('href', '/platform/ai');
  });

  it('guarda el precio y el margen global; valida antes de enviar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/platform/ai');
    const form = within(await screen.findByRole('form', { name: 'Precio de los créditos' }));
    expect(form.getByLabelText('Valor de un crédito (USD)')).toHaveValue('0.01');
    expect(form.getByLabelText('Margen global (%)')).toHaveValue('100');
    await userEvent.clear(form.getByLabelText('Valor de un crédito (USD)'));
    await userEvent.type(form.getByLabelText('Valor de un crédito (USD)'), '0');
    await userEvent.click(form.getByRole('button', { name: 'Guardar precio' }));
    expect(await form.findByRole('alert')).toHaveTextContent(/mayor que 0/);
    expect(w.calls['pricing']).toBeUndefined();
    await userEvent.clear(form.getByLabelText('Valor de un crédito (USD)'));
    await userEvent.type(form.getByLabelText('Valor de un crédito (USD)'), '0.02');
    await userEvent.clear(form.getByLabelText('Margen global (%)'));
    await userEvent.type(form.getByLabelText('Margen global (%)'), '150.5');
    await userEvent.click(form.getByRole('button', { name: 'Guardar precio' }));
    await waitFor(() => expect(w.calls['pricing']![0]!.body).toEqual({ usd_per_credit: '0.02', global_margin_pct: '150.5' }));
    expect(await form.findByText('Precio guardado.')).toBeInTheDocument();
  });

  it('regalar créditos: valida, manda la llave de idempotencia y muestra el saldo nuevo; el mismo envío repetido usa la misma llave', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/platform/ai');
    await userEvent.click(await screen.findByRole('button', { name: 'Regalar créditos a Barbería Norte' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Regalar créditos a Barbería Norte' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Regalar' }));
    expect(await dlg.findByRole('alert')).toHaveTextContent(/entero/);
    await userEvent.type(dlg.getByLabelText('Créditos'), '500');
    await userEvent.click(dlg.getByRole('button', { name: 'Regalar' }));
    expect(await dlg.findByRole('alert')).toHaveTextContent(/motivo/);
    expect(w.calls['grant']).toBeUndefined();
    await userEvent.type(dlg.getByLabelText('Motivo'), 'Regalo del piloto');
    await userEvent.click(dlg.getByRole('button', { name: 'Regalar' }));
    await waitFor(() => expect(w.calls['grant']).toHaveLength(1));
    expect(w.calls['grant']![0]!.body).toEqual({ credits: 500, note: 'Regalo del piloto' });
    expect(w.calls['grant']![0]!.headers['idempotency-key']).toMatch(/^web-/);
    expect(await dlg.findByText(/ahora es de 1\.500 créditos/)).toBeInTheDocument();
  });

  it('un error al regalar se muestra y un reintento con los mismos datos reutiliza la misma llave', async () => {
    const w = world({ grantFails: () => err(503, 'SERVICE_UNAVAILABLE', 'Servicio no disponible') });
    mockApi(server(w));
    renderApp('/platform/ai');
    await userEvent.click(await screen.findByRole('button', { name: 'Regalar créditos a Barbería Norte' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Regalar créditos a Barbería Norte' }));
    await userEvent.type(dlg.getByLabelText('Créditos'), '50');
    await userEvent.type(dlg.getByLabelText('Motivo'), 'Reposición');
    await userEvent.click(dlg.getByRole('button', { name: 'Regalar' }));
    expect(await dlg.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(dlg.getByRole('button', { name: 'Regalar' }));
    await waitFor(() => expect(w.calls['grant']).toHaveLength(2));
    expect(w.calls['grant']![1]!.headers['idempotency-key']).toBe(w.calls['grant']![0]!.headers['idempotency-key']);
  });

  it('margen propio: guardar, y «Usar el global» lo quita', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/platform/ai');
    await userEvent.click(await screen.findByRole('button', { name: 'Margen de Barbería Norte' }));
    let dlg = within(await screen.findByRole('dialog', { name: 'Margen de Barbería Norte' }));
    expect(dlg.queryByRole('button', { name: 'Usar el global' })).toBeNull();
    await userEvent.clear(dlg.getByLabelText('Margen propio (%)'));
    await userEvent.type(dlg.getByLabelText('Margen propio (%)'), '40');
    await userEvent.click(dlg.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls['margin']![0]!.body).toEqual({ margin_pct: '40' }));
    expect(await (await row('Barbería Norte')).findByText('propio')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Margen de Barbería Norte' }));
    dlg = within(await screen.findByRole('dialog', { name: 'Margen de Barbería Norte' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Usar el global' }));
    await waitFor(() => expect(w.calls['margin']![1]!.body).toEqual({ margin_pct: null }));
    await waitFor(async () => expect((await row('Barbería Norte')).queryByText('propio')).toBeNull());
  });

  it('el libro de la empresa muestra costo y margen (solo aquí, en plataforma)', async () => {
    const w = world({ ledger: [{ ...item({ id: 'u1', kind: 'use', credits: -14, balance_after: 986, ref: 'Agente de ventas' }), cost_usd: '0.070000', margin_pct: '100.00', created_by: 'u9' }, { ...item(), cost_usd: null, margin_pct: null, created_by: null }] });
    mockApi(server(w));
    renderApp('/platform/ai');
    await userEvent.click(await screen.findByRole('button', { name: 'Movimientos de Barbería Norte' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Movimientos de Barbería Norte' }));
    expect(await dlg.findByText(/costo 0.070000 USD · margen 100.00 %/)).toBeInTheDocument();
    expect(dlg.getAllByRole('listitem')).toHaveLength(2);
  });

  it('buscar una empresa filtra la lista', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/platform/ai');
    await row('Estudio Luna');
    await userEvent.type(screen.getByLabelText('Buscar empresa'), 'luna');
    await waitFor(() => expect(w.calls['list']!.some((c) => c.query.get('q') === 'luna')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: 'Barbería Norte' })).toBeNull());
  });
});
