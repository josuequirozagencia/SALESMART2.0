import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captchaMode, staticCaptchaToken } from '../src/lib/captcha';
import { pendingSignup } from '../src/lib/pending';
import { anon, mockApi, renderApp, resetWorld } from './helpers';

interface Rendered { id: string; opts: Record<string, unknown> }
let rendered: Rendered[] = [];
let removed: string[] = [];

/** Turnstile simulado: guarda cada render para que la prueba «resuelva» o «caduque» la verificación. */
function installTurnstile(): void {
  rendered = [];
  removed = [];
  window.turnstile = {
    render: (_el: HTMLElement, opts: Record<string, unknown>) => {
      const id = `w${rendered.length + 1}`;
      rendered.push({ id, opts });
      return id;
    },
    remove: (id: string) => { removed.push(id); },
  };
}
const solve = (token: string, which = rendered.length - 1) => act(() => { (rendered[which]!.opts['callback'] as (t: string) => void)(token); });
const expire = (which = rendered.length - 1) => act(() => { (rendered[which]!.opts['expired-callback'] as () => void)(); });

beforeEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetWorld(); });
afterEach(() => { delete window.turnstile; vi.unstubAllEnvs(); });

const fillSignup = async () => {
  const u = userEvent.setup();
  await u.type(await screen.findByLabelText('Nombre completo'), 'Ana Pérez');
  await u.type(screen.getByLabelText('Empresa'), 'Mi Empresa SA');
  await u.type(screen.getByLabelText('Correo de trabajo'), 'ana@empresa.test');
  await u.type(screen.getByLabelText('WhatsApp'), '098 421 7730');
  await u.type(screen.getByLabelText('Contraseña'), 'Clave-Segura-1');
  await u.click(screen.getByRole('checkbox'));
  return u;
};

describe('modos del anti-bots', () => {
  it('sin configurar es «none»; «fake» y «turnstile» solo con su valor exacto; los modos sin widget usan un token fijo', () => {
    expect(captchaMode()).toBe('none');
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'turnstile');
    expect(captchaMode()).toBe('turnstile');
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'fake');
    expect(captchaMode()).toBe('fake');
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'otra-cosa');
    expect(captchaMode()).toBe('none');
    expect(staticCaptchaToken('fake')).toBe('fake-pass');
    expect(staticCaptchaToken('none')).toBe('none');
  });

  it('en modo «fake» no se carga ningún script externo ni se muestra widget', async () => {
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'fake');
    mockApi(anon());
    renderApp('/signup');
    await screen.findByRole('heading', { name: 'Crea tu cuenta' });
    expect(screen.queryByTestId('turnstile')).not.toBeInTheDocument();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });
});

describe('Cloudflare Turnstile en el registro', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'turnstile');
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '0x4AAAAAAAsitekey');
    installTurnstile();
  });

  it('dibuja el widget con la clave de sitio, en español y sin exponer ninguna clave secreta', async () => {
    mockApi(anon());
    renderApp('/signup');
    expect(await screen.findByTestId('turnstile')).toBeInTheDocument();
    await waitFor(() => expect(rendered).toHaveLength(1));
    expect(rendered[0]!.opts).toMatchObject({ sitekey: '0x4AAAAAAAsitekey', language: 'es' });
    expect(JSON.stringify(Object.keys(import.meta.env))).not.toMatch(/SECRET/i);
  });

  it('sin resolver la verificación NO se envía el registro y se explica por qué', async () => {
    const api = mockApi(anon());
    renderApp('/signup');
    const u = await fillSignup();
    await waitFor(() => expect(rendered).toHaveLength(1));
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Completa la verificación anti-bots');
    expect(api.count('POST /auth/signup')).toBe(0);
  });

  it('al resolverla, el registro lleva EXACTAMENTE ese token y el widget se renueva (los tokens son de un solo uso)', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/signup': () => ({ status: 202, body: {} }) });
    renderApp('/signup');
    const u = await fillSignup();
    await waitFor(() => expect(rendered).toHaveLength(1));
    await solve('token-de-cloudflare');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await screen.findByRole('heading', { name: 'Verifica tu correo' });
    expect((api.last('POST /auth/signup')?.body as Record<string, unknown>)['captcha_token']).toBe('token-de-cloudflare');
    expect(removed).toContain('w1');
  });

  it('si el envío falla, el token ya se gastó: el widget se vuelve a generar y hay que resolverlo de nuevo', async () => {
    let status = 503;
    const api = mockApi({ ...anon(), 'POST /auth/signup': () => ({ status, body: { error: { code: 'SIGNUP_UNAVAILABLE', message: 'x', request_id: 'r', details: [] } } }) });
    renderApp('/signup');
    const u = await fillSignup();
    await waitFor(() => expect(rendered).toHaveLength(1));
    await solve('token-1');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible');
    await waitFor(() => expect(rendered).toHaveLength(2)); // widget nuevo
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ })); // sin resolver el nuevo
    expect(await screen.findByText(/Completa la verificación anti-bots/)).toBeInTheDocument();
    expect(api.count('POST /auth/signup')).toBe(1);
    status = 202;
    await solve('token-2');
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    await screen.findByRole('heading', { name: 'Verifica tu correo' });
    expect((api.last('POST /auth/signup')?.body as Record<string, unknown>)['captcha_token']).toBe('token-2');
  });

  it('un token que caduca (5 min) deja de valer: hay que resolver otra vez', async () => {
    const api = mockApi(anon());
    renderApp('/signup');
    const u = await fillSignup();
    await waitFor(() => expect(rendered).toHaveLength(1));
    await solve('token-viejo');
    await expire();
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Completa la verificación anti-bots');
    expect(api.count('POST /auth/signup')).toBe(0);
  });
});

