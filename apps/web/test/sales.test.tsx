import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import type { ChangeRequest, RequestRow, SaleDetail, SaleOptions } from '../src/features/sales/useSales';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NOW = new Date().toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1', status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner',
    queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' }, channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
    last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW }, window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null, ...over,
  }) as Conversation;

const OPTIONS: SaleOptions = { currency: 'USD', queue: { id: 'q1', name: 'Ventas' }, products: [{ id: 'p1', name: 'Corte de cabello', kind: 'service', price: '12.50' }, { id: 'p2', name: 'Gel fijador', kind: 'product', price: '8.00' }], blocked: null };
const sale = (over: Partial<SaleDetail> = {}): SaleDetail => ({
  id: 's1', contact: { id: 'k1', name: 'Ana Torres' }, conversation_id: 'c1', product: { id: 'p1', name: 'Corte de cabello', kind: 'service' }, quantity: 2, amount: '25.00', currency: 'USD',
  paid: '10.00', balance: '15.00', collected: false, status: 'active', seller: { id: 'u2', name: 'Luis Navas' }, note: null, created_at: NOW, cancelled_at: null, cancel_reason: null, open_requests: 0, purchase: 'pending',
  payments: [{ id: 'pay1', kind: 'payment', amount: '10.00', method: 'cash', note: null, reason: null, by: { id: 'u2', name: 'Luis Navas' }, created_at: NOW }],
  history: [{ from: null, to: 'active', reason: null, by: { id: 'u2', name: 'Luis Navas' }, at: NOW }], change_requests: [], purchase_at_cancel: null,
  can: { pay: true, cancel: true, correct: true, request_change: true }, ...over,
});

interface World {
  options: SaleOptions;
  sale: SaleDetail;
  posts: Array<{ path: string; body: unknown; key: string | undefined }>;
  requests: RequestRow[];
  locked: boolean;
  failFirst?: boolean;
  currency?: string[];
}
const world = (over: Partial<World> = {}): World => ({ options: OPTIONS, sale: sale(), posts: [], requests: [], locked: false, ...over });

function server(w: World, me = ME_ADVISOR): Record<string, Handler> {
  const record = (c: Call) => w.posts.push({ path: c.path, body: c.body, key: c.headers['idempotency-key'] });
  return {
    ...authed(me),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /sales/options': () => ({ body: w.options }),
    'POST /sales': (c) => {
      record(c);
      if (w.failFirst && w.posts.length === 1) return err(500, 'INTERNAL_ERROR', 'Error interno');
      return { status: 201, body: w.sale };
    },
    'GET /sales': () => ({ body: { items: [w.sale], next_cursor: null } }),
    'GET /sales/s1': () => ({ body: w.sale }),
    'GET /sales/settings': () => ({ body: { currency: 'USD', locked: w.locked } }),
    'PUT /sales/settings': (c) => { record(c); return { body: { currency: (c.body as { currency: string }).currency, locked: false } }; },
    'GET /sales/change-requests': () => ({ body: { items: w.requests } }),
    'POST /sales/change-requests/r1/resolve': (c) => { record(c); w.requests = []; return { body: {} }; },
    'POST /sales/s1/payments': (c) => {
      record(c);
      const amount = (c.body as { amount: string }).amount;
      if (Number(amount) > Number(w.sale.balance)) return err(409, 'PAYMENT_EXCEEDS_BALANCE', 'El abono supera el saldo pendiente (15.00)');
      w.sale = sale({ paid: (Number(w.sale.paid) + Number(amount)).toFixed(2), balance: (Number(w.sale.balance) - Number(amount)).toFixed(2), collected: Number(w.sale.balance) - Number(amount) <= 0 });
      return { status: 201, body: w.sale };
    },
    'POST /sales/s1/cancel': (c) => { record(c); w.sale = sale({ status: 'cancelled', balance: '0.00', cancelled_at: NOW, cancel_reason: (c.body as { reason: string }).reason, purchase_at_cancel: 'cancelled', can: { pay: false, cancel: false, correct: false, request_change: false } }); return { body: w.sale }; },
    'POST /sales/s1/change-requests': (c) => { record(c); return { status: 201, body: {} as ChangeRequest }; },
    'POST /sales/s1/corrections': (c) => { record(c); return { status: 201, body: w.sale }; },
  };
}

const openDialog = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Registrar venta' }));
  return within(await screen.findByRole('dialog', { name: 'Registrar venta' }));
};

