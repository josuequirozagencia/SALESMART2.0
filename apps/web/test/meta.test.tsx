import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaEvent, MetaSettings } from '../src/features/meta/useMeta';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NOW = new Date().toISOString();
const TOKEN = 'EAAGm0PX4ZCpsBAweb0123456789abcdef';
const settings = (over: Partial<MetaSettings> = {}): MetaSettings => ({ configured: false, available: true, dataset_id: null, waba_id: null, messaging_dataset_id: null, token_last4: null, grace_minutes: 30, test_event_code: null, enabled: false, last_error: null, last_check_at: null, counts: {}, ...over });
const configured = (over: Partial<MetaSettings> = {}): MetaSettings => settings({ configured: true, dataset_id: '111122223333444', token_last4: 'cdef', enabled: true, last_check_at: NOW, ...over });
const event = (over: Partial<MetaEvent> = {}): MetaEvent => ({ id: 'e1', event_id: 'purchase:1', type: 'Purchase', status: 'sent', attempts: 1, contact: { id: 'k1', name: 'Ana Torres' }, send_after: NOW, sent_at: NOW, last_error: null, created_at: NOW, can_retry: false, ...over });

interface World { settings: MetaSettings; events: MetaEvent[]; calls: Array<{ method: string; path: string; body: unknown }>; saveFails?: () => ReturnType<Handler>; testFails?: boolean; ensureFails?: boolean; statusQueries: string[] }
const world = (over: Partial<World> = {}): World => ({ settings: settings(), events: [], calls: [], statusQueries: [], ...over });

function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  const rec = (c: Call) => w.calls.push({ method: c.method, path: c.path, body: c.body });
  return {
    ...authed(me),
    'GET /meta/settings': () => ({ body: w.settings }),
    'PUT /meta/settings': (c) => {
      rec(c);
      if (w.saveFails) return w.saveFails();
      const b = c.body as { dataset_id: string; access_token?: string; waba_id?: string | null; messaging_dataset_id?: string | null; grace_minutes: number; test_event_code: string | null; enabled: boolean };
      w.settings = configured({ dataset_id: b.dataset_id, waba_id: b.waba_id === undefined ? w.settings.waba_id : b.waba_id, messaging_dataset_id: b.messaging_dataset_id === undefined ? w.settings.messaging_dataset_id : b.messaging_dataset_id, grace_minutes: b.grace_minutes, test_event_code: b.test_event_code, enabled: b.enabled, token_last4: b.access_token ? b.access_token.slice(-4) : w.settings.token_last4 });
      return { body: w.settings };
    },
    'POST /meta/settings/test': (c) => { rec(c); return w.testFails ? err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'access_token', code: 'rejected', message: 'Meta rechazó las credenciales: token vencido' }] } } }) : { body: { ok: true, dataset_name: 'Pixel de la barbería' } }; },
    'POST /meta/messaging-dataset': (c) => {
      rec(c);
      if (w.ensureFails) return err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'waba_id', code: 'rejected', message: 'Meta rechazó las credenciales: Requires whatsapp_business_manage_events permission' }] } } });
      w.settings = { ...w.settings, waba_id: (c.body as { waba_id: string }).waba_id, messaging_dataset_id: '1030123066792188' };
      return { body: w.settings };
    },
    'POST /meta/events/retry-all': (c) => { rec(c); return { body: { requeued: 2, expired: 1 } }; },
    'GET /meta/events': (c) => { w.statusQueries.push(c.query.get('status') ?? ''); return { body: { items: c.query.get('status') ? w.events.filter((e) => e.status === c.query.get('status')) : w.events, next_cursor: null } }; },
    'POST /meta/events/e2/retry': (c) => { rec(c); w.events = w.events.map((e) => (e.id === 'e2' ? { ...e, status: 'pending', can_retry: false, last_error: null } : e)); return { body: w.events.find((e) => e.id === 'e2') }; },
  };
}

