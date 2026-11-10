import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inkFor } from '../src/lib/color';
import type { Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { authed, ME_ADVISOR, err, mockApi, renderApp, resetWorld, type Handler } from './helpers';

function stubWidth(width: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return { matches, media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
});
afterEach(() => vi.unstubAllGlobals());

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  status: 'working',
  unread_count: 0,
  last_message_at: ago(5 * MIN),
  last_inbound_at: ago(60 * MIN),
  assigned_at: ago(120 * MIN),
  closed_at: null,
  created_at: ago(180 * MIN),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
  owner: { id: 'u2', name: 'Luis Navas' },
  participants: [],
  my_access: 'owner',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola, ¿tienen cita mañana?', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * 60 * MIN).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
  sla: null,
  ...over,
});
const OPTIONS: InboxOptions = {
  queues: [{ id: 'q1', name: 'Ventas', color: '#7c5cfa' }],
  channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }],
  owners: [],
  tags: [{ id: 't1', name: 'Lead', color: '#6a44f2', system_key: 'lead', is_system: true }],
};
const tag = (id: string, name: string, color: string) => ({ id, name, color, system_key: null, is_system: false });

function routes(items: Conversation[], extra: Record<string, Handler> = {}): { routes: Record<string, Handler>; listCalls: URLSearchParams[] } {
  const listCalls: URLSearchParams[] = [];
  return {
    listCalls,
    routes: {
      ...authed(ME_ADVISOR),
      'GET /conversations': (call) => {
        listCalls.push(call.query);
        return { body: { items, next_cursor: null, counts: { working: items.length, pending: 2, closed: 0, unread: 1 } } satisfies ConversationList };
      },
      'GET /conversations/options': () => ({ body: OPTIONS }),
      ...extra,
    },
  };
}

describe('color legible sobre el color de una etiqueta', () => {
  it('texto oscuro sobre pasteles y blanco sobre colores oscuros; un color inválido da blanco', () => {
    expect(inkFor('#CFE2FB')).toBe('#14153a');
    expect(inkFor('#fde68a')).toBe('#14153a');
    expect(inkFor('#6a44f2')).toBe('#ffffff');
    expect(inkFor('#0b7a6b')).toBe('#ffffff');
    expect(inkFor('#fff')).toBe('#14153a');
    expect(inkFor('rojo')).toBe('#ffffff');
  });
});

