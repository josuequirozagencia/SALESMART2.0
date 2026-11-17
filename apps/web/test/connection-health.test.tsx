import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '../src/lib/types';
import type { ConnectionHealth, HealthList } from '../src/features/channels/useConnectionHealth';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v19 B1 — «Salud de las conexiones» dentro de Configuración › Conexiones y las alertas en la campana.

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const health = (over: Partial<ConnectionHealth> = {}): ConnectionHealth => ({
  id: 'ch1', name: 'Chip principal', kind: 'whatsapp_qr', status: 'active', session: { state: 'open', down_since: null }, last_event_at: iso(30_000),
  inbound_24h: { count: 42, lag_median_s: 1.4, lag_p95_s: 3, lag_max_s: 9, last_at: iso(60_000) }, recent_lag_median_s: 1.4, events: { pending: 0, overdue: 0, failed: 0 }, ignored_24h: {}, failed_events: [], level: 'ok', reasons: [], ...over,
});

interface World { list: HealthList; retries: Call[]; failRetry: boolean }
const world = (connections: ConnectionHealth[] = [health()]): World => ({ list: { generated_at: new Date(NOW).toISOString(), connections }, retries: [], failRetry: false });

function server(w: World, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(ME_ADMIN),
    'GET /channels': () => ({ body: { items: [], vault: { available: true } } }),
    'GET /queues': () => ({ body: { items: [], limits: { max_queues: 20 } } }),
    'GET /qr-channels': () => ({ body: { items: [], available: true, limits: { max_channels: 5 } } }),
    'GET /connection-health': () => ({ body: w.list }),
    'POST /connection-health/events/ev1/retry': (c) => {
      w.retries.push(c);
      if (w.failRetry) return err(409, 'EVENT_REDACTED', 'El contenido de ese aviso ya se borró por privacidad (a los 30 días): no se puede reintentar');
      w.list = { ...w.list, connections: w.list.connections.map((x) => ({ ...x, failed_events: x.failed_events.filter((f) => f.id !== 'ev1'), events: { ...x.events, failed: 0 }, level: 'ok', reasons: [] })) };
      return { body: { id: 'ev1', status: 'pending' } };
    },
    ...extra,
  };
}

const open = async (w: World, extra: Record<string, Handler> = {}) => {
  const api = mockApi(server(w, extra));
  renderApp('/settings/connections');
  const section = within(await screen.findByRole('region', { name: 'Salud de las conexiones' }));
  return { api, section };
};