describe('Configuración › API de Conversiones', () => {
  it('la pestaña está en el menú de configuración; sin conexión pide dataset y token y no ofrece «Probar conexión»', async () => {
    mockApi(server(world()));
    renderApp('/settings/meta');
    expect(await screen.findByRole('link', { name: 'API de Conversiones' })).toHaveAttribute('href', '/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    expect(form.getByLabelText('Token de acceso')).toHaveAttribute('type', 'password');
    expect(form.queryByRole('button', { name: 'Probar conexión' })).toBeNull();
    expect(form.getByLabelText('Enviar eventos a Meta')).toBeChecked();
  });

  it('guarda dataset, token, ventana de gracia y código de prueba; el token se envía una vez y no queda en pantalla', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.type(await form.findByLabelText('Identificador del dataset (pixel)'), '111122223333444');
    await userEvent.type(form.getByLabelText('Token de acceso'), TOKEN);
    await userEvent.selectOptions(form.getByLabelText('Esperar antes de enviar la compra'), '120');
    await userEvent.type(form.getByLabelText(/Código de «Eventos de prueba»/), 'TEST12345');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]).toEqual({ method: 'PUT', path: '/meta/settings', body: { dataset_id: '111122223333444', access_token: TOKEN, grace_minutes: 120, test_event_code: 'TEST12345', enabled: true } });
    expect(await screen.findByText('Conexión guardada: Meta aceptó el token.')).toBeInTheDocument();
    expect(await screen.findByText(/••••cdef/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.getByLabelText(/^Token de acceso/)).toHaveValue(''); // el campo se limpia
    expect(screen.getByRole('button', { name: 'Probar conexión' })).toBeInTheDocument();
  });

  it('valida antes de enviar: dataset solo dígitos, token obligatorio la primera vez y sin espacios, código de prueba acotado', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.type(await form.findByLabelText('Identificador del dataset (pixel)'), 'abc');
    await userEvent.type(form.getByLabelText(/Código de «Eventos de prueba»/), 'con espacios');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByText('El identificador del dataset son solo dígitos')).toBeInTheDocument();
    expect(form.getByText('Pega el token de acceso del dataset')).toBeInTheDocument();
    expect(form.getByText('Solo letras, números, guion y guion bajo')).toBeInTheDocument();
    await userEvent.clear(form.getByLabelText('Identificador del dataset (pixel)'));
    await userEvent.type(form.getByLabelText('Identificador del dataset (pixel)'), '111122223333444');
    await userEvent.type(form.getByLabelText('Token de acceso'), 'corto');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByText(/El token no parece válido/)).toBeInTheDocument();
    expect(w.calls).toEqual([]);
  });

  it('si Meta rechaza el token muestra el motivo de Meta y no guarda', async () => {
    const w = world({ saveFails: () => err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'access_token', code: 'rejected', message: 'Meta rechazó las credenciales: Invalid OAuth access token' }] } } }) });
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.type(await form.findByLabelText('Identificador del dataset (pixel)'), '111122223333444');
    await userEvent.type(form.getByLabelText('Token de acceso'), TOKEN);
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByText('Meta rechazó las credenciales: Invalid OAuth access token')).toBeInTheDocument();
    expect(form.queryByText('Conexión guardada: Meta aceptó el token.')).toBeNull();
  });

  it('con la conexión guardada: cambiar la ventana no pide el token (no lo envía); cambiar de dataset sí lo pide; «Probar conexión» muestra el resultado', async () => {
    const w = world({ settings: configured() });
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    expect(await form.findByText(/••••cdef/)).toBeInTheDocument();
    await userEvent.selectOptions(form.getByLabelText('Esperar antes de enviar la compra'), '0');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]!.body).toEqual({ dataset_id: '111122223333444', grace_minutes: 0, test_event_code: null, enabled: true });
    const dataset = form.getByLabelText('Identificador del dataset (pixel)');
    await userEvent.clear(dataset);
    await userEvent.type(dataset, '999988887777666');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByText('Al cambiar de dataset pega también su token')).toBeInTheDocument();
    await userEvent.clear(dataset);
    await userEvent.type(dataset, '111122223333444');
    await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
    expect(await form.findByText(/Conexión correcta: «Pixel de la barbería»/)).toBeInTheDocument();
  });

  it('una comprobación fallida muestra el motivo; el último error guardado de la conexión se ve arriba', async () => {
    mockApi(server(world({ settings: configured({ last_error: 'Meta rechazó las credenciales: token vencido' }), testFails: true })));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    expect(await form.findByText(/Corrige la conexión y reintenta/)).toBeInTheDocument();
    await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
    expect((await form.findAllByText(/token vencido/)).length).toBeGreaterThan(0);
  });

  it('sin cifrado en el servidor avisa y no deja guardar', async () => {
    mockApi(server(world({ settings: settings({ available: false }) })));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    expect(await form.findByText(/El servidor aún no puede conectarse con Meta/)).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });
});

describe('Panel de eventos', () => {
  it('lista cada evento con su tipo, contacto, estado y el motivo si falló; avisa de los fallidos y reintenta uno', async () => {
    const w = world({
      settings: configured({ counts: { failed: 1, sent: 1, pending: 1 } }),
      events: [
        event({ id: 'e3', event_id: 'schedule:1', type: 'Schedule', status: 'pending', sent_at: null, attempts: 0 }),
        event({ id: 'e2', event_id: 'purchase:2', status: 'failed', attempts: 5, can_retry: true, last_error: 'Meta no pudo atender el envío ahora', contact: { id: 'k2', name: 'Luis Navas' } }),
        event({ id: 'e1' }),
      ],
    });
    mockApi(server(w));
    renderApp('/settings/meta');
    const panel = within(await screen.findByRole('region', { name: 'Eventos enviados a Meta' }));
    const list = within(await panel.findByRole('list', { name: 'Eventos' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(list.getByText('Cita (Schedule)')).toBeInTheDocument();
    expect(list.getByText('Meta no pudo atender el envío ahora')).toBeInTheDocument();
    expect(panel.getByText(/1 evento\(s\) fallido\(s\) o bloqueado\(s\)/)).toBeInTheDocument();
    expect(list.getAllByRole('button', { name: /Reintentar/ })).toHaveLength(1); // solo el fallido
    await userEvent.click(list.getByRole('button', { name: 'Reintentar el evento de Luis Navas' }));
    await waitFor(() => expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/meta/events/e2/retry' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Eventos' })).queryByRole('button', { name: /Reintentar/ })).toBeNull());
  });

  it('el filtro por estado pide solo ese estado; sin eventos lo explica', async () => {
    const w = world({ settings: configured(), events: [] });
    mockApi(server(w));
    renderApp('/settings/meta');
    const panel = within(await screen.findByRole('region', { name: 'Eventos enviados a Meta' }));
    expect(await panel.findByText(/Todavía no hay eventos/)).toBeInTheDocument();
    await userEvent.selectOptions(panel.getByLabelText('Estado'), 'failed');
    await waitFor(() => expect(w.statusQueries).toContain('failed'));
  });
});

