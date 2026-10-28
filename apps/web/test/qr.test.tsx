import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QrChannel, QrState } from '../src/features/channels/useQrChannels';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const AT = '2026-10-27T15:00:00.000Z';
const chan = (over: Partial<QrChannel> = {}): QrChannel => ({
  id: 'qc1', provider: 'evolution', is_official: false, name: 'Chip de ventas', state: 'open', phone: '+593990000001', profile_name: 'Negocio', queue_id: null, connected_at: AT, last_event_at: AT,
  down_since: null, last_error: null, warmup: { day: 1, daily_limit: 20 }, created_at: AT, ...over,
});

interface World { items: QrChannel[]; available: boolean; calls: Record<string, Call[]>; qr: string | null; stateAfterQr: QrState | null }
const world = (over: Partial<World> = {}): World => ({ items: [], available: true, calls: {}, qr: 'data:image/png;base64,QRQR', stateAfterQr: null, ...over });
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };

function server(w: World): Record<string, Handler> {
  const guard = (k: string, h: Handler): Handler => (c) => { rec(w, k, c); return h(c); };
  return {
    ...authed(ME_ADMIN),
    'GET /channels': () => ({ body: { items: [], vault: { available: true } } }),
    'GET /queues': () => ({ body: { items: [{ id: 'q1', name: 'Captación' }], limits: { max_queues: 20 } } as never }),
    'GET /qr-channels': () => ({ body: { items: w.items, available: w.available, limits: { max_channels: 5 } } }),
    'POST /qr-channels': guard('create', (c) => {
      const b = c.body as { name: string; queue_id: string | null };
      const ch = chan({ id: 'qc1', name: b.name, state: 'connecting', phone: null, profile_name: null, queue_id: b.queue_id, connected_at: null });
      w.items = [...w.items, ch];
      return { status: 201, body: ch };
    }),
    'GET /qr-channels/qc1': () => ({ body: w.items[0] }),
    'POST /qr-channels/qc1/qr': guard('qr', () => {
      if (w.stateAfterQr) w.items = w.items.map((i) => ({ ...i, state: w.stateAfterQr!, phone: '+593990000001', profile_name: 'Negocio' }));
      return { body: { qr: w.qr, state: w.stateAfterQr ?? 'connecting', expires_in: 30 } };
    }),
    'POST /qr-channels/qc1/disconnect': guard('disconnect', () => {
      w.items = w.items.map((i) => ({ ...i, state: 'logged_out' as const }));
      return { body: w.items[0] };
    }),
    'DELETE /qr-channels/qc1': guard('remove', () => {
      w.items = [];
      return { body: { id: 'qc1', deleted: true } };
    }),
  };
}
const section = async () => within(await screen.findByRole('region', { name: 'WhatsApp por QR' }));

