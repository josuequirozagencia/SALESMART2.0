import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelList, Queue } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const TOKEN = 'EAAG-token-permanente-de-prueba-0042';
const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'ch1', provider: 'meta_cloud', is_official: true, name: 'Ventas', status: 'active', waba_id: '1234567890123', phone_number_id: '1090123456789',
  display_phone: '+593 98 421 7730', verified_name: 'Barbería Norte', token_last4: '0042', last_check_at: '2026-10-18T15:00:00.000Z', last_error: null, last_event_at: null, queue_id: null,
  created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z', ...over,
});

const queue = (id: string, name: string): Queue => ({ id, name, color: '#7c5cfa', distribution_on: true, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3, hours: null, open_now: true, members: [], channels: [], unassigned_count: 0, created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z' });
const QUEUES = [queue('q1', 'Ventas'), queue('q2', 'Soporte')];

function server(initial: Channel[] = [], opts: { vault?: boolean } = {}) {
  const s = { items: initial, vault: opts.vault ?? true, routes: {} as Record<string, Handler>, bodies: [] as unknown[] };
  const list = (): { body: ChannelList } => ({ body: { items: s.items, vault: { available: s.vault } } });
  s.routes = {
    ...authed(ME_ADMIN),
    'GET /channels': () => list(),
    'GET /queues': () => ({ body: { items: QUEUES, limits: { max_queues: 20 } } }),
    'POST /channels': ({ body }) => {
      s.bodies.push(body);
      const b = body as { name: string; waba_id: string; phone_number_id: string };
      const c = channel({ id: `ch${s.items.length + 1}`, name: b.name, waba_id: b.waba_id, phone_number_id: b.phone_number_id });
      s.items = [...s.items, c];
      return { status: 201, body: c };
    },
    'PATCH /channels/ch1': ({ body }) => {
      s.bodies.push(body);
      const b = body as Partial<Channel> & { access_token?: string };
      s.items = s.items.map((c) => (c.id === 'ch1' ? { ...c, ...(b.name ? { name: b.name } : {}), ...(b.status ? { status: b.status } : {}) } : c));
      return { body: s.items[0] };
    },
    'POST /channels/ch1/check': () => {
      s.items = s.items.map((c) => (c.id === 'ch1' ? { ...c, last_check_at: '2026-10-18T18:00:00.000Z' } : c));
      return { body: s.items[0] };
    },
    'DELETE /channels/ch1': () => { s.items = s.items.filter((c) => c.id !== 'ch1'); return { body: { id: 'ch1', deleted: true } }; },
  };
  return s;
}

describe('Configuración › Conexiones', () => {
  it('sin conexiones invita a conectar el primer número; la pestaña lleva a /settings/connections', async () => {
    mockApi(server().routes);
    renderApp('/settings/connections');
    expect(await screen.findByText(/Aún no hay números conectados/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Conexiones' })).toHaveAttribute('href', '/settings/connections');
    expect(screen.getByRole('button', { name: 'Conectar un número' })).toBeEnabled();
  });

  it('conecta un número: valida en pantalla, manda los datos y el token no vuelve a verse (solo los últimos 4)', async () => {
    const s = server();
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar un número' }));
    const d = within(await screen.findByRole('dialog', { name: 'Conectar un número de WhatsApp' }));

    await userEvent.click(d.getByRole('button', { name: 'Conectar' }));
    expect(d.getByText('Escribe un nombre para reconocer esta conexión')).toBeInTheDocument();
    expect(d.getAllByText(/Son solo dígitos/)).toHaveLength(2);
    expect(d.getByText('Pega el token completo, sin espacios')).toBeInTheDocument();
    expect(api.count('POST /channels')).toBe(0);

    await userEvent.type(d.getByLabelText(/^Nombre/), '  Ventas ');
    await userEvent.type(d.getByLabelText(/WABA ID/), '1234567890123');
    await userEvent.type(d.getByLabelText(/Phone number ID/), '1090123456789');
    const tokenInput = d.getByLabelText(/Token de acceso permanente/);
    expect(tokenInput).toHaveAttribute('type', 'password'); // oculto mientras se escribe
    await userEvent.type(tokenInput, TOKEN);
    await userEvent.click(d.getByRole('button', { name: 'Conectar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(s.bodies).toEqual([{ name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: TOKEN }]);
    const card = within(await screen.findByRole('listitem', { name: 'Ventas' }));
    expect(card.getByText(/\+593 98 421 7730/)).toBeInTheDocument();
    expect(card.getByText('••••0042')).toBeInTheDocument();
    expect(card.getByText('Activa')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('si Meta rechaza el token o el número ya está en uso, el motivo se explica en el diálogo y se puede corregir', async () => {
    const s = server();
    let reply: ReturnType<typeof err> = err(400, 'CHANNEL_TOKEN_INVALID', 'Meta rechazó el token. Revisa que sea un token permanente con permisos de WhatsApp');
    s.routes['POST /channels'] = () => reply;
    mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar un número' }));
    const d = within(await screen.findByRole('dialog'));
    await userEvent.type(d.getByLabelText(/^Nombre/), 'Ventas');
    await userEvent.type(d.getByLabelText(/WABA ID/), '1234567890123');
    await userEvent.type(d.getByLabelText(/Phone number ID/), '1090123456789');
    await userEvent.type(d.getByLabelText(/Token de acceso permanente/), TOKEN);
    await userEvent.click(d.getByRole('button', { name: 'Conectar' }));
    expect(await d.findByRole('alert')).toHaveTextContent('Meta rechazó el token');
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // sigue abierto, con lo escrito

    reply = err(409, 'CHANNEL_NUMBER_IN_USE', 'Ese número ya está conectado. Un número solo puede estar activo en una conexión');
    await userEvent.click(d.getByRole('button', { name: 'Conectar' }));
    await waitFor(() => expect(d.getByRole('alert')).toHaveTextContent('Ese número ya está conectado'));
  });

  it('muestra cada conexión con su estado; un error de la última comprobación la marca «Requiere atención»; una desactivada se distingue', async () => {
    mockApi(server([channel(), channel({ id: 'ch2', name: 'Soporte', phone_number_id: '1090123456780', last_error: 'Meta rechazó el token. Pega uno nuevo.' }), channel({ id: 'ch3', name: 'Antigua', status: 'disabled', phone_number_id: '1090123456781' })]).routes);
    renderApp('/settings/connections');
    const ventas = within(await screen.findByRole('listitem', { name: 'Ventas' }));
    expect(ventas.getByText('Activa')).toBeInTheDocument();
    const soporte = within(screen.getByRole('listitem', { name: 'Soporte' }));
    expect(soporte.getByText('Requiere atención')).toBeInTheDocument();
    expect(soporte.getByRole('alert')).toHaveTextContent('Meta rechazó el token. Pega uno nuevo.');
    const antigua = within(screen.getByRole('listitem', { name: 'Antigua' }));
    expect(antigua.getByText('Desactivada')).toBeInTheDocument();
    expect(antigua.getByRole('button', { name: 'Activar Antigua' })).toBeInTheDocument();
  });

  it('cada conexión dice a qué cola va; al conectar o editar se elige la cola por defecto y se manda solo si cambió', async () => {
    const s = server([channel({ queue_id: 'q1' }), channel({ id: 'ch2', name: 'Soporte técnico', phone_number_id: '1090123456780' })]);
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    const ventas = within(await screen.findByRole('listitem', { name: 'Ventas' }));
    expect(ventas.getByText('Cola').nextElementSibling).toHaveTextContent('Ventas');
    expect(within(screen.getByRole('listitem', { name: 'Soporte técnico' })).getByText('Cola').nextElementSibling).toHaveTextContent('sin cola');
    // editar: sin tocar la cola no se manda; cambiarla sí; «Sin cola» la quita
    await userEvent.click(screen.getByRole('button', { name: 'Editar Ventas' }));
    let d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    expect(d.getByLabelText('Cola por defecto')).toHaveValue('q1');
    await userEvent.selectOptions(d.getByLabelText('Cola por defecto'), 'q2');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ queue_id: 'q2' });
    await userEvent.click(screen.getByRole('button', { name: 'Editar Ventas' }));
    d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    await userEvent.selectOptions(d.getByLabelText('Cola por defecto'), '');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.count('PATCH /channels/ch1')).toBe(2));
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ queue_id: null });
  });

  it('al conectar un número se puede elegir su cola (opcional)', async () => {
    const s = server();
    mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar un número' }));
    const d = within(await screen.findByRole('dialog', { name: 'Conectar un número de WhatsApp' }));
    expect(d.getByLabelText('Cola por defecto')).toHaveValue(''); // sin cola por omisión
    await userEvent.type(d.getByLabelText(/^Nombre/), 'Ventas');
    await userEvent.type(d.getByLabelText(/WABA ID/), '1234567890123');
    await userEvent.type(d.getByLabelText(/Phone number ID/), '1090123456789');
    await userEvent.type(d.getByLabelText(/Token de acceso permanente/), TOKEN);
    await userEvent.selectOptions(d.getByLabelText('Cola por defecto'), 'q2');
    await userEvent.click(d.getByRole('button', { name: 'Conectar' }));
    await waitFor(() => expect(s.bodies).toHaveLength(1));
    expect(s.bodies[0]).toMatchObject({ queue_id: 'q2' });
  });

  it('cada conexión dice cuándo llegó el último aviso de Meta, o que todavía no ha llegado ninguno', async () => {
    mockApi(server([channel(), channel({ id: 'ch2', name: 'Soporte', phone_number_id: '1090123456780', last_event_at: '2026-10-18T16:45:00.000Z' })]).routes);
    renderApp('/settings/connections');
    const ventas = within(await screen.findByRole('listitem', { name: 'Ventas' }));
    expect(ventas.getByText('Último aviso de Meta')).toBeInTheDocument();
    expect(ventas.getByText('ninguno todavía')).toBeInTheDocument();
    const soporte = within(screen.getByRole('listitem', { name: 'Soporte' }));
    expect(soporte.queryByText('ninguno todavía')).not.toBeInTheDocument();
    expect(soporte.getByText('Último aviso de Meta').nextElementSibling).toHaveTextContent(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('comprobar vuelve a consultar a Meta; desactivar y activar cambian el estado', async () => {
    const s = server([channel()]);
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Comprobar Ventas' }));
    await waitFor(() => expect(api.count('POST /channels/ch1/check')).toBe(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Desactivar Ventas' }));
    expect(await screen.findByText('Desactivada')).toBeInTheDocument();
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ status: 'disabled' });
    await userEvent.click(screen.getByRole('button', { name: 'Activar Ventas' }));
    expect(await screen.findByText('Activa')).toBeInTheDocument();
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ status: 'active' });
  });

  it('editar: cambia el nombre sin tocar el token; con token nuevo lo manda; sin cambios no llama al servidor', async () => {
    const s = server([channel()]);
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Editar Ventas' }));
    let d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    expect(d.queryByLabelText(/WABA ID/)).not.toBeInTheDocument(); // el número no se cambia
    expect(d.getByText('+593 98 421 7730')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.count('PATCH /channels/ch1')).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Editar Ventas' }));
    d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    await userEvent.clear(d.getByLabelText(/^Nombre/));
    await userEvent.type(d.getByLabelText(/^Nombre/), 'Ventas 2');
    await userEvent.type(d.getByLabelText(/Token nuevo/), 'EAAG-otro-token-permanente-9999');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ name: 'Ventas 2', access_token: 'EAAG-otro-token-permanente-9999' });
    expect(await screen.findByRole('listitem', { name: 'Ventas 2' })).toBeInTheDocument();
  });

  it('desconectar pide confirmación; «No» la cancela; al confirmar la conexión desaparece', async () => {
    const s = server([channel()]);
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Desconectar Ventas' }));
    expect(screen.getByText(/Se borra el token guardado y el número queda libre/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(api.count('DELETE /channels/ch1')).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Desconectar Ventas' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, desconectar' }));
    expect(await screen.findByText(/Aún no hay números conectados/)).toBeInTheDocument();
    expect(api.count('DELETE /channels/ch1')).toBe(1);
  });

  it('si Meta no responde al comprobar se avisa sin perder la conexión', async () => {
    const s = server([channel()]);
    s.routes['POST /channels/ch1/check'] = () => err(503, 'CHANNEL_PROVIDER_UNAVAILABLE', 'No pudimos hablar con Meta en este momento. Inténtalo de nuevo en unos minutos');
    mockApi(s.routes);
    renderApp('/settings/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Comprobar Ventas' }));
    expect(await screen.findByText(/No pudimos hablar con Meta/)).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Ventas' })).toBeInTheDocument();
  });

  it('sin la clave de cifrado de la plataforma no se puede conectar y se explica sin nombrar variables internas', async () => {
    mockApi(server([], { vault: false }).routes);
    renderApp('/settings/connections');
    expect(await screen.findByText(/la plataforma aún no tiene configurado el cifrado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conectar un número' })).toBeDisabled();
    expect(document.body.textContent).not.toContain('PROVIDER_CREDENTIALS_KEY');
  });

  it('sin permiso (403) se explica y no se ofrece conectar nada', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /channels': () => err(403, 'FORBIDDEN'), 'GET /queues': () => err(403, 'FORBIDDEN') });
    renderApp('/settings/connections');
    expect(await screen.findByRole('alert')).toHaveTextContent('Solo el administrador de la empresa puede ver y cambiar las conexiones.');
    expect(screen.queryByRole('button', { name: 'Conectar un número' })).not.toBeInTheDocument();
  });
});