describe('Mensajes de WhatsApp: cuenta y dataset de mensajes (v20)', () => {
  it('«Crear o recuperar» pide el dataset a Meta con la cuenta escrita y lo muestra; está desactivado hasta que hay una cuenta válida', async () => {
    const w = world({ settings: configured() });
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    const button = await form.findByRole('button', { name: 'Crear o recuperar el dataset de mensajes' });
    expect(button).toBeDisabled();
    await userEvent.type(form.getByLabelText('Cuenta de WhatsApp Business (ID)'), '935383352872554');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(w.calls.at(-1)).toEqual({ method: 'POST', path: '/meta/messaging-dataset', body: { waba_id: '935383352872554' } }));
    expect(await screen.findByText(/Meta dio el dataset de mensajes/)).toBeInTheDocument();
    expect(form.getByLabelText('Dataset de mensajes')).toHaveValue('1030123066792188');
  });

  it('sin conexión guardada el botón está desactivado y explica por qué', async () => {
    mockApi(server(world()));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.type(await form.findByLabelText('Cuenta de WhatsApp Business (ID)'), '935383352872554');
    expect(form.getByRole('button', { name: 'Crear o recuperar el dataset de mensajes' })).toBeDisabled();
    expect(form.getByText('Guarda primero la conexión con su token.')).toBeInTheDocument();
  });

  it('si Meta no lo da, muestra el motivo de Meta', async () => {
    mockApi(server(world({ settings: configured({ waba_id: '935383352872554' }), ensureFails: true })));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.click(await form.findByRole('button', { name: 'Crear o recuperar el dataset de mensajes' }));
    expect(await form.findByText(/Requires whatsapp_business_manage_events/)).toBeInTheDocument();
  });

  it('al guardar solo manda la cuenta y el dataset de mensajes si cambiaron (no pisa lo guardado desde otra pestaña); los valida antes de enviar', async () => {
    const w = world({ settings: configured({ waba_id: '935383352872554', messaging_dataset_id: '1030123066792188' }) });
    mockApi(server(w));
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.selectOptions(await form.findByLabelText('Esperar antes de enviar la compra'), '0');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]!.body).toEqual({ dataset_id: '111122223333444', grace_minutes: 0, test_event_code: null, enabled: true });
    await userEvent.clear(form.getByLabelText('Cuenta de WhatsApp Business (ID)'));
    await userEvent.type(form.getByLabelText('Cuenta de WhatsApp Business (ID)'), 'abc');
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(await form.findByText('El identificador de la cuenta son solo dígitos')).toBeInTheDocument();
    expect(w.calls).toHaveLength(1);
    await userEvent.clear(form.getByLabelText('Cuenta de WhatsApp Business (ID)'));
    await userEvent.clear(form.getByLabelText('Dataset de mensajes'));
    await userEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(2));
    expect(w.calls[1]!.body).toMatchObject({ waba_id: null, messaging_dataset_id: null });
  });

  it('«Probar conexión» muestra también el dataset de mensajes', async () => {
    const w = world({ settings: configured({ messaging_dataset_id: '1030123066792188' }) });
    const srv = server(w);
    srv['POST /meta/settings/test'] = () => ({ body: { ok: true, dataset_name: 'Pixel de la barbería', messaging_dataset_name: 'Mensajes Pasiel' } });
    mockApi(srv);
    renderApp('/settings/meta');
    const form = within(await screen.findByRole('region', { name: 'Conexión con Meta' }));
    await userEvent.click(await form.findByRole('button', { name: 'Probar conexión' }));
    expect(await form.findByText(/dataset de mensajes: «Mensajes Pasiel»/)).toBeInTheDocument();
  });

  it('«Reintentar todos» vuelve a poner en cola los fallidos y avisa cuántos vencieron', async () => {
    const w = world({ settings: configured({ counts: { failed: 3 } }), events: [event({ id: 'e2', status: 'failed', can_retry: true, last_error: 'Invalid parameter' })] });
    mockApi(server(w));
    renderApp('/settings/meta');
    const panel = within(await screen.findByRole('region', { name: 'Eventos enviados a Meta' }));
    await userEvent.click(await panel.findByRole('button', { name: 'Reintentar todos' }));
    await waitFor(() => expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/meta/events/retry-all' }));
    expect(await panel.findByText(/2 evento\(s\) vuelven a la cola y 1 pasan a «vencido»/)).toBeInTheDocument();
  });
});
