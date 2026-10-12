import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingSignup } from '../src/lib/pending';
import { anon, err, loginReply, ME_ADMIN, mockApi, renderApp, resetWorld, trial } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

async function fillSignup(over: { name?: string; company?: string; email?: string; phone?: string; password?: string; terms?: boolean } = {}) {
  const u = userEvent.setup();
  await u.type(await screen.findByLabelText('Nombre completo'), over.name ?? 'Ana Pérez');
  await u.type(screen.getByLabelText('Empresa'), over.company ?? 'Mi Empresa SA');
  await u.type(screen.getByLabelText('WhatsApp'), over.phone ?? '098 421 7730');
  await u.type(screen.getByLabelText('Correo de trabajo'), over.email ?? 'Ana@Empresa.test');
  await u.type(screen.getByLabelText('Contraseña'), over.password ?? 'Clave-Segura-1');
  if (over.terms !== false) await u.click(screen.getByRole('checkbox'));
  return u;
}

describe('Crear cuenta', () => {
  it('valida en el cliente (empresa, correo, contraseña de 8+, términos) sin llamar al servidor', async () => {
    const api = mockApi(anon());
    renderApp('/signup');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Contraseña'), '1234567');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(screen.getByText('Escribe tu nombre')).toBeInTheDocument();
    expect(screen.getByText('Escribe el nombre de tu empresa')).toBeInTheDocument();
    expect(screen.getByText('Escribe un número de WhatsApp válido')).toBeInTheDocument();
    expect(screen.getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(screen.getByText('Usa al menos 8 caracteres')).toBeInTheDocument();
    expect(screen.getByText('Debes aceptar los términos para continuar')).toBeInTheDocument();
    expect(api.count('POST /auth/signup')).toBe(0);
  });

  it('envía EXACTAMENTE lo que el backend acepta (sin inventar campos), con zona horaria y token anti-bots', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/signup': () => ({ status: 202, body: { status: 'verification_sent' } }) });
    renderApp('/signup');
    const u = await fillSignup();
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByRole('heading', { name: 'Verifica tu correo' })).toBeInTheDocument();
    const body = api.last('POST /auth/signup')?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['captcha_token', 'email', 'full_name', 'organization_name', 'password', 'phone', 'timezone']);
    expect(body['full_name']).toBe('Ana Pérez');
    expect(body['phone']).toBe('+593984217730'); // prefijo del país + número sin el 0 de marcación nacional
    expect(body['email']).toBe('ana@empresa.test');
    expect(body['organization_name']).toBe('Mi Empresa SA');
    expect(body['timezone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof body['captcha_token']).toBe('string');
  });

  it('el prefijo del país cambia el número enviado (E.164) y un número demasiado corto se rechaza sin llamar al servidor', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/signup': () => ({ status: 202, body: {} }) });
    renderApp('/signup');
    const u = await fillSignup({ phone: '300 123 4567' });
    await u.selectOptions(screen.getByLabelText('País'), '+57');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await screen.findByRole('heading', { name: 'Verifica tu correo' });
    expect((api.last('POST /auth/signup')?.body as Record<string, unknown>)['phone']).toBe('+573001234567');
  });

  it('un WhatsApp demasiado corto muestra el error y no llama al servidor', async () => {
    const api = mockApi(anon());
    renderApp('/signup');
    const u = await fillSignup({ phone: '12345' });
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByText('Escribe un número de WhatsApp válido')).toBeInTheDocument();
    expect(api.count('POST /auth/signup')).toBe(0);
  });

  it('la contraseña del registro NO queda en la URL, el historial ni el almacenamiento (solo en memoria)', async () => {
    mockApi({ ...anon(), 'POST /auth/signup': () => ({ status: 202, body: {} }) });
    renderApp('/signup');
    const u = await fillSignup({ password: 'Clave-Muy-Secreta-9' });
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await screen.findByRole('heading', { name: 'Verifica tu correo' });
    expect(JSON.stringify(window.history.state ?? '')).not.toContain('Muy-Secreta');
    expect(window.location.href).not.toContain('Secreta');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('Secreta');
  });

  it('servicio sin proveedor (503), dominio desechable y bloqueo por límite muestran mensajes claros', async () => {
    let reply = err(503, 'SIGNUP_UNAVAILABLE');
    mockApi({ ...anon(), 'POST /auth/signup': () => reply });
    renderApp('/signup');
    const u = await fillSignup();
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El registro no está disponible por el momento');
    reply = err(400, 'EMAIL_DOMAIN_NOT_ALLOWED');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('correo de trabajo o personal permanente'));
    reply = err(429, 'TOO_MANY_ATTEMPTS', 'x', { headers: { 'retry-after': '60' } });
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Demasiados intentos'));
  });

  it('errores de validación del servidor se asocian al campo', async () => {
    mockApi({ ...anon(), 'POST /auth/signup': () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'email', code: 'invalid_format', message: 'Invalid email' }] } } }) });
    renderApp('/signup');
    const u = await fillSignup();
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByText('Escribe un correo válido')).toBeInTheDocument();
    expect(screen.getByLabelText('Correo de trabajo')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Verificar correo', () => {
  const verifyRoutes = (verify = () => ({ body: { status: 'verified' } as unknown })) => ({
    ...anon(),
    'POST /auth/verify': verify,
    'POST /auth/login': () => loginReply(ME_ADMIN),
    'GET /trials/me': () => ({ body: trial() }),
  });

  it('flujo completo: código correcto → entra solo con la contraseña del registro y la borra de memoria', async () => {
    const api = mockApi(verifyRoutes());
    pendingSignup.set({ email: 'ana@empresa.test', password: 'Clave-Segura-1' });
    renderApp('/verify');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Código'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verificar y entrar' }));
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(api.last('POST /auth/verify')?.body).toEqual({ email: 'ana@empresa.test', code: '123456' });
    expect(api.last('POST /auth/login')?.body).toEqual({ email: 'ana@empresa.test', password: 'Clave-Segura-1' });
    expect(pendingSignup.get()).toBeNull();
  });

  it('solo acepta dígitos y exige 6 antes de llamar al servidor', async () => {
    const api = mockApi(verifyRoutes());
    pendingSignup.set({ email: 'ana@empresa.test', password: 'x' });
    renderApp('/verify');
    const u = userEvent.setup();
    const code = await screen.findByLabelText('Código');
    await u.type(code, '12ab3');
    expect(code).toHaveValue('123');
    await u.click(screen.getByRole('button', { name: 'Verificar y entrar' }));
    expect(screen.getByText('Escribe los 6 dígitos')).toBeInTheDocument();
    expect(api.count('POST /auth/verify')).toBe(0);
  });

  it('código inválido o vencido: mensaje claro, se queda en la pantalla y no intenta entrar', async () => {
    const api = mockApi(verifyRoutes(() => err(400, 'INVALID_CODE') as never));
    pendingSignup.set({ email: 'ana@empresa.test', password: 'Clave-Segura-1' });
    renderApp('/verify');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Código'), '000000');
    await u.click(screen.getByRole('button', { name: 'Verificar y entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Código inválido o vencido');
    expect(api.count('POST /auth/login')).toBe(0);
    expect(pendingSignup.get()?.password).toBe('Clave-Segura-1'); // puede reintentar sin reescribirla
  });

  it('sin contraseña en memoria (p. ej. recargó la página): verifica y manda al login con aviso', async () => {
    mockApi(verifyRoutes());
    renderApp('/verify');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Correo'), 'ana@empresa.test');
    await u.type(screen.getByLabelText('Código'), '123456');
    await u.click(screen.getByRole('button', { name: 'Verificar y entrar' }));
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(screen.getByText(/Correo verificado/)).toBeInTheDocument();
  });

  it('reenviar el código usa el correo del registro y bloquea el botón unos segundos', async () => {
    const api = mockApi({ ...verifyRoutes(), 'POST /auth/resend': () => ({ status: 202, body: { status: 'verification_sent' } }) });
    pendingSignup.set({ email: 'ana@empresa.test', password: 'x' });
    renderApp('/verify');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reenviar código' }));
    expect(await screen.findByText(/te enviamos un código nuevo/)).toBeInTheDocument();
    expect(api.last('POST /auth/resend')?.body).toMatchObject({ email: 'ana@empresa.test' });
    expect(screen.queryByRole('button', { name: 'Reenviar código' })).not.toBeInTheDocument();
    expect(screen.getByText(/Reenviar en \d+ s/)).toBeInTheDocument();
  });
});
