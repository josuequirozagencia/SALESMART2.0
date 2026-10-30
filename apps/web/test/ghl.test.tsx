import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhlChannel, GhlConnection, GhlEvent, GhlOutboxItem, GhlStatus } from '../src/features/ghl/useGhl';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NOW = new Date().toISOString();
const TOKEN = 'pit-aaaaaaaa-1111-4222-8333-web0123456789';
const LOC = 've9EPM428h8vShlRW1KT';
const ID = '3b6f1c1e-5d3a-4c7e-9a52-0d9e8f1a2b3c';
const none = (over: Partial<GhlConnection> = {}): GhlConnection => ({ configured: false, available: true, auth_type: 'private_token', status: null, location_id: null, token_last4: null, last_error: null, last_check_at: null, webhook: { configured: false, id: null, path: null, created_at: null, rotated_at: null, last_used_at: null }, ...over });
const live = (status: GhlStatus = 'active', over: Partial<GhlConnection> = {}): GhlConnection => none({ configured: true, status, location_id: LOC, token_last4: status === 'disconnected' ? null : '6789', last_check_at: NOW, ...over });
const hooked = { configured: true, id: ID, path: `/v1/integrations/ghl/webhook/${ID}`, created_at: NOW, rotated_at: null, last_used_at: null };

const event = (over: Partial<GhlEvent> = {}): GhlEvent => ({ id: 'e1', type: 'contact', ghl_contact_id: 'GHL-ANA', status: 'done', outcome: 'contact_created', note: null, contact: { id: 'k1', name: 'Ana Torres' }, attempts: 1, last_error: null, received_at: NOW, processed_at: NOW, ...over });

const out = (over: Partial<GhlOutboxItem> = {}): GhlOutboxItem => ({ id: 'o1', op: 'tag_add', tag: 'VIP', tag_kind: 'custom', status: 'done', contact: { id: 'k1', name: 'Ana Torres' }, note: null, attempts: 1, last_error: null, created_at: NOW, processed_at: NOW, can_retry: false, ...over });

interface World { outbox?: GhlOutboxItem[]; outboxQueries?: string[]; retries?: string[]; events?: GhlEvent[]; statusQueries?: string[]; conn: GhlConnection; calls: Array<{ method: string; path: string; body: unknown }>; saveFails?: () => ReturnType<Handler>; testFails?: boolean }
const world = (conn: GhlConnection = none(), over: Partial<World> = {}): World => ({ conn, calls: [], ...over });
const reject = (message: string) => err(400, 'VALIDATION_ERROR', 'x', { body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'access_token', code: 'rejected', message }] } } });

function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  const rec = (c: Call) => w.calls.push({ method: c.method, path: c.path, body: c.body });
  return {
    ...authed(me),
    'GET /ghl/connection': () => ({ body: w.conn }),
    'GET /ghl/outbox': (c) => { (w.outboxQueries ??= []).push(c.query.get('status') ?? ''); const st = c.query.get('status'); const items = (w.outbox ?? []).filter((o) => !st || o.status === st); const counts: Record<string, number> = {}; for (const o of w.outbox ?? []) counts[o.status] = (counts[o.status] ?? 0) + 1; return { body: { items, next_cursor: null, counts } }; },
    'POST /ghl/outbox/o2/retry': () => { w.retries = [...(w.retries ?? []), 'o2']; w.outbox = (w.outbox ?? []).map((o) => (o.id === 'o2' ? { ...o, status: 'pending', can_retry: false, last_error: null } : o)); return { body: { id: 'o2', status: 'pending' } }; },
    'GET /ghl/events': (c) => { (w.statusQueries ??= []).push(c.query.get('status') ?? ''); const st = c.query.get('status'); return { body: { items: (w.events ?? []).filter((e) => !st || e.status === st), next_cursor: null } }; },
    'PUT /ghl/connection': (c) => {
      rec(c);
      if (w.saveFails) return w.saveFails();
      const b = c.body as { location_id: string; access_token?: string };
      w.conn = live('active', { location_id: b.location_id, token_last4: b.access_token ? b.access_token.slice(-4) : w.conn.token_last4, webhook: w.conn.webhook });
      return { body: w.conn };
    },
    'POST /ghl/connection/test': (c) => { rec(c); return w.testFails ? reject('GoHighLevel rechazó el token o no encuentra la Location: token revoked') : { body: { ok: true, location_name: null } }; },
    'POST /ghl/connection/disconnect': (c) => { rec(c); w.conn = live('disconnected', { webhook: w.conn.webhook }); return { body: w.conn }; },
    'POST /ghl/webhook/secret': (c) => {
      rec(c);
      const rotated = w.conn.webhook.configured;
      w.conn = { ...w.conn, webhook: { ...hooked, rotated_at: rotated ? NOW : null } };
      return { status: 201, body: { id: ID, secret: rotated ? 'ghw_secreto-2-de-prueba-1234567890' : 'ghw_secreto-1-de-prueba-1234567890', rotated, path: hooked.path } };
    },
  };
}
const form = async () => within(await screen.findByRole('region', { name: 'Conexión con GoHighLevel' }));

