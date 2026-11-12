import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarChoice, CalendarConnection } from '../src/features/calendar/useCalendar';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-11-11T15:00:00.000Z';
const conn = (over: Partial<CalendarConnection> = {}): CalendarConnection => ({ configured: false, available: true, unavailable_reason: null, status: null, mode: null, calendar_name: null, account: null, scopes: [], last_error: null, connected_at: null, ...over });
const CHOICES: CalendarChoice[] = [{ id: 'primary-cal', name: 'ana@example.com', primary: true }, { id: 'ventas-cal', name: 'Ventas', primary: false }];

interface World { c: CalendarConnection; retryFails?: () => ReturnType<Handler>; calls: Record<string, Call[]>; choices?: CalendarChoice[]; startFails?: () => ReturnType<Handler>; chooseFails?: () => ReturnType<Handler> }
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };
function server(w: World): Record<string, Handler> {
  return {
    ...authed(ME_ADMIN),
    'GET /calendar/connection': () => ({ body: w.c }),
    'POST /calendar/connection/start': (c) => { rec(w, 'start', c); return w.startFails ? w.startFails() : { body: { url: 'https://accounts.google.test/auth?state=abc' } }; },
    'GET /calendar/calendars': () => ({ body: { items: w.choices ?? CHOICES } }),
    'PUT /calendar/connection/calendar': (c) => {
      rec(w, 'choose', c);
      if (w.chooseFails) return w.chooseFails();
      const id = (c.body as { calendar_id: string }).calendar_id;
      w.c = conn({ configured: true, status: 'connected', mode: 'existing', calendar_name: (w.choices ?? CHOICES).find((x) => x.id === id)!.name, account: 'a***@example.com', connected_at: AT });
      return { body: w.c };
    },
    'POST /calendar/sync/retry': (c) => { rec(w, 'retry', c); if (w.retryFails) return w.retryFails(); w.c = { ...w.c, sync: { pending: 1, failed: 0, gone: 0, synced: 4, last_synced_at: AT } }; return { body: { requeued: 2 } }; },
    'POST /calendar/connection/disconnect': (c) => { rec(w, 'disconnect', c); w.c = conn({ status: 'disconnected' }); return { body: w.c }; },
  };
}

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin, href: window.location.href, pathname: window.location.pathname, search: window.location.search, hash: '' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Configuración › Google Calendar', () => {
  it('sin conexión ofrece los dos modos (el propio, recomendado); «Conectar con Google» pide la dirección y manda a la persona allí', async () => {
    const w: World = { c: conn(), calls: {} };
    mockApi(server(w));
    renderApp('/settings/calendar');
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    const own = screen.getByRole('radio', { name: /Un calendario nuevo de Sales Smart/ });
    expect(own).toBeChecked();
    expect(screen.getByText('Recomendado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Usar un calendario que ya tengo/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Conectar con Google' }));
    await waitFor(() => expect(w.calls['start']![0]!.body).toEqual({ mode: 'existing' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.test/auth?state=abc'));
  });

  it('si no se puede iniciar, muestra el motivo y no sale a Google', async () => {
    const w: World = { c: conn(), calls: {}, startFails: () => err(503, 'CALENDAR_UNAVAILABLE', 'Por ahora no se puede conectar Google Calendar: la plataforma todavía no tiene cargada la aplicación de Google. Avisa a soporte.') };
    mockApi(server(w));
    renderApp('/settings/calendar');
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/todavía no tiene cargada la aplicación de Google/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('si el servidor dice que no está disponible, lo explica y no ofrece conectar', async () => {
    mockApi(server({ c: conn({ available: false, unavailable_reason: 'platform_credentials' }), calls: {} }));
    renderApp('/settings/calendar');
    expect(await screen.findByText(/la plataforma todavía no tiene cargada la aplicación de Google/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conectar con Google' })).not.toBeInTheDocument();
  });

  it('conectado: muestra la cuenta ENMASCARADA, el calendario y el modo; desconectar pide confirmación', async () => {
    const w: World = { c: conn({ configured: true, status: 'connected', mode: 'own', calendar_name: 'Sales Smart · Barbería Norte', account: 'a***@example.com', connected_at: AT }), calls: {} };
    mockApi(server(w));
    renderApp('/settings/calendar');
    const st = within(await screen.findByRole('region', { name: 'Estado de la conexión' }));
    expect(st.getByText('Conectado')).toBeInTheDocument();
    expect(st.getByText('a***@example.com')).toBeInTheDocument();
    expect(st.getByText('Sales Smart · Barbería Norte')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conectar con Google' })).not.toBeInTheDocument();
    expect(screen.getByText(/Los eventos que ya se crearon se quedan en tu calendario de Google/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(w.calls['disconnect']).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, desconectar' }));
    await waitFor(() => expect(w.calls['disconnect']).toHaveLength(1));
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
  });

  it('conectado: muestra cuántas citas están en Google, cuántas esperan y cuántas fallaron; «Reintentar» solo aparece con errores y vuelve a ponerlas en cola', async () => {
    const w: World = { c: conn({ configured: true, status: 'connected', mode: 'own', calendar_name: 'X', account: 'a***@example.com', connected_at: AT, sync: { pending: 1, failed: 2, gone: 1, synced: 4, last_synced_at: AT } }), calls: {} };
    mockApi(server(w));
    renderApp('/settings/calendar');
    const box = within(await screen.findByRole('region', { name: 'Sincronización de citas' }));
    expect(box.getByText(/4 citas sincronizadas · 1 en espera · 2 con error · 1 borrada en Google/)).toBeInTheDocument();
    expect(box.getByText(/No pudimos enviar 2 citas a Google/)).toBeInTheDocument();
    await userEvent.click(box.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(w.calls['retry']).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Sincronización de citas' })).queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument());
  });

  it('sin errores no ofrece reintentar; sin citas lo dice; y no aparece si la conexión no está activa', async () => {
    const w: World = { c: conn({ configured: true, status: 'connected', mode: 'own', calendar_name: 'X', account: 'a***@example.com', connected_at: AT, sync: { pending: 0, failed: 0, gone: 0, synced: 0, last_synced_at: null } }), calls: {} };
    mockApi(server(w));
    renderApp('/settings/calendar');
    const box = within(await screen.findByRole('region', { name: 'Sincronización de citas' }));
    expect(box.getByText('0 citas sincronizadas')).toBeInTheDocument();
    expect(box.getByText(/Todavía no se ha sincronizado ninguna cita/)).toBeInTheDocument();
    expect(box.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('con la conexión rota no muestra la sincronización', async () => {
    mockApi(server({ c: conn({ configured: true, status: 'needs_reconnect', mode: 'own', sync: { pending: 3, failed: 0, gone: 0, synced: 1, last_synced_at: null } }), calls: {} }));
    renderApp('/settings/calendar');
    await screen.findByText('Requiere reconexión');
    expect(screen.queryByRole('region', { name: 'Sincronización de citas' })).not.toBeInTheDocument();
  });

  it('falta elegir: lista los calendarios, bloquea hasta elegir y guarda el elegido', async () => {
    const w: World = { c: conn({ configured: true, status: 'pending_calendar', mode: 'existing', account: 'a***@example.com' }), calls: {} };
    mockApi(server(w));
    renderApp('/settings/calendar');
    const picker = within(await screen.findByRole('region', { name: 'Elegir calendario' }));
    const use = picker.getByRole('button', { name: 'Usar este calendario' });
    expect(use).toBeDisabled();
    expect(picker.getByRole('option', { name: 'ana@example.com (principal)' })).toBeInTheDocument();
    await userEvent.selectOptions(picker.getByLabelText('¿En qué calendario se guardarán las citas?'), 'ventas-cal');
    await userEvent.click(use);
    await waitFor(() => expect(w.calls['choose']![0]!.body).toEqual({ calendar_id: 'ventas-cal' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Elegir calendario' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Estado de la conexión' })).getByText('Ventas')).toBeInTheDocument();
  });

  it('un calendario rechazado por el servidor muestra el motivo', async () => {
    const w: World = { c: conn({ configured: true, status: 'pending_calendar', mode: 'existing' }), calls: {}, chooseFails: () => err(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', { }) };
    mockApi(server(w));
    renderApp('/settings/calendar');
    const picker = within(await screen.findByRole('region', { name: 'Elegir calendario' }));
    await userEvent.selectOptions(picker.getByLabelText('¿En qué calendario se guardarán las citas?'), 'ventas-cal');
    await userEvent.click(picker.getByRole('button', { name: 'Usar este calendario' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('requiere reconexión: lo dice con el motivo y ofrece volver a conectar', async () => {
    mockApi(server({ c: conn({ configured: true, status: 'needs_reconnect', mode: 'own', last_error: 'Google rechazó el acceso: vuelve a conectar' }), calls: {} }));
    renderApp('/settings/calendar');
    expect(await screen.findByText('Requiere reconexión')).toBeInTheDocument();
    expect(screen.getByText('Google rechazó el acceso: vuelve a conectar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a conectar con Google' })).toBeInTheDocument();
  });

  it('al volver de Google muestra el resultado (?calendar=…) y «Entendido» lo quita', async () => {
    mockApi(server({ c: conn({ configured: true, status: 'connected', mode: 'own', calendar_name: 'Sales Smart · X', account: 'a***@example.com', connected_at: AT }), calls: {} }));
    renderApp('/settings/calendar?calendar=connected');
    expect(await screen.findByText(/Se creó un calendario nuevo solo para Sales Smart/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(screen.queryByText(/Se creó un calendario nuevo solo para Sales Smart/)).not.toBeInTheDocument();
  });

  it('cada resultado de error tiene su texto; un valor desconocido en la dirección se ignora', async () => {
    mockApi(server({ c: conn(), calls: {} }));
    renderApp('/settings/calendar?calendar=scopes');
    expect(await screen.findByText(/desmarcaste algún permiso/)).toBeInTheDocument();
  });

  it('si la API de Google Calendar no está habilitada en el proyecto, lo dice (es de la plataforma, no de la persona)', async () => {
    mockApi(server({ c: conn(), calls: {} }));
    renderApp('/settings/calendar?calendar=api');
    expect(await screen.findByText(/la API de Google Calendar no está habilitada en el proyecto de Google Cloud/)).toBeInTheDocument();
  });

  it('un valor desconocido en la dirección no muestra nada raro', async () => {
    mockApi(server({ c: conn(), calls: {} }));
    renderApp('/settings/calendar?calendar=<script>');
    await screen.findByText('Desconectado');
    expect(screen.queryByText(/script/)).not.toBeInTheDocument();
  });

  it('la tarjeta de Conexiones enlaza a la configuración y muestra el estado', async () => {
    mockApi({ ...server({ c: conn({ configured: true, status: 'connected', mode: 'own', calendar_name: 'X', account: 'a***@example.com' }), calls: {} }), 'GET /channels': () => ({ body: { items: [], vault: { available: true } } }) });
    renderApp('/settings/connections');
    const link = await screen.findByRole('link', { name: 'Configurar Google Calendar' });
    expect(link).toHaveAttribute('href', '/settings/calendar');
  });
});
