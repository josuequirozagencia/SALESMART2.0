import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, trial } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

describe('Aviso de prueba gratuita', () => {
  it('muestra el tiempo restante y la fecha de vencimiento', async () => {
    mockApi(authed(ME_ADMIN, trial()));
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Prueba gratuita' });
    expect(banner).toHaveTextContent(/te quedan 5 días y \d+ h|te quedan 5 días/);
    expect(within(banner).getByRole('button', { name: 'Pedir una extensión' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Elegir plan' })).toBeDisabled(); // pasarela de pago por decidir
  });

  it('el asesor ve el aviso pero NO puede pedir la extensión (solo el administrador)', async () => {
    mockApi(authed(ME_ADVISOR, trial()));
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Prueba gratuita' });
    expect(within(banner).queryByRole('button', { name: 'Pedir una extensión' })).not.toBeInTheDocument();
  });

  it.each([
    ['pending', 'Tu solicitud de extensión está en revisión'],
    ['approved', 'Extensión aprobada'],
    ['denied', 'La extensión no fue aprobada'],
  ] as const)('con la extensión «%s» lo indica y ya no ofrece pedirla', async (status, text) => {
    mockApi(authed(ME_ADMIN, trial({}, { status, can_request: false, days_granted: status === 'approved' ? 3 : null })));
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Prueba gratuita' });
    expect(banner).toHaveTextContent(text);
    expect(within(banner).queryByRole('button', { name: 'Pedir una extensión' })).not.toBeInTheDocument();
  });

  it('quedan menos de 2 días: el aviso cambia a advertencia', async () => {
    mockApi(authed(ME_ADMIN, trial({ ends_at: new Date(Date.now() + 5 * 3_600_000).toISOString() })));
    renderApp('/');
    const banner = await screen.findByRole('region', { name: 'Prueba gratuita' });
    expect(banner.className).toContain('bg-warn-soft');
    expect(banner).toHaveTextContent(/te quedan \d+ h/);
  });

  it('una organización sin prueba (404) no muestra aviso', async () => {
    mockApi(authed(ME_ADMIN, null));
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ });
    expect(screen.queryByRole('region', { name: 'Prueba gratuita' })).not.toBeInTheDocument();
  });
});

describe('Pedir la extensión', () => {
  const open = async () => {
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Pedir una extensión' }));
    return { u, dlg: await screen.findByRole('dialog', { name: 'Pedir 3 días más' }) };
  };

  it('exige un motivo de 10+ caracteres y no llama al servidor si es corto', async () => {
    const m = mockApi(authed(ME_ADMIN));
    renderApp('/');
    const { u, dlg } = await open();
    await u.type(within(dlg).getByLabelText('¿Para qué necesitas más tiempo?'), 'corto');
    await u.click(within(dlg).getByRole('button', { name: 'Enviar solicitud' }));
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Cuéntanos en una frase');
    expect(m.count('POST /trials/me/extension')).toBe(0);
  });

  it('envía solo el motivo; al aceptarse cierra el diálogo y el aviso pasa a «en revisión»', async () => {
    let state = trial();
    const routes = authed(ME_ADMIN);
    const m = mockApi({
      ...routes,
      'GET /trials/me': () => ({ body: state }),
      'POST /trials/me/extension': () => { state = trial({}, { status: 'pending', can_request: false }); return { status: 202, body: state }; },
    });
    renderApp('/');
    const { u, dlg } = await open();
    await u.type(within(dlg).getByLabelText('¿Para qué necesitas más tiempo?'), 'Estoy conectando mi WhatsApp todavía');
    await u.click(within(dlg).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(m.last('POST /trials/me/extension')?.body).toEqual({ reason: 'Estoy conectando mi WhatsApp todavía' });
    expect(await screen.findByText(/Tu solicitud de extensión está en revisión/)).toBeInTheDocument();
  });

  it('si la cuenta ya usó su extensión (409), lo explica y refresca el estado', async () => {
    const m = mockApi({ ...authed(ME_ADMIN), 'POST /trials/me/extension': () => err(409, 'EXTENSION_ALREADY_USED') });
    renderApp('/');
    const { u, dlg } = await open();
    await u.type(within(dlg).getByLabelText('¿Para qué necesitas más tiempo?'), 'Necesito más tiempo para evaluar');
    await u.click(within(dlg).getByRole('button', { name: 'Enviar solicitud' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Tu cuenta ya usó su extensión.');
    await waitFor(() => expect(m.count('GET /trials/me')).toBeGreaterThan(1));
  });

  it('Escape y «Cancelar» cierran el diálogo sin enviar nada', async () => {
    const m = mockApi(authed(ME_ADMIN));
    renderApp('/');
    const { u } = await open();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Pedir una extensión' }));
    await u.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(m.count('POST /trials/me/extension')).toBe(0);
  });
});

describe('Prueba vencida (cuenta en pausa)', () => {
  const expired = (ext: Parameters<typeof trial>[1] = {}) => trial({ status: 'expired', ends_at: new Date(Date.now() - 86_400_000).toISOString() }, ext);

  it('reemplaza la app por la pantalla de «vencida» con los días de retención del servidor', async () => {
    mockApi(authed(ME_ADMIN, expired()));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeInTheDocument();
    expect(screen.getByText(/los conservamos 30 días/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Hola/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elegir un plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pedir 3 días más' })).toBeInTheDocument();
  });

  it('con solicitud en revisión o denegada: lo explica y no vuelve a ofrecer la extensión', async () => {
    mockApi(authed(ME_ADMIN, expired({ status: 'pending', can_request: false })));
    const first = renderApp('/');
    expect(await screen.findByText(/Tu solicitud de 3 días más está en revisión/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pedir 3 días más/ })).not.toBeInTheDocument();
    first.unmount();
    vi.unstubAllGlobals();
    resetWorld();
    mockApi(authed(ME_ADMIN, expired({ status: 'denied', can_request: false })));
    renderApp('/');
    expect(await screen.findByText('La extensión no fue aprobada. Puedes continuar eligiendo un plan.')).toBeInTheDocument();
  });

  it('el asesor ve la pantalla pero la extensión la pide el administrador', async () => {
    mockApi(authed(ME_ADVISOR, expired()));
    renderApp('/');
    await screen.findByRole('heading', { name: 'Tu prueba gratuita terminó' });
    expect(screen.queryByRole('button', { name: /Pedir 3 días más/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Pide al administrador de tu cuenta/)).toBeInTheDocument();
  });

  it('se puede pedir la extensión desde la pantalla de vencida y cerrar sesión', async () => {
    const m = mockApi({ ...authed(ME_ADMIN, expired()), 'POST /trials/me/extension': () => ({ status: 202, body: expired({ status: 'pending', can_request: false }) }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Pedir 3 días más' }));
    const dlg = await screen.findByRole('dialog');
    await u.type(within(dlg).getByLabelText('¿Para qué necesitas más tiempo?'), 'Necesito terminar la migración de contactos');
    await u.click(within(dlg).getByRole('button', { name: 'Enviar solicitud' }));
    await waitFor(() => expect(m.count('POST /trials/me/extension')).toBe(1));
    await u.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('si la prueba vence con la sesión abierta (403 TRIAL_EXPIRED en una consulta), la app pasa a «vencida» sin recargar', async () => {
    let state = trial();
    mockApi({ ...authed(ME_ADMIN), 'GET /trials/me': () => ({ body: state }), 'GET /contacts': () => err(403, 'TRIAL_EXPIRED') });
    const { qc } = renderApp('/');
    await screen.findByRole('region', { name: 'Prueba gratuita' });
    state = expired();
    // una consulta de negocio recibe 403 TRIAL_EXPIRED del servidor: el cliente de consultas invalida el estado de la prueba
    await qc.fetchQuery({ queryKey: ['contacts'], queryFn: () => api('/contacts') }).catch(() => undefined);
    expect(await screen.findByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeInTheDocument();
  });
});
