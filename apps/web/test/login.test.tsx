import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anon, err, loginReply, ME_ADMIN, ME_ROOT, mockApi, renderApp, resetWorld, trial } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const fill = async (email: string, password: string) => {
  const u = userEvent.setup();
  await u.type(await screen.findByLabelText('Correo'), email);
  await u.type(screen.getByLabelText('Contraseña'), password);
  return u;
};

describe('Iniciar sesión', () => {
  it('sin sesión, la raíz lleva al login', async () => {
    mockApi(anon());
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('valida en el cliente y NO llama al servidor con datos vacíos o un correo inválido', async () => {
    const api = mockApi(anon());
    renderApp('/login');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Entrar' }));
    expect(screen.getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(screen.getByText('Escribe tu contraseña')).toBeInTheDocument();
    expect(api.count('POST /auth/login')).toBe(0);
  });

  it('entra: envía solo correo normalizado y contraseña, guarda el token SOLO en memoria y muestra la app', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/login': () => loginReply(ME_ADMIN), 'GET /trials/me': () => ({ body: trial() }) });
    renderApp('/login');
    const u = await fill('  ANA@Empresa.test ', 'Clave-Segura-1');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(api.last('POST /auth/login')?.body).toEqual({ email: 'ana@empresa.test', password: 'Clave-Segura-1' });
    // el access token no toca el almacenamiento del navegador
    expect(JSON.stringify({ ...localStorage })).not.toContain('acc-1');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('acc-1');
    // y se usa en las peticiones siguientes
    await waitFor(() => expect(api.last('GET /trials/me')?.headers['authorization']).toBe('Bearer acc-1'));
  });

  it('credenciales incorrectas: mensaje genérico (no distingue correo inexistente de contraseña errónea)', async () => {
    mockApi({ ...anon(), 'POST /auth/login': () => err(401, 'UNAUTHORIZED') });
    renderApp('/login');
    const u = await fill('ana@empresa.test', 'mala');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Correo o contraseña incorrectos.');
    expect(screen.getByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('bloqueo por intentos (429): indica cuánto esperar', async () => {
    mockApi({ ...anon(), 'POST /auth/login': () => err(429, 'TOO_MANY_ATTEMPTS', 'x', { headers: { 'retry-after': '300' } }) });
    renderApp('/login');
    const u = await fill('ana@empresa.test', 'x1234567');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Demasiados intentos. Inténtalo de nuevo en 5 minutos.');
  });

  it('sin conexión: mensaje claro y el formulario sigue usable', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/refresh')) return new Response('{}', { status: 401 });
      throw new TypeError('network');
    });
    renderApp('/login');
    const u = await fill('ana@empresa.test', 'x1234567');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos conectar con el servidor');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('el Súper Admin entra a la consola de plataforma y no consulta /trials/me', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/login': () => loginReply(ME_ROOT) });
    renderApp('/login');
    const u = await fill('root@plataforma.test', 'Clave-Segura-1');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('heading', { name: 'Consola de plataforma' })).toBeInTheDocument();
    expect(api.count('GET /trials/me')).toBe(0);
  });

  it('el botón de mostrar contraseña alterna el tipo del campo y es accesible', async () => {
    mockApi(anon());
    renderApp('/login');
    const u = userEvent.setup();
    const input = await screen.findByLabelText('Contraseña');
    expect(input).toHaveAttribute('type', 'password');
    await u.click(screen.getByRole('button', { name: 'Mostrar contraseña' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Ocultar contraseña' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('con sesión recuperable por la cookie, /login redirige a la app', async () => {
    mockApi({
      'POST /auth/refresh': () => ({ body: { access_token: 'acc-2', token_type: 'Bearer', expires_in: 900 } }),
      'GET /auth/me': () => ({ body: ME_ADMIN }),
      'GET /trials/me': () => ({ body: trial() }),
    });
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
  });

  it('enlaces a recuperar contraseña y a crear cuenta', async () => {
    mockApi(anon());
    renderApp('/login');
    expect(await screen.findByRole('link', { name: '¿Olvidaste tu contraseña?' })).toHaveAttribute('href', '/forgot');
    expect(screen.getByRole('link', { name: 'Crear cuenta gratis' })).toHaveAttribute('href', '/signup');
  });
});