describe('Registrar venta desde el chat', () => {
  it('el producto sugiere el total (precio × cantidad), el abono baja el saldo y el envío lleva una llave de idempotencia', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.selectOptions(await d.findByLabelText('Producto o servicio'), 'p1');
    await userEvent.clear(d.getByLabelText('Cantidad'));
    await userEvent.type(d.getByLabelText('Cantidad'), '2');
    expect(d.getByLabelText(/Total de la venta/)).toHaveValue('25.00');
    await userEvent.type(d.getByLabelText('Abono inicial (opcional)'), '10');
    expect(d.getByText(/15,00/)).toBeInTheDocument(); // saldo por cobrar
    await userEvent.selectOptions(d.getByLabelText('Método del abono'), 'transfer');
    await userEvent.click(d.getByRole('button', { name: 'Registrar venta' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toEqual({ conversation_id: 'c1', product_id: 'p1', quantity: 2, amount: '25.00', down_payment: '10', method: 'transfer' });
    expect(w.posts[0]!.key).toMatch(/^web-/);
    expect(await screen.findByText(/Venta de .*25,00.* registrada/)).toBeInTheDocument();
    expect(screen.getByText(/Saldo por cobrar: .*15,00/)).toBeInTheDocument();
  });

  it('el total se puede ajustar; sin abono no se manda ni abono ni método', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.selectOptions(await d.findByLabelText('Producto o servicio'), 'p2');
    const total = d.getByLabelText(/Total de la venta/);
    await userEvent.clear(total);
    await userEvent.type(total, '7,5');
    await userEvent.click(d.getByRole('button', { name: 'Registrar venta' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toEqual({ conversation_id: 'c1', product_id: 'p2', quantity: 1, amount: '7.5' });
  });

  it('si el envío falla y se reintenta, se reutiliza la MISMA llave (un doble envío no duplica la venta)', async () => {
    const w = world({ failFirst: true });
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.selectOptions(await d.findByLabelText('Producto o servicio'), 'p1');
    await userEvent.click(d.getByRole('button', { name: 'Registrar venta' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    await userEvent.click(await d.findByRole('button', { name: 'Registrar venta' }));
    await waitFor(() => expect(w.posts).toHaveLength(2));
    expect(w.posts[1]!.key).toBe(w.posts[0]!.key);
  });

  it('no envía sin producto, con total inválido o con un abono mayor que el total', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/inbox/c1');
    const d = await openDialog();
    await userEvent.click(await d.findByRole('button', { name: 'Registrar venta' }));
    expect(await d.findByText('Elige el producto o servicio')).toBeInTheDocument();
    await userEvent.selectOptions(d.getByLabelText('Producto o servicio'), 'p1');
    await userEvent.type(d.getByLabelText('Abono inicial (opcional)'), '99');
    await userEvent.click(d.getByRole('button', { name: 'Registrar venta' }));
    expect(await d.findByText('El abono no puede ser mayor que el total')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
  });

  it('explica por qué no se puede vender (sin productos) y no ofrece el botón de enviar', async () => {
    mockApi(server(world({ options: { ...OPTIONS, products: [], blocked: 'no_products' } })));
    renderApp('/inbox/c1');
    const d = await openDialog();
    expect(await d.findByText(/no tiene productos o servicios activos/)).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Registrar venta' })).toBeNull();
  });

  it('quien solo colabora en la conversación no ve el botón', async () => {
    const w = world();
    const routes = server(w);
    routes['GET /conversations/c1'] = () => ({ body: conv({ my_access: 'collaborator_reply' }) });
    mockApi(routes);
    renderApp('/inbox/c1');
    await screen.findByRole('heading', { name: 'Ana Torres' });
    expect(screen.queryByRole('button', { name: 'Registrar venta' })).toBeNull();
  });
});

describe('Ventas', () => {
  it('la sección está en el menú; lista cada venta con su estado, total y saldo', async () => {
    mockApi(server(world()));
    renderApp('/sales');
    expect(await screen.findByRole('link', { name: 'Ventas' })).toHaveAttribute('href', '/sales');
    const item = await screen.findByRole('button', { name: 'Abrir la venta de Ana Torres' });
    expect(within(item).getByText('Con saldo')).toBeInTheDocument();
    expect(item).toHaveTextContent(/25,00/);
    expect(item).toHaveTextContent(/saldo .*15,00/);
  });

  it('un abono se registra con llave; el que se pasa del saldo muestra el aviso del servidor; el asesor no ve «Anular» sino «Pedir corrección»', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/sales');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la venta de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Venta' }));
    expect((await d.findAllByText('Efectivo')).length).toBeGreaterThan(0);
    expect(d.queryByRole('button', { name: 'Anular venta' })).toBeNull();
    await userEvent.type(d.getByLabelText('Abono'), '99');
    await userEvent.click(d.getByRole('button', { name: 'Registrar abono' }));
    expect(await d.findByText(/El abono supera el saldo pendiente/)).toBeInTheDocument();
    await userEvent.clear(d.getByLabelText('Abono'));
    await userEvent.type(d.getByLabelText('Abono'), '5');
    await userEvent.click(d.getByRole('button', { name: 'Registrar abono' }));
    expect(await d.findByText('Abono registrado')).toBeInTheDocument();
    const ok = w.posts.filter((p) => p.path === '/sales/s1/payments');
    expect(ok.map((p) => p.body)).toEqual([{ amount: '99', method: 'cash' }, { amount: '5', method: 'cash' }]);
    expect(ok.every((p) => /^web-/.test(p.key ?? ''))).toBe(true);
    expect(ok[1]!.key).not.toBe(ok[0]!.key); // cada abono es una operación distinta
    await userEvent.click(d.getByRole('button', { name: 'Pedir corrección' }));
    await userEvent.click(d.getByRole('button', { name: 'Enviar solicitud' }));
    expect(await d.findByText('Escribe el motivo')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Qué hay que corregir'), 'El total es 30');
    await userEvent.click(d.getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/sales/s1/change-requests', body: { reason: 'El total es 30' } }));
  });

  it('la venta cobrada ya no ofrece registrar abonos', async () => {
    mockApi(server(world({ sale: sale({ paid: '25.00', balance: '0.00', collected: true, can: { pay: false, cancel: true, correct: true, request_change: true } }) })));
    renderApp('/sales');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la venta de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Venta' }));
    await d.findByText('Abonos');
    expect(d.queryByRole('button', { name: 'Registrar abono' })).toBeNull();
  });

  it('el administrador anula con motivo; la venta anulada muestra qué pasó con el evento de compra y deja de admitir abonos', async () => {
    const w = world();
    mockApi(server(w, ME_ADMIN));
    renderApp('/sales');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir la venta de Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Venta' }));
    await userEvent.click(await d.findByRole('button', { name: 'Anular venta' }));
    await userEvent.click(d.getByRole('button', { name: 'Anular venta' }));
    expect(await d.findByText('Escribe el motivo')).toBeInTheDocument();
    await userEvent.type(d.getByLabelText('Motivo'), 'El cliente se arrepintió');
    await userEvent.click(d.getByRole('button', { name: 'Anular venta' }));
    expect(await d.findByText(/Anulada el .*El cliente se arrepintió/)).toBeInTheDocument();
    expect(d.getByText(/se canceló antes de llegar a Meta/)).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Registrar abono' })).toBeNull();
    expect(w.posts.at(-1)).toMatchObject({ path: '/sales/s1/cancel', body: { reason: 'El cliente se arrepintió' } });
  });

  it('el administrador ve las solicitudes de corrección abiertas y las resuelve; la moneda se cambia solo sin ventas', async () => {
    const req: RequestRow = { id: 'r1', sale_id: 's1', reason: 'El total es 30', status: 'open', requested_by: { id: 'u2', name: 'Luis Navas' }, resolved_by: null, resolution_note: null, created_at: NOW, resolved_at: null, sale: { id: 's1', contact: 'Ana Torres', amount: '25.00', currency: 'USD' } };
    const w = world({ requests: [req], locked: true });
    mockApi(server(w, ME_ADMIN));
    renderApp('/sales');
    const panel = within(await screen.findByRole('region', { name: 'Solicitudes de corrección abiertas' }));
    expect(panel.getByText(/El total es 30/)).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Moneda de la empresa' })).toBeDisabled();
    expect(screen.getByText(/Ya hay ventas: no se puede cambiar/)).toBeInTheDocument();
    await userEvent.click(panel.getByRole('button', { name: 'Marcar resuelta la solicitud de Ana Torres' }));
    await waitFor(() => expect(w.posts.at(-1)).toMatchObject({ path: '/sales/change-requests/r1/resolve', body: { status: 'resolved' } }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Solicitudes de corrección abiertas' })).toBeNull());
  });

  it('el asesor no ve el panel de solicitudes ni el selector de moneda', async () => {
    mockApi(server(world({ requests: [] })));
    renderApp('/sales');
    await screen.findByRole('button', { name: 'Abrir la venta de Ana Torres' });
    expect(screen.queryByRole('combobox', { name: 'Moneda de la empresa' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Solicitudes de corrección abiertas' })).toBeNull();
  });
});