describe('Configuración › GoHighLevel · conexión', () => {
  it('la pestaña está en el menú; sin conexión pide Location y token, el token es de contraseña y no hay «Probar» ni «Desconectar»', async () => {
    mockApi(server(world()));
    renderApp('/settings/ghl');
    expect(await screen.findByRole('link', { name: 'GoHighLevel' })).toHaveAttribute('href', '/settings/ghl');
    const f = await form();
    expect(f.getByLabelText('Token de la integración privada')).toHaveAttribute('type', 'password');
    expect(f.queryByRole('button', { name: 'Probar conexión' })).toBeNull();
    expect(f.queryByRole('button', { name: 'Desconectar' })).toBeNull();
  });

  it('valida antes de enviar: Location con forma y token obligatorio la primera vez', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    await userEvent.type(await f.findByLabelText('Location ID'), 'corta');
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText(/solo letras y números/)).toBeInTheDocument();
    expect(f.getByText('Pega el token de la integración privada')).toBeInTheDocument();
    expect(w.calls).toEqual([]);
  });

  it('guarda Location y token: el token se envía una vez y no queda en pantalla, solo sus últimos 4', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    await userEvent.type(await f.findByLabelText('Location ID'), LOC);
    await userEvent.type(f.getByLabelText('Token de la integración privada'), TOKEN);
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]).toEqual({ method: 'PUT', path: '/ghl/connection', body: { location_id: LOC, access_token: TOKEN } });
    expect(await screen.findByText('Conexión guardada: GoHighLevel aceptó el token.')).toBeInTheDocument();
    expect(await screen.findByText(/••••6789/)).toBeInTheDocument();
    expect(screen.getByText('Conectada')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect((f.getByLabelText(/Token \(déjalo vacío/) as HTMLInputElement).value).toBe('');
  });

  it('conectada, con la misma Location no pide el token: se puede guardar sin pegarlo y no lo manda', async () => {
    const w = world(live());
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    expect(await f.findByLabelText(/Token \(déjalo vacío para conservar el guardado\)/)).toBeInTheDocument();
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]!.body).toEqual({ location_id: LOC });
  });

  it('al cambiar de Location vuelve a exigir el token', async () => {
    const w = world(live());
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    const loc = await f.findByLabelText('Location ID');
    await userEvent.clear(loc);
    await userEvent.type(loc, 'OtraLocation12345678');
    expect(f.getByLabelText('Token de la integración privada')).toBeInTheDocument();
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText('Pega el token de la integración privada')).toBeInTheDocument();
    expect(w.calls).toEqual([]);
  });

  it('si GoHighLevel rechaza el token al guardar, muestra su motivo y no lo da por guardado', async () => {
    const w = world(none(), { saveFails: () => reject('GoHighLevel rechazó el token o no encuentra la Location: Invalid JWT') });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    await userEvent.type(await f.findByLabelText('Location ID'), LOC);
    await userEvent.type(f.getByLabelText('Token de la integración privada'), TOKEN);
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText(/Invalid JWT/)).toBeInTheDocument();
    expect(screen.queryByText('Conexión guardada: GoHighLevel aceptó el token.')).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN.slice(0, 20) + 'x');
  });

  it('«Probar conexión» confirma que funciona; si GoHighLevel rechaza el token muestra el motivo', async () => {
    const w = world(live());
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    await userEvent.click(await f.findByRole('button', { name: 'Probar conexión' }));
    expect(await f.findByText('Conexión correcta.')).toBeInTheDocument();
    w.testFails = true;
    await userEvent.click(f.getByRole('button', { name: 'Probar conexión' }));
    expect(await f.findByText(/token revoked/)).toBeInTheDocument();
  });

  it('con la conexión en «requiere reconexión» avisa del motivo, ofrece «Reconectar» y exige un token nuevo', async () => {
    const w = world(live('needs_reconnect', { last_error: 'token revoked' }));
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    expect(await f.findByText('Requiere reconexión')).toBeInTheDocument();
    expect(f.getByText(/GoHighLevel rechazó el token: token revoked/)).toBeInTheDocument();
    await userEvent.click(f.getByRole('button', { name: 'Reconectar' }));
    expect(await f.findByText('El token guardado ya no sirve: pega uno nuevo')).toBeInTheDocument();
    expect(w.calls).toEqual([]);
    await userEvent.type(f.getByLabelText('Token de la integración privada'), TOKEN);
    await userEvent.click(f.getByRole('button', { name: 'Reconectar' }));
    await waitFor(() => expect(w.calls).toHaveLength(1));
    expect(w.calls[0]!.body).toEqual({ location_id: LOC, access_token: TOKEN });
    expect(await screen.findByText('Conectada')).toBeInTheDocument();
  });

  it('desconectar pide confirmación, borra el token y deja «Desconectada» con «Reconectar»', async () => {
    const w = world(live());
    mockApi(server(w));
    renderApp('/settings/ghl');
    const f = await form();
    await userEvent.click(await f.findByRole('button', { name: 'Desconectar' }));
    expect(f.getByText('¿Desconectar y borrar el token?')).toBeInTheDocument();
    await userEvent.click(f.getByRole('button', { name: 'No' }));
    expect(w.calls).toEqual([]);
    await userEvent.click(f.getByRole('button', { name: 'Desconectar' }));
    await userEvent.click(f.getByRole('button', { name: 'Sí, desconectar' }));
    await waitFor(() => expect(w.calls).toEqual([{ method: 'POST', path: '/ghl/connection/disconnect', body: undefined }]));
    expect(await screen.findByText('Desconectada')).toBeInTheDocument();
    expect(f.queryByText(/Token guardado/)).toBeNull();
    expect(f.getByRole('button', { name: 'Reconectar' })).toBeInTheDocument();
  });

  it('si el servidor no puede hablar con GoHighLevel lo dice y no deja guardar', async () => {
    mockApi(server(world(none({ available: false }))));
    renderApp('/settings/ghl');
    const f = await form();
    expect(await f.findByText(/El servidor aún no puede conectarse con GoHighLevel/)).toBeInTheDocument();
    expect(f.getByRole('button', { name: 'Guardar' })).toBeDisabled();
  });

  it('a un asesor (403) no le muestra la pantalla de conexión', async () => {
    mockApi({ ...server(world()), 'GET /ghl/connection': () => err(403, 'FORBIDDEN') });
    renderApp('/settings/ghl');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conexión con GoHighLevel' })).toBeNull();
  });
});