describe('Salud de las conexiones', () => {
  it('una conexión sana: «Todo bien», último aviso, mensajes y retraso de 24 h, sin avisos ni motivos', async () => {
    const { section } = await open(world());
    const card = within(await section.findByRole('listitem', { name: 'Salud de Chip principal' }));
    expect(card.getByText('Todo bien')).toBeInTheDocument();
    expect(card.getByText('WhatsApp por QR')).toBeInTheDocument();
    expect(card.getByText('hace menos de 1 min')).toBeInTheDocument();
    expect(card.getByText('42')).toBeInTheDocument();
    expect(card.getAllByText('1 s').length).toBeGreaterThan(0); // 1,4 s redondeado
    expect(section.getByText('Todas bien')).toBeInTheDocument();
    expect(section.queryByRole('list', { name: /Avisos fallidos/ })).not.toBeInTheDocument();
  });

  it('con problemas: nivel, una frase por motivo con su cifra, ignorados por motivo y los avisos fallidos con su causa en palabras', async () => {
    const bad = health({
      level: 'crit', reasons: ['failed', 'lag', 'backlog'], recent_lag_median_s: 600, inbound_24h: { count: 7, lag_median_s: 600, lag_p95_s: 3600, lag_max_s: 3600, last_at: iso(60_000) },
      events: { pending: 2, overdue: 2, failed: 1 }, ignored_24h: { group: 3, receipt: 5 },
      failed_events: [{ id: 'ev1', received_at: iso(3_600_000), attempts: 5, reason: 'La base de datos rechazó un dato del aviso (llave repetida o dato inválido).', retryable: true }, { id: 'ev2', received_at: iso(86_400_000), attempts: 5, reason: 'El aviso trae un formato que no se pudo leer.', retryable: false }],
    });
    const { section } = await open(world([bad]));
    const card = within(await section.findByRole('listitem', { name: 'Salud de Chip principal' }));
    expect(card.getByText('Requiere acción')).toBeInTheDocument();
    expect(card.getByText(/Hay 1 aviso que no se pudo procesar/)).toBeInTheDocument();
    expect(card.getByText(/entrando con 10 min de retraso/)).toBeInTheDocument();
    expect(card.getByText(/Hay 2 avisos esperando procesarse hace más de 1 minuto/)).toBeInTheDocument();
    expect(card.getByText(/2 atrasados/)).toBeInTheDocument();
    expect(card.getByText('Ignorados en 24 h: Grupos 3 · Acuses de lectura 5.')).toBeInTheDocument();
    expect(section.getByText('Hay conexiones que requieren acción')).toBeInTheDocument();
    const failed = within(card.getByRole('list', { name: 'Avisos fallidos de Chip principal' }));
    expect(failed.getByText(/llave repetida/)).toBeInTheDocument();
    expect(failed.getByText(/Ya no se puede reintentar \(su contenido se borró por privacidad\)/)).toBeInTheDocument();
    expect(failed.getAllByRole('button', { name: /^Reintentar el aviso/ })).toHaveLength(1); // solo el que aún tiene contenido
  });

  it('«Reintentar» manda el aviso a la cola y la tarjeta se actualiza; si el servidor lo rechaza, dice por qué', async () => {
    const bad = health({ level: 'crit', reasons: ['failed'], events: { pending: 0, overdue: 0, failed: 1 }, failed_events: [{ id: 'ev1', received_at: iso(3_600_000), attempts: 5, reason: 'x', retryable: true }] });
    const w = world([bad]);
    const { section } = await open(w);
    const card = within(await section.findByRole('listitem', { name: 'Salud de Chip principal' }));
    await userEvent.click(card.getByRole('button', { name: /^Reintentar el aviso/ }));
    await waitFor(() => expect(w.retries).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: 'Salud de Chip principal' })).getByText('Todo bien')).toBeInTheDocument());
  });

  it('un rechazo del servidor al reintentar se muestra con su motivo', async () => {
    const bad = health({ level: 'crit', reasons: ['failed'], events: { pending: 0, overdue: 0, failed: 1 }, failed_events: [{ id: 'ev1', received_at: iso(3_600_000), attempts: 5, reason: 'x', retryable: true }] });
    const w = world([bad]);
    w.failRetry = true;
    const { section } = await open(w);
    const card = within(await section.findByRole('listitem', { name: 'Salud de Chip principal' }));
    await userEvent.click(card.getByRole('button', { name: /^Reintentar el aviso/ }));
    expect(await card.findByRole('alert')).toBeInTheDocument();
  });

  it('una sesión caída o una conexión desactivada se dicen sin alarmar de más', async () => {
    const { section } = await open(world([health({ id: 'a', name: 'Caído', level: 'crit', reasons: ['session_down'], session: { state: 'closed', down_since: iso(3_600_000) } }), health({ id: 'b', name: 'Apagado', status: 'inactive', level: 'ok' })]));
    expect(await section.findByText(/La sesión de WhatsApp está caída/)).toBeInTheDocument();
    expect(within(section.getByRole('listitem', { name: 'Salud de Apagado' })).getByText('Desactivada')).toBeInTheDocument();
  });

  it('sin conexiones invita a conectar un número', async () => {
    const { section } = await open(world([]));
    expect(await section.findByText(/Cuando conectes un número aparecerá aquí/)).toBeInTheDocument();
  });

  it('si falla la carga, lo dice y se puede reintentar', async () => {
    let calls = 0;
    const { section } = await open(world(), { 'GET /connection-health': () => { calls += 1; return err(500, 'INTERNAL', 'x'); } });
    expect(await section.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(section.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(calls).toBeGreaterThan(1));
  });

  it('muestra lo que ve ESTE navegador del tiempo real (estado y avisos recibidos)', async () => {
    const { section } = await open(world());
    const rt = within(await section.findByRole('region', { name: 'Tiempo real en tu navegador' }));
    expect(rt.getByText('Avisos recibidos en esta sesión')).toBeInTheDocument();
    expect(rt.getByText('Mensajes que tardaron en aparecer')).toBeInTheDocument();
    expect(rt.getByText(/depende del reloj de este equipo/)).toBeInTheDocument();
  });
});

describe('campana · alertas de conexión', () => {
  const alert = (reason: 'lag' | 'silent' | 'failed' | 'backlog', id = 'n1'): AppNotification => ({
    id, type: 'connection_health', created_at: new Date().toISOString(), read_at: null, actor: null, conversation: null, message_id: null, excerpt: null, task: null, connection: { id: 'ch1', name: 'Chip principal', reason },
  });

  it('cada alerta dice la conexión y el motivo, cuenta como sin leída y al abrirla se marca y lleva a Conexiones', async () => {
    const marked: string[] = [];
    mockApi({
      ...authed(ME_ADMIN),
      'GET /notifications': () => ({ body: { items: [alert('failed'), alert('lag', 'n2'), alert('silent', 'n3'), alert('backlog', 'n4')], next_cursor: null, unread: 4 } }),
      'POST /notifications/n1/read': () => { marked.push('n1'); return { body: { id: 'n1', read_at: new Date().toISOString() } }; },
      'GET /channels': () => ({ body: { items: [], vault: { available: true } } }),
      'GET /queues': () => ({ body: { items: [], limits: { max_queues: 20 } } }),
      'GET /qr-channels': () => ({ body: { items: [], available: true, limits: { max_channels: 5 } } }),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Avisos (4 sin leer)' }));
    const list = within(await screen.findByRole('list', { name: 'Avisos' }));
    const link = list.getByRole('link', { name: /Conexión «Chip principal»: hay avisos que no se pudieron procesar/ });
    expect(link).toHaveAttribute('href', '/settings/connections');
    expect(list.getByText(/los mensajes llegan con mucho retraso desde WhatsApp/)).toBeInTheDocument();
    expect(list.getByText(/lleva horas sin recibir ningún aviso en horario laboral/)).toBeInTheDocument();
    expect(list.getByText(/los avisos se están procesando con retraso/)).toBeInTheDocument();
    await userEvent.click(link);
    expect(marked).toEqual(['n1']);
  });
});