describe('Turnstile en recuperar contraseña y reenvío de código', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'turnstile');
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '0x4AAAAAAAsitekey');
    installTurnstile();
  });

  it('recuperar contraseña envía el token resuelto', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/forgot': () => ({ status: 202, body: {} }) });
    renderApp('/forgot');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Correo'), 'ana@empresa.test');
    await waitFor(() => expect(rendered).toHaveLength(1));
    await u.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Completa la verificación anti-bots');
    expect(api.count('POST /auth/forgot')).toBe(0);
    await solve('token-forgot');
    await u.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    await screen.findByRole('heading', { name: 'Revisa tu correo' });
    expect((api.last('POST /auth/forgot')?.body as Record<string, unknown>)['captcha_token']).toBe('token-forgot');
  });

  it('reenviar el código envía el token resuelto', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/resend': () => ({ status: 202, body: {} }) });
    pendingSignup.set({ email: 'ana@empresa.test', password: 'x' });
    renderApp('/verify');
    const u = userEvent.setup();
    await waitFor(() => expect(rendered).toHaveLength(1));
    await solve('token-resend');
    await u.click(await screen.findByRole('button', { name: 'Reenviar código' }));
    await screen.findByText(/te enviamos un código nuevo/);
    expect((api.last('POST /auth/resend')?.body as Record<string, unknown>)['captcha_token']).toBe('token-resend');
  });
});

describe('Turnstile mal configurado o inaccesible', () => {
  it('sin clave de sitio no hay forma de resolver la verificación: lo dice con claridad y no envía nada', async () => {
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'turnstile');
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    installTurnstile();
    const api = mockApi(anon());
    renderApp('/signup');
    const u = await fillSignup();
    expect(await screen.findByText(/No pudimos cargar la verificación anti-bots/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Crear cuenta y empezar/ }));
    expect(api.count('POST /auth/signup')).toBe(0);
  });

  it('si el script de Cloudflare no carga, lo dice y no deja enviar', async () => {
    vi.stubEnv('VITE_CAPTCHA_PROVIDER', 'turnstile');
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '0x4AAAAAAAsitekey');
    delete window.turnstile; // sin Turnstile: el cargador añade el <script> y lo hacemos fallar
    mockApi(anon());
    renderApp('/signup');
    // El widget ya está montado y su efecto vació: el cargador enganchó sus manejadores a la promesa compartida. Sin esta espera,
    // un <script> que dejó una prueba anterior (el cargador comparte la promesa entre pruebas) hacía fallar la prueba al azar:
    // su `onerror` se disparaba ANTES de que el widget pidiera el script, reiniciaba la carga y el widget quedaba cargando para siempre.
    await screen.findByTestId('turnstile');
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).not.toBeNull());
    const script = document.querySelector('script[src*="challenges.cloudflare.com"]') as HTMLScriptElement;
    expect(script.src).toContain('render=explicit');
    act(() => { script.onerror?.(new Event('error')); });
    expect(await screen.findByText(/No pudimos cargar la verificación anti-bots/)).toBeInTheDocument();
  });
});