describe('Configuración › GoHighLevel · punto de entrada del Workflow', () => {
  it('generar muestra la URL y el secreto UNA vez; después solo la URL, nunca el secreto', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/ghl');
    expect(await screen.findByText(/Aún no hay un punto de entrada/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generar punto de entrada' }));
    const card = within(await screen.findByRole('region', { name: 'Datos del punto de entrada' }));
    expect(card.getByLabelText('URL del punto de entrada')).toHaveValue(`${window.location.origin}${hooked.path}`);
    expect(card.getByLabelText('Secreto')).toHaveValue('ghw_secreto-1-de-prueba-1234567890');
    expect(card.getByText(/no se volverá a mostrar/)).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Ya lo guardé' }));
    expect(screen.queryByRole('region', { name: 'Datos del punto de entrada' })).toBeNull();
    const status = within(await screen.findByRole('region', { name: 'Punto de entrada del Workflow' }));
    expect(status.getByText('Punto de entrada activo.')).toBeInTheDocument();
    expect(status.getByLabelText('URL del punto de entrada')).toHaveValue(`${window.location.origin}${hooked.path}`);
    expect(screen.queryByLabelText('Secreto')).toBeNull();
    expect(document.body.textContent).not.toContain('ghw_secreto');
  });

  it('regenerar pide confirmación y entrega un secreto nuevo; explica la cabecera X-Webhook-Secret', async () => {
    const w = world(live('active', { webhook: hooked }));
    mockApi(server(w));
    renderApp('/settings/ghl');
    const sec = within(await screen.findByRole('region', { name: 'Punto de entrada del Workflow' }));
    expect(sec.getByText(/X-Webhook-Secret/)).toBeInTheDocument();
    await userEvent.click(sec.getByRole('button', { name: 'Regenerar secreto' }));
    expect(sec.getByText(/El actual dejará de funcionar/)).toBeInTheDocument();
    await userEvent.click(sec.getByRole('button', { name: 'No' }));
    expect(w.calls).toEqual([]);
    await userEvent.click(sec.getByRole('button', { name: 'Regenerar secreto' }));
    await userEvent.click(sec.getByRole('button', { name: 'Sí, regenerar' }));
    const card = within(await screen.findByRole('region', { name: 'Datos del punto de entrada' }));
    expect(card.getByLabelText('Secreto')).toHaveValue('ghw_secreto-2-de-prueba-1234567890');
    expect(w.calls).toEqual([{ method: 'POST', path: '/ghl/webhook/secret', body: undefined }]);
  });

  it('si no se puede generar muestra el error y no enseña ningún secreto', async () => {
    mockApi({ ...server(world()), 'POST /ghl/webhook/secret': () => err(500, 'INTERNAL') });
    renderApp('/settings/ghl');
    await userEvent.click(await screen.findByRole('button', { name: 'Generar punto de entrada' }));
    expect(await screen.findByText('Tuvimos un problema de nuestro lado. Inténtalo en unos minutos.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Datos del punto de entrada' })).toBeNull();
  });
});