describe('Configuración › Conexiones › WhatsApp por QR', () => {
  it('la sección se anuncia como NO oficial y, sin conexiones, invita a conectar la primera', async () => {
    mockApi(server(world()));
    renderApp('/settings/connections');
    const s = await section();
    expect(s.getByRole('heading', { name: /WhatsApp por QR/ })).toBeInTheDocument();
    expect(s.getAllByText('No oficial').length).toBeGreaterThan(0);
    expect(await s.findByText('Aún no hay conexiones por QR.')).toBeInTheDocument();
    expect(s.getByRole('button', { name: 'Conectar por QR' })).toBeEnabled();
  });

  it('si la plataforma no tiene Evolution configurado lo dice y no deja crear', async () => {
    mockApi(server(world({ available: false })));
    renderApp('/settings/connections');
    const s = await section();
    expect(await s.findByText(/no está disponible: el administrador de la plataforma debe configurar Evolution/)).toBeInTheDocument();
    expect(s.getByRole('button', { name: 'Conectar por QR' })).toBeDisabled();
  });

  it('crear exige aceptar el riesgo, manda el cuerpo esperado y pasa a vincular con el QR y su cuenta regresiva; al conectarse avisa con el teléfono', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/settings/connections');
    await userEvent.click(await (await section()).findByRole('button', { name: 'Conectar por QR' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Conectar WhatsApp por QR' }));
    expect(dlg.getByText(/WhatsApp puede/)).toBeInTheDocument();
    await userEvent.type(dlg.getByLabelText(/^Nombre/), 'Chip de ventas');
    await userEvent.click(dlg.getByRole('button', { name: 'Crear y mostrar el QR' }));
    expect(await dlg.findByText('Confirma que entiendes el riesgo de un canal no oficial.')).toBeInTheDocument();
    expect(w.calls['create']).toBeUndefined();
    await userEvent.click(dlg.getByRole('checkbox'));
    await userEvent.click(dlg.getByRole('button', { name: 'Crear y mostrar el QR' }));
    await waitFor(() => expect(w.calls['create']).toHaveLength(1));
    expect(w.calls['create']![0]!.body).toEqual({ name: 'Chip de ventas', queue_id: null });
    const pair = within(await screen.findByRole('dialog', { name: 'Vincular «Chip de ventas»' }));
    const img = await pair.findByAltText('Código QR para vincular WhatsApp');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QRQR');
    expect(pair.getByRole('timer')).toHaveTextContent('Caduca en');
    // el teléfono se vincula: el siguiente estado que consulta la pantalla es «open»
    w.items = w.items.map((i) => ({ ...i, state: 'open' as const, phone: '+593990000001', profile_name: 'Negocio' }));
    expect(await pair.findByText(/¡Conectado! \+593990000001/, {}, { timeout: 6000 })).toBeInTheDocument();
  }, 15000);

  it('una conexión abierta muestra su estado, teléfono, perfil y calentamiento; una caída lo explica y ofrece volver a vincular', async () => {
    mockApi(server(world({ items: [chan(), chan({ id: 'qc2', name: 'Chip caído', state: 'logged_out', phone: null, profile_name: null, down_since: AT, last_error: 'El teléfono cerró la sesión: escanea un QR nuevo para volver a conectar', warmup: { day: 3, daily_limit: 50 } })] })));
    renderApp('/settings/connections');
    const s = await section();
    const ok = within(await s.findByRole('listitem', { name: 'Chip de ventas' }));
    expect(ok.getByText('Conectado')).toBeInTheDocument();
    expect(ok.getByText(/\+593990000001 · Negocio/)).toBeInTheDocument();
    expect(ok.getByText(/Día 1: hasta 20 mensajes al día/)).toBeInTheDocument();
    expect(ok.getByText('No oficial')).toBeInTheDocument();
    const down = within(s.getByRole('listitem', { name: 'Chip caído' }));
    expect(down.getByText('Desconectado')).toBeInTheDocument();
    expect(down.getByText(/escanea un QR nuevo para volver a conectar/)).toBeInTheDocument();
    expect(down.getByText(/Los mensajes que escribas esperan y salen cuando vuelvas a escanear el QR/)).toBeInTheDocument();
    expect(down.getByText(/Día 3: hasta 50 mensajes al día/)).toBeInTheDocument();
    expect(down.getByRole('button', { name: 'Vincular Chip caído' })).toBeInTheDocument();
  });

  it('cerrar la sesión y borrar piden confirmación y llaman a la API', async () => {
    const w = world({ items: [chan()] });
    mockApi(server(w));
    renderApp('/settings/connections');
    const s = await section();
    await userEvent.click(await s.findByRole('button', { name: 'Cerrar sesión de Chip de ventas' }));
    expect(w.calls['disconnect']).toBeUndefined();
    await userEvent.click(s.getByRole('button', { name: 'Sí' }));
    await waitFor(() => expect(w.calls['disconnect']).toHaveLength(1));
    expect(await s.findByText('Desconectado')).toBeInTheDocument();
    await userEvent.click(s.getByRole('button', { name: 'Borrar Chip de ventas' }));
    expect(w.calls['remove']).toBeUndefined();
    await userEvent.click(s.getByRole('button', { name: 'Sí' }));
    await waitFor(() => expect(w.calls['remove']).toHaveLength(1));
    expect(await s.findByText('Aún no hay conexiones por QR.')).toBeInTheDocument();
  });
});