describe('Inbox · lista móvil (< 768 px)', () => {
  it('cabecera compacta: título, modo oscuro, programados, buscador, filtros, pestañas con conteos y la barra inferior visible', async () => {
    stubWidth(390);
    mockApi(routes([conv()]).routes);
    renderApp('/inbox');
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    const list = within(screen.getByRole('region', { name: 'Conversaciones' }));
    expect(list.getByRole('searchbox', { name: 'Buscar conversaciones' })).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Filtros' })).toBeInTheDocument();
    expect(list.getByRole('link', { name: 'Mensajes programados de todas las conversaciones' })).toBeInTheDocument();
    expect(list.getAllByRole('button', { name: 'Cambiar a modo oscuro' }).length).toBeGreaterThan(0);
    const tabs = within(list.getByRole('tablist', { name: 'Estado de las conversaciones' }));
    await waitFor(() => expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Trabajando1', 'Esperando2', 'Finalizadas0']));
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('el botón de filtros abre una hoja inferior con los mismos filtros; Esc la cierra y devuelve el foco', async () => {
    stubWidth(390);
    mockApi(routes([conv()]).routes);
    renderApp('/inbox');
    const open = await screen.findByRole('button', { name: 'Filtros' });
    await userEvent.click(open);
    const sheet = await screen.findByRole('dialog', { name: 'Filtros' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByRole('combobox', { name: 'Departamento' })).toBeInTheDocument();
    expect(within(sheet).getByRole('combobox', { name: 'Tiempo de respuesta' })).toBeInTheDocument();
    expect(within(sheet).getByRole('checkbox', { name: 'Solo no leídas' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filtros' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Filtros' })).toHaveFocus();
  });

  it('un filtro puesto desde la hoja se pide al servidor y el botón lo cuenta', async () => {
    stubWidth(390);
    const w = routes([conv()]);
    mockApi(w.routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('button', { name: 'Filtros' }));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Tiempo de respuesta' }), 'late');
    await waitFor(() => expect(w.listCalls.some((q) => q.get('sla') === 'late')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Ver conversaciones' }));
    expect(await screen.findByRole('button', { name: 'Filtros (1 activos)' })).toBeInTheDocument();
  });

  it('«No leídas» ya no está en la barra de pestañas: queda solo con Trabajando, Esperando y Finalizadas', async () => {
    stubWidth(390);
    mockApi(routes([conv()]).routes);
    renderApp('/inbox');
    const tabs = within(await screen.findByRole('tablist', { name: 'Estado de las conversaciones' }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Trabajando', 'Esperando', 'Finalizadas']);
    expect(screen.queryByRole('button', { name: /No leídas/ })).not.toBeInTheDocument();
  });

  it('los accesos rápidos del panel de filtros: «No leídas» cambia el mismo estado que el checkbox, «Recientes» se marca y se cuenta, y «Destacadas» espera su decisión', async () => {
    stubWidth(390);
    const w = routes([conv()]);
    mockApi(w.routes);
    renderApp('/inbox');
    await userEvent.click(await screen.findByRole('button', { name: 'Filtros' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Filtros' }));
    const quick = within(sheet.getByRole('group', { name: 'Accesos rápidos' }));
    const unread = quick.getByRole('button', { name: /No leídas/ });
    expect(unread).toHaveAttribute('aria-pressed', 'false');
    expect(sheet.getByRole('checkbox', { name: 'Solo no leídas' })).not.toBeChecked();
    await userEvent.click(unread);
    await waitFor(() => expect(w.listCalls.some((q) => q.get('unread') === '1')).toBe(true));
    expect(quick.getByRole('button', { name: /No leídas/ })).toHaveAttribute('aria-pressed', 'true');
    expect(sheet.getByRole('checkbox', { name: 'Solo no leídas' })).toBeChecked();
    await userEvent.click(sheet.getByRole('checkbox', { name: 'Solo no leídas' }));
    await waitFor(() => expect(quick.getByRole('button', { name: /No leídas/ })).toHaveAttribute('aria-pressed', 'false'));
    const recent = quick.getByRole('button', { name: 'Recientes' });
    await userEvent.click(recent);
    expect(quick.getByRole('button', { name: 'Recientes' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(sheet.getByRole('button', { name: 'Ver conversaciones' }));
    expect(await screen.findByRole('button', { name: 'Filtros (1 activos)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filtros (1 activos)' }));
    const fav = within(await screen.findByRole('dialog', { name: 'Filtros' })).getByRole('button', { name: /Destacadas/ });
    expect(fav).toBeDisabled();
    expect(fav).toHaveTextContent('Próximamente');
  });

  it('«Recientes» deja solo las conversaciones con un mensaje en las últimas 24 h', async () => {
    stubWidth(390);
    mockApi(routes([conv({ id: 'c1' }), conv({ id: 'c2', contact: { id: 'k2', name: 'Vieja Díaz', phone: null }, last_message_at: ago(30 * 60 * MIN) })]).routes);
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Vieja Díaz' });
    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Filtros' })).getByRole('button', { name: 'Recientes' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Vieja Díaz' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toBeInTheDocument();
  });

  it('filas: no leída con su conteo, estado de entrega con texto, máximo 2 etiquetas más «+n», y marcas de QR y de GoHighLevel', async () => {
    stubWidth(390);
    const items = [
      conv({ id: 'c1', unread_count: 3, tags: [tag('a', 'Lead', '#6a44f2'), tag('b', 'VIP', '#fde68a'), tag('c', 'Moroso', '#ef4444')], channel: { id: 'ch2', name: 'Línea QR', state: 'active', kind: 'qr' } }),
      conv({ id: 'c2', contact: { id: 'k2', name: 'Beto Luna', phone: '+593991112233' }, last_message: { direction: 'out', kind: 'text', preview: 'Listo, te espero', status: 'read', at: ago(MIN) }, channel: { id: 'ch3', name: 'GHL', state: 'active', kind: 'ghl' } }),
      conv({ id: 'c3', contact: { id: 'k3', name: 'Caro Díaz', phone: null }, last_message: { direction: 'out', kind: 'text', preview: 'No salió', status: 'failed', at: ago(MIN) } }),
    ];
    mockApi(routes(items).routes);
    renderApp('/inbox');
    const ana = await screen.findByRole('link', { name: 'Ana Torres, 3 sin leer' });
    expect(within(ana).getByText('QR')).toBeInTheDocument();
    expect(screen.queryByText(/no oficial/)).not.toBeInTheDocument();
    expect(within(ana).getByText('Lead')).toBeInTheDocument();
    expect(within(ana).getByText('VIP')).toBeInTheDocument();
    expect(within(ana).queryByText('Moroso')).not.toBeInTheDocument();
    expect(within(ana).getByText('+1')).toBeInTheDocument();
    expect(within(ana).getByText('VIP')).toHaveStyle({ color: '#14153a' });
    expect(within(ana).getByText('Lead')).toHaveStyle({ color: '#ffffff' });
    const beto = screen.getByRole('link', { name: 'Beto Luna' });
    expect(within(beto).getByLabelText('Tú: leído.')).toBeInTheDocument();
    expect(within(beto).getByText('GoHighLevel')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: 'Caro Díaz' })).getByLabelText('Tú: no se pudo enviar.')).toBeInTheDocument();
    // no hay marcas de departamento, asesor ni estado en la fila móvil (menos ruido)
    expect(within(ana).queryByText('Ventas')).not.toBeInTheDocument();
    expect(within(ana).queryByText('Luis')).not.toBeInTheDocument();
  });

  it('carga: esqueleto con su nombre accesible; error con «Reintentar»; vacío y sin resultados con su texto', async () => {
    stubWidth(390);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const w = routes([], {
      'GET /conversations': async () => {
        await gate;
        return { body: { items: [], next_cursor: null, counts: { working: 0, pending: 0, closed: 0, unread: 0 } } };
      },
    });
    mockApi(w.routes);
    renderApp('/inbox');
    expect(await screen.findByRole('status', { name: 'Cargando conversaciones' })).toBeInTheDocument();
    release();
    expect(await screen.findByText('No tienes conversaciones en curso.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Cargando conversaciones' })).not.toBeInTheDocument();
  });

  it('error al cargar: mensaje y botón «Reintentar»', async () => {
    stubWidth(390);
    let fail = true;
    const w = routes([conv()], { 'GET /conversations': () => (fail ? err(500, 'INTERNAL', 'x') : { body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } }) });
    mockApi(w.routes);
    renderApp('/inbox');
    const retry = await screen.findByRole('button', { name: 'Reintentar' });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByRole('link', { name: 'Ana Torres' })).toBeInTheDocument();
  });

  it('sin resultados de búsqueda: lo dice y ofrece quitar la búsqueda', async () => {
    stubWidth(390);
    const w = routes([], {});
    mockApi(w.routes);
    renderApp('/inbox');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Buscar conversaciones' }), 'zzz');
    expect(await screen.findByText('No hay conversaciones con estos filtros.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar búsqueda y filtros' }));
    expect(await screen.findByText('No tienes conversaciones en curso.')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar conversaciones' })).toHaveValue('');
  });
});

describe('Inbox · lista de escritorio (sin cambios de estructura)', () => {
  it('no lleva la cabecera móvil y conserva el panel de filtros en la misma lista', async () => {
    stubWidth(1440);
    mockApi(routes([conv()]).routes);
    renderApp('/inbox');
    await screen.findByRole('link', { name: 'Ana Torres' });
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument(); // el título de escritorio lleva «Ver como», el modo y los avisos (v5)
    expect(screen.queryByRole('button', { name: /No leídas/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filtros' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Departamento' })).toBeInTheDocument();
  });
});