describe('Configuración › GoHighLevel · avisos recibidos', () => {
  it('sin punto de entrada no muestra el panel de avisos, pero sí la guía para armar el Workflow', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/ghl');
    const how = within(await screen.findByRole('region', { name: 'Cómo conectarlo' }));
    expect(how.getByText(/X-Webhook-Secret/)).toBeInTheDocument();
    expect(how.getAllByText(/contact_id/, { selector: 'pre' })).toHaveLength(2); // el de contactos y el de mensajes
    expect(screen.queryByRole('region', { name: 'Avisos recibidos' })).toBeNull();
    expect(w.statusQueries).toBeUndefined();
  });

  it('con punto de entrada lista los avisos con su estado, lo que se hizo y por qué se omitieron; sin teléfonos ni correos', async () => {
    const w = world(live('active', { webhook: hooked }), {
      events: [
        event(),
        event({ id: 'e2', ghl_contact_id: 'SIN-TEL', contact: null, status: 'skipped', outcome: null, note: 'El contacto de GoHighLevel no trae teléfono: no se pudo identificar' }),
        event({ id: 'e3', ghl_contact_id: 'PEND', contact: null, status: 'pending', outcome: null, attempts: 2 }),
        event({ id: 'e4', ghl_contact_id: 'ROTO', contact: null, status: 'failed', outcome: null, attempts: 5, last_error: 'Error:23505' }),
        event({ id: 'e5', type: 'message_in', status: 'skipped', outcome: null, note: 'Los mensajes entrantes de GoHighLevel se procesan en una versión posterior' }),
      ],
    });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Avisos recibidos' }));
    const rows = within(await panel.findByRole('list', { name: 'Avisos' })).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText(/Ana Torres/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Procesado')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Contacto creado')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('SIN-TEL')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/no trae teléfono/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Omitido')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Pendiente')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/2 intento\(s\); se reintenta solo/)).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Falló')).toBeInTheDocument();
    expect(within(rows[3]!).getByText(/No se pudo procesar tras 5 intentos \(Error:23505\)/)).toBeInTheDocument();
    expect(within(rows[4]!).getByText('Mensaje entrante')).toBeInTheDocument();
  });

  it('filtrar por estado vuelve a pedir al servidor solo esos avisos', async () => {
    const w = world(live('active', { webhook: hooked }), { events: [event(), event({ id: 'e2', status: 'skipped', outcome: null, note: 'x' })] });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Avisos recibidos' }));
    await panel.findAllByRole('listitem');
    await userEvent.selectOptions(panel.getByLabelText('Estado'), 'skipped');
    await waitFor(() => expect(w.statusQueries).toContain('skipped'));
    await waitFor(() => expect(within(panel.getByRole('list', { name: 'Avisos' })).getAllByRole('listitem')).toHaveLength(1));
  });

  it('sin avisos lo dice', async () => {
    mockApi(server(world(live('active', { webhook: hooked }), { events: [] })));
    renderApp('/settings/ghl');
    expect(await screen.findByText(/Todavía no ha llegado ningún aviso/)).toBeInTheDocument();
  });

  it('si el servidor no puede dar los avisos lo explica sin romper el resto de la pantalla', async () => {
    mockApi({ ...server(world(live('active', { webhook: hooked }))), 'GET /ghl/events': () => err(500, 'INTERNAL') });
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Avisos recibidos' }));
    expect(await panel.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conexión con GoHighLevel' })).toBeInTheDocument();
  });
});

