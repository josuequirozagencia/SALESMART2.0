import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelList, Queue, Template, TemplateList } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const TOKEN = 'EAAG-token-permanente-de-prueba-0042';
const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'ch1', provider: 'meta_cloud', is_official: true, name: 'Ventas', status: 'active', waba_id: '1234567890123', phone_number_id: '1090123456789',
  display_phone: '+593 98 421 7730', verified_name: 'Barbería Norte', token_last4: '0042', last_check_at: '2026-10-18T15:00:00.000Z', last_error: null, last_event_at: null, queue_id: null,
  created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z', ...over,
});

const queue = (id: string, name: string): Queue => ({ id, name, color: '#7c5cfa', distribution_on: true, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3, greeting: null, out_of_hours_message: null, auto_close_hours: 0, hours: null, open_now: true, members: [], channels: [], unassigned_count: 0, created_at: '2026-10-18T15:00:00.000Z', updated_at: '2026-10-18T15:00:00.000Z' });
const QUEUES = [queue('q1', 'Ventas'), queue('q2', 'Soporte')];

function server(initial: Channel[] = [], opts: { vault?: boolean } = {}) {
  const s = { items: initial, vault: opts.vault ?? true, routes: {} as Record<string, Handler>, bodies: [] as unknown[] };
  const list = (): { body: ChannelList } => ({ body: { items: s.items, vault: { available: s.vault } } });
  s.routes = {
    ...authed(ME_ADMIN),
    'GET /channels': () => list(),
    'GET /queues': () => ({ body: { items: QUEUES, limits: { max_queues: 20 } } }),
    'GET /qr-channels': () => ({ body: { items: [], available: true, limits: { max_channels: 5 } } }),
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

  it('cada conexión dice a qué cola va; al conectar o editar se elige el departamento por defecto y se manda solo si cambió', async () => {
    const s = server([channel({ queue_id: 'q1' }), channel({ id: 'ch2', name: 'Soporte técnico', phone_number_id: '1090123456780' })]);
    const api = mockApi(s.routes);
    renderApp('/settings/connections');
    const ventas = within(await screen.findByRole('listitem', { name: 'Ventas' }));
    expect(ventas.getByText('Departamento').nextElementSibling).toHaveTextContent('Ventas');
    expect(within(screen.getByRole('listitem', { name: 'Soporte técnico' })).getByText('Departamento').nextElementSibling).toHaveTextContent('sin departamento');
    // editar: sin tocar el departamento no se manda; cambiarla sí; «Sin departamento» la quita
    await userEvent.click(screen.getByRole('button', { name: 'Editar Ventas' }));
    let d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    expect(d.getByLabelText('Departamento por defecto')).toHaveValue('q1');
    await userEvent.selectOptions(d.getByLabelText('Departamento por defecto'), 'q2');
    await userEvent.click(d.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PATCH /channels/ch1')!.body).toEqual({ queue_id: 'q2' });
    await userEvent.click(screen.getByRole('button', { name: 'Editar Ventas' }));
    d = within(await screen.findByRole('dialog', { name: 'Editar conexión' }));
    await userEvent.selectOptions(d.getByLabelText('Departamento por defecto'), '');
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
    expect(d.getByLabelText('Departamento por defecto')).toHaveValue(''); // sin departamento por omisión
    await userEvent.type(d.getByLabelText(/^Nombre/), 'Ventas');
    await userEvent.type(d.getByLabelText(/WABA ID/), '1234567890123');
    await userEvent.type(d.getByLabelText(/Phone number ID/), '1090123456789');
    await userEvent.type(d.getByLabelText(/Token de acceso permanente/), TOKEN);
    await userEvent.selectOptions(d.getByLabelText('Departamento por defecto'), 'q2');
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
    mockApi({ ...authed(ME_ADMIN), 'GET /channels': () => err(403, 'FORBIDDEN'), 'GET /queues': () => err(403, 'FORBIDDEN'), 'GET /qr-channels': () => err(403, 'FORBIDDEN') });
    renderApp('/settings/connections');
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('Solo el administrador de la empresa puede ver y cambiar las conexiones.');
    expect(screen.queryByRole('button', { name: 'Conectar un número' })).not.toBeInTheDocument();
  });
});

describe('Plantillas de una conexión (M5.6a)', () => {
  const tpl = (over: Partial<Template> = {}): Template => ({
    id: 't1', channel_id: 'ch1', name: 'recordatorio_cita', language: 'es', category: 'utility', status: 'approved', parameter_format: 'positional', header: null, body: 'Hola {{1}}, tu cita es el {{2}}.', footer: null, buttons: [],
    variables: [{ id: 'body:1', part: 'body', key: '1', buttonIndex: null, example: 'Ana' }, { id: 'body:2', part: 'body', key: '2', buttonIndex: null, example: 'viernes' }],
    sendable: true, unsupported_reason: null, rejected_reason: null, synced_at: '2026-10-19T15:00:00.000Z', ...over,
  });
  const ITEMS: Template[] = [
    tpl(),
    tpl({ id: 't2', name: 'promo_corte', category: 'marketing', body: 'Este mes, 20% de descuento.', variables: [] }),
    tpl({ id: 't3', name: 'en_revision', status: 'pending', sendable: false, unsupported_reason: 'Meta todavía la está revisando', variables: [] }),
    tpl({ id: 't4', name: 'rechazada_ejemplo', category: 'marketing', status: 'rejected', sendable: false, unsupported_reason: 'Meta la rechazó: Contenido promocional', rejected_reason: 'Contenido promocional', variables: [] }),
  ];

  function withTemplates(initial: TemplateList, opts: { syncError?: () => ReturnType<Handler> } = {}) {
    const s = server([channel()]);
    const st = { list: initial, syncs: 0 };
    s.routes['GET /channels/ch1/templates'] = () => ({ body: st.list });
    s.routes['POST /channels/ch1/templates/sync'] = () => {
      st.syncs += 1;
      if (opts.syncError) return opts.syncError();
      st.list = { items: [...ITEMS, tpl({ id: 't5', name: 'nueva', variables: [] })], synced_at: '2026-10-19T16:00:00.000Z', sync_error: null };
      return { body: { synced_at: '2026-10-19T16:00:00.000Z', total: 5, added: 1, updated: 0, removed: 0 } };
    };
    return { routes: s.routes, st };
  }
  const openDialog = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Plantillas de Ventas' }));
    return within(await screen.findByRole('dialog', { name: 'Plantillas de Ventas' }));
  };

  it('muestra las plantillas de la conexión con su categoría, su estado y por qué no se pueden enviar las que no', async () => {
    mockApi(withTemplates({ items: ITEMS, synced_at: '2026-10-19T15:00:00.000Z', sync_error: null }).routes);
    renderApp('/settings/connections');
    const d = await openDialog();
    const list = within(await d.findByRole('list', { name: 'Plantillas de la conexión' }));
    expect(list.getAllByRole('listitem')).toHaveLength(4);
    const cita = within(list.getAllByRole('listitem')[0]!);
    expect(cita.getByText('recordatorio_cita')).toBeInTheDocument();
    expect(cita.getByText('Utilidad')).toBeInTheDocument();
    expect(cita.getByText('Aprobada')).toBeInTheDocument();
    expect(cita.getByText('Se puede enviar')).toBeInTheDocument();
    const review = within(list.getAllByRole('listitem')[2]!);
    expect(review.getByText('En revisión')).toBeInTheDocument();
    expect(review.getByText('Meta todavía la está revisando')).toBeInTheDocument();
    const rejected = within(list.getAllByRole('listitem')[3]!);
    expect(rejected.getByText('Rechazada')).toBeInTheDocument();
    expect(rejected.getByText('Meta la rechazó: Contenido promocional')).toBeInTheDocument();
    expect(d.getByText(/Última sincronización:/)).toBeInTheDocument();
  });

  it('«Sincronizar ahora» vuelve a pedirlas a Meta, cuenta lo que cambió y actualiza la lista', async () => {
    const s = withTemplates({ items: ITEMS, synced_at: '2026-10-19T15:00:00.000Z', sync_error: null });
    mockApi(s.routes);
    renderApp('/settings/connections');
    const d = await openDialog();
    await d.findByRole('list', { name: 'Plantillas de la conexión' });
    await userEvent.click(d.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(await d.findByText('Sincronizadas 5 plantillas: 1 nuevas, 0 con cambios y 0 que ya no están en Meta.')).toBeInTheDocument();
    expect(s.st.syncs).toBe(1);
    await waitFor(() => expect(within(d.getByRole('list', { name: 'Plantillas de la conexión' })).getAllByRole('listitem')).toHaveLength(5));
  });

  it('sin plantillas lo dice; si la última sincronización falló, muestra el motivo; si sincronizar falla, explica por qué', async () => {
    const s = withTemplates({ items: [], synced_at: null, sync_error: 'Meta rechazó el token: genera uno nuevo y pégalo' }, { syncError: () => err(409, 'CHANNEL_TOKEN_INVALID', 'Meta rechazó el token: genera uno nuevo y pégalo') });
    mockApi(s.routes);
    renderApp('/settings/connections');
    const d = await openDialog();
    expect(await d.findByText('Esta conexión no tiene plantillas todavía.')).toBeInTheDocument();
    expect(d.getByText('Aún no se han sincronizado.')).toBeInTheDocument();
    expect(d.getByText(/La última sincronización falló: Meta rechazó el token/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(await d.findAllByText(/Meta rechazó el token: genera uno nuevo y pégalo/)).not.toHaveLength(0);
  });
});

describe('Configuración › Conexiones como tarjetas (M5.9)', () => {
  const ghlOk = { configured: true, available: true, auth_type: 'private_token', status: 'active', location_id: 'loc1', token_last4: '1234', last_error: null, last_check_at: null, webhook: { configured: true, id: 'w1', path: '/x', created_at: null, rotated_at: null, last_used_at: null } };
  const metaOff = { configured: false, available: true, dataset_id: null, token_last4: null, grace_minutes: 30, test_event_code: null, enabled: false, last_error: null, last_check_at: null, counts: {} };
  const full = (s: ReturnType<typeof server>, over: Record<string, Handler> = {}): Record<string, Handler> => ({
    ...s.routes,
    'GET /ghl/connection': () => ({ body: ghlOk }),
    'GET /meta/settings': () => ({ body: metaOff }),
    ...over,
  });

  it('muestra CANALES (cada número, WhatsApp oficial, QR, Messenger, Instagram y TikTok) e INTEGRACIONES (GoHighLevel, API de Conversiones y Calendario de Google) con su estado', async () => {
    mockApi(full(server([channel(), channel({ id: 'ch2', name: 'Soporte', last_error: 'Token vencido' })])));
    renderApp('/settings/connections');
    const canales = within(await screen.findByRole('region', { name: 'Canales' }));
    expect(canales.getByRole('listitem', { name: 'Ventas' })).toBeInTheDocument();
    expect(within(canales.getByRole('listitem', { name: 'Soporte' })).getByText('Requiere atención')).toBeInTheDocument();
    expect(within(canales.getByRole('listitem', { name: 'WhatsApp oficial' })).getByText('Conectada')).toBeInTheDocument();
    expect(within(canales.getByRole('listitem', { name: 'WhatsApp por QR' })).getByText('No conectada')).toBeInTheDocument();
    for (const n of ['Messenger', 'Instagram', 'TikTok']) expect(within(canales.getByRole('listitem', { name: n })).getByText('Próximamente')).toBeInTheDocument();
    const integ = within(screen.getByRole('region', { name: 'Integraciones' }));
    expect(within(integ.getByRole('listitem', { name: 'GoHighLevel' })).getByText('Conectada')).toBeInTheDocument();
    expect(within(integ.getByRole('listitem', { name: 'API de Conversiones de Meta' })).getByText('No conectada')).toBeInTheDocument();
    expect(within(integ.getByRole('listitem', { name: 'Calendario de Google' })).getByText('Próximamente')).toBeInTheDocument();
    expect(integ.getByRole('link', { name: 'Configurar GoHighLevel' })).toHaveAttribute('href', '/settings/ghl');
    expect(integ.getByRole('link', { name: 'Configurar la API de Conversiones' })).toHaveAttribute('href', '/settings/meta');
  });

  it('la tarjeta de WhatsApp por QR lleva SIEMPRE el aviso de que no es oficial, esté conectada o no', async () => {
    const warning = 'No es la API oficial de WhatsApp. WhatsApp puede bloquear o suspender el número, la sesión puede desconectarse y no hay plantillas aprobadas. No lo uses con tu número principal.';
    mockApi(full(server(), { 'GET /qr-channels': () => ({ body: { items: [{ id: 'q1', provider: 'evolution', is_official: false, name: 'Chip nuevo', state: 'open', phone: '+593999', profile_name: null, queue_id: null, connected_at: null, last_event_at: null, down_since: null, last_error: null, warmup: { day: 1, daily_limit: 20 }, created_at: '' }], available: true, limits: { max_channels: 5 } } }) }));
    renderApp('/settings/connections');
    const qr = within(await screen.findByRole('listitem', { name: 'WhatsApp por QR' }));
    expect(qr.getByText(warning)).toBeInTheDocument();
    expect(qr.getByText('No oficial')).toBeInTheDocument();
    await waitFor(() => expect(qr.getByText('Conectada')).toBeInTheDocument());
  });

  it('el buscador filtra canales e integraciones por nombre y avisa cuando nada coincide', async () => {
    mockApi(full(server([channel()])));
    renderApp('/settings/connections');
    await screen.findByRole('listitem', { name: 'Messenger' });
    const box = screen.getByRole('searchbox', { name: 'Buscar conexiones' });
    await userEvent.type(box, 'gohigh');
    expect(screen.queryByRole('listitem', { name: 'Messenger' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'GoHighLevel' })).toBeInTheDocument();
    expect(screen.getByText(/Ningún canal coincide con «gohigh»/)).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText(/Ninguna integración coincide/)).toBeInTheDocument();
  });

  it('una integración con error muestra «Requiere atención» y su motivo', async () => {
    mockApi(full(server(), { 'GET /ghl/connection': () => ({ body: { ...ghlOk, status: 'needs_reconnect', last_error: 'El token fue rechazado' } }) }));
    renderApp('/settings/connections');
    const card = within(await screen.findByRole('listitem', { name: 'GoHighLevel' }));
    await waitFor(() => expect(card.getByText('Requiere atención')).toBeInTheDocument());
    expect(card.getByText('El token fue rechazado')).toBeInTheDocument();
  });
});