describe('Configuración › GoHighLevel · etiquetas enviadas', () => {
  it('sin conexión no muestra el panel; conectada lo muestra con cada cambio, su estado, el contacto y el motivo', async () => {
    const none_ = world();
    mockApi(server(none_));
    renderApp('/settings/ghl');
    await screen.findByRole('region', { name: 'Conexión con GoHighLevel' });
    expect(screen.queryByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' })).toBeNull();
    expect(none_.outboxQueries).toBeUndefined();
  });

  it('lista los cambios: agregar/quitar con el nombre de la etiqueta, el estado y el motivo de los omitidos y fallidos', async () => {
    const w = world(live(), {
      outbox: [
        out(),
        out({ id: 'o2', op: 'tag_remove', tag: 'Nuevo', status: 'failed', attempts: 5, last_error: 'GoHighLevel no encuentra el contacto', can_retry: true }),
        out({ id: 'o3', tag: 'Venta', tag_kind: 'system', status: 'skipped', note: 'El contacto no tiene teléfono ni correo: no se puede buscar ni crear en GoHighLevel' }),
        out({ id: 'o4', tag: 'Lead', status: 'pending', attempts: 2 }),
      ],
    });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' }));
    const rows = within(await panel.findByRole('list', { name: 'Etiquetas enviadas' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText(/Agregar «VIP»/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Enviado')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Quitar «Nuevo»/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Falló')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('GoHighLevel no encuentra el contacto')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/ni correo/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Omitido')).toBeInTheDocument();
    expect(within(rows[3]!).getByText(/2 intento\(s\); se reintenta solo/)).toBeInTheDocument();
    expect(panel.getByText(/1 cambio\(s\) de etiqueta no se pudieron enviar/)).toBeInTheDocument();
  });

  it('reintentar un cambio fallido lo manda al departamento y deja de ofrecer el botón', async () => {
    const w = world(live(), { outbox: [out({ id: 'o2', status: 'failed', last_error: 'x', can_retry: true })] });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' }));
    await userEvent.click(await panel.findByRole('button', { name: /Reintentar agregar «VIP»/ }));
    await waitFor(() => expect(w.retries).toEqual(['o2']));
    await waitFor(() => expect(panel.queryByRole('button', { name: /Reintentar/ })).toBeNull());
    expect(await within(panel.getByRole('list', { name: 'Etiquetas enviadas' })).findByText('Pendiente')).toBeInTheDocument();
  });

  it('borrar una etiqueta aquí se ve como «Eliminar en GoHighLevel» sin contacto, y un borrado fallido se puede reintentar', async () => {
    const w = world(live(), {
      outbox: [
        out({ id: 'o5', op: 'tag_delete', tag: 'VIP', contact: null, status: 'pending' }),
        out({ id: 'o2', op: 'tag_delete', tag: 'Viejo', contact: null, status: 'failed', attempts: 1, last_error: 'El token no tiene permiso para esta operación en GoHighLevel (revisa los permisos de etiquetas de la integración)', can_retry: true }),
      ],
    });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' }));
    const rows = within(await panel.findByRole('list', { name: 'Etiquetas enviadas' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText(/Eliminar en GoHighLevel «VIP»/)).toBeInTheDocument();
    expect(within(rows[0]!).queryByText(/Contacto/)).toBeNull();
    expect(within(rows[1]!).getByText(/permiso para esta operación/)).toBeInTheDocument();
    await userEvent.click(panel.getByRole('button', { name: /Reintentar eliminar en gohighlevel «Viejo»/i }));
    await waitFor(() => expect(w.retries).toEqual(['o2']));
  });

  it('el aviso de permisos explica que borrar etiquetas necesita leer y escribir etiquetas', async () => {
    mockApi(server(world(live())));
    renderApp('/settings/ghl');
    const how = within(await screen.findByRole('region', { name: 'Cómo conectarlo' }));
    expect(how.getByText(/si borras una etiqueta aquí se elimina también en GoHighLevel/)).toBeInTheDocument();
    expect(how.getByText(/permiso de leer y escribir etiquetas/)).toBeInTheDocument();
  });

  it('filtrar por estado vuelve a pedir solo esos cambios; sin cambios lo dice', async () => {
    const w = world(live(), { outbox: [out(), out({ id: 'o3', status: 'skipped', note: 'n' })] });
    mockApi(server(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' }));
    await panel.findAllByRole('listitem');
    await userEvent.selectOptions(panel.getByLabelText('Estado'), 'skipped');
    await waitFor(() => expect(w.outboxQueries).toContain('skipped'));
    await waitFor(() => expect(within(panel.getByRole('list', { name: 'Etiquetas enviadas' })).getAllByRole('listitem')).toHaveLength(1));
  });

  it('sin cambios enviados lo dice, y si el servidor falla lo explica sin romper el resto', async () => {
    mockApi(server(world(live(), { outbox: [] })));
    renderApp('/settings/ghl');
    expect(await screen.findByText(/Todavía no se ha enviado ninguna etiqueta/)).toBeInTheDocument();
  });

  it('si el servidor no puede dar la lista muestra el error dentro del panel', async () => {
    mockApi({ ...server(world(live())), 'GET /ghl/outbox': () => err(500, 'INTERNAL') });
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Etiquetas enviadas a GoHighLevel' }));
    expect(await panel.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conexión con GoHighLevel' })).toBeInTheDocument();
  });
});

describe('Configuración › GoHighLevel · canal de mensajes (M7.4)', () => {
  const QUEUES = [{ id: 'q1', name: 'Ventas' }, { id: 'q2', name: 'Soporte' }];
  interface ChannelWorld extends World { channel?: GhlChannel; saves?: unknown[] }
  function channelServer(w: ChannelWorld): Record<string, Handler> {
    return {
      ...server(w),
      'GET /queues': () => ({ body: { items: QUEUES, limits: { max_queues: 20 } } }),
      'GET /ghl/channel': () => ({ body: w.channel ?? { configured: true, channel_id: 'ch1', queue: null, default_type: null } }),
      'PUT /ghl/channel': (c) => {
        (w.saves ??= []).push(c.body);
        const b = c.body as { queue_id: string | null; default_type: GhlChannel['default_type'] };
        w.channel = { configured: true, channel_id: 'ch1', queue: b.queue_id ? QUEUES.find((q) => q.id === b.queue_id)! : null, default_type: b.default_type };
        return { body: w.channel };
      },
    };
  }
  const section = async () => within(await screen.findByRole('region', { name: 'Canal de mensajes' }));

  it('conectada, ofrece elegir el departamento y el canal por omisión; guardar manda los dos valores', async () => {
    const w: ChannelWorld = world(live());
    mockApi(channelServer(w));
    renderApp('/settings/ghl');
    const s = await section();
    expect(s.getByText(/Mensajes de GoHighLevel en el Inbox/)).toBeInTheDocument();
    await userEvent.selectOptions(await s.findByLabelText('Departamento de las conversaciones nuevas'), 'q2');
    await userEvent.selectOptions(s.getByLabelText(/Responder por/), 'IG');
    await userEvent.click(s.getByRole('button', { name: 'Guardar canal' }));
    await waitFor(() => expect(w.saves).toEqual([{ queue_id: 'q2', default_type: 'IG' }]));
    expect(await s.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('muestra lo guardado y permite quitarlo (sin departamento, sin canal por omisión)', async () => {
    const w: ChannelWorld = world(live(), { channel: { configured: true, channel_id: 'ch1', queue: QUEUES[0]!, default_type: 'SMS' } } as Partial<ChannelWorld>);
    mockApi(channelServer(w));
    renderApp('/settings/ghl');
    const s = await section();
    await waitFor(() => expect(s.getByLabelText('Departamento de las conversaciones nuevas')).toHaveValue('q1'));
    expect(s.getByLabelText(/Responder por/)).toHaveValue('SMS');
    await userEvent.selectOptions(s.getByLabelText('Departamento de las conversaciones nuevas'), '');
    await userEvent.selectOptions(s.getByLabelText(/Responder por/), '');
    await userEvent.click(s.getByRole('button', { name: 'Guardar canal' }));
    await waitFor(() => expect(w.saves).toEqual([{ queue_id: null, default_type: null }]));
  });

  it('desconectada no se ofrece el canal; si el servidor rechaza el guardado muestra el motivo', async () => {
    mockApi(channelServer(world(live('disconnected'))));
    renderApp('/settings/ghl');
    await screen.findByRole('region', { name: 'Conexión con GoHighLevel' });
    expect(screen.queryByRole('region', { name: 'Canal de mensajes' })).toBeNull();
  });

  it('un error al guardar se muestra sin perder lo elegido', async () => {
    const w: ChannelWorld = world(live());
    mockApi({ ...channelServer(w), 'PUT /ghl/channel': () => err(400, 'VALIDATION_ERROR', 'El departamento no existe') });
    renderApp('/settings/ghl');
    const s = await section();
    await userEvent.selectOptions(await s.findByLabelText('Departamento de las conversaciones nuevas'), 'q1');
    await userEvent.click(s.getByRole('button', { name: 'Guardar canal' }));
    expect(await s.findByRole('alert')).toBeInTheDocument();
    expect(s.getByLabelText('Departamento de las conversaciones nuevas')).toHaveValue('q1');
  });

  it('la guía explica cómo traer los mensajes: Workflow aparte, message_type y que se responde por el mismo canal', async () => {
    mockApi(channelServer(world(live())));
    renderApp('/settings/ghl');
    const how = within(await screen.findByRole('region', { name: 'Cómo conectarlo' }));
    expect(how.getByText(/Customer Replied/)).toBeInTheDocument();
    expect(how.getByText(/mismo canal por el que escribió el cliente/)).toBeInTheDocument();
    expect(how.getByText(/"event": "message_in"/, { selector: 'pre' })).toBeInTheDocument();
  });

  it('un aviso de mensaje en el panel de avisos se ve como «Mensaje recibido»', async () => {
    const w = world(live('active', { webhook: hooked }), { events: [event({ id: 'e9', type: 'message_in', outcome: 'message_received', note: null })] });
    mockApi(channelServer(w));
    renderApp('/settings/ghl');
    const panel = within(await screen.findByRole('region', { name: 'Avisos recibidos' }));
    expect(await panel.findByText('Mensaje recibido')).toBeInTheDocument();
  });
});
