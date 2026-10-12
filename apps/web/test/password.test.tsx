import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anon, err, mockApi, renderApp, resetWorld } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

describe('Recuperar contraseña', () => {
  it('muestra «Revisa tu correo» igual exista o no la cuenta (respuesta uniforme) y no repite datos de más', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/forgot': () => ({ status: 202, body: { status: 'reset_requested' } }) });
    renderApp('/forgot');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Correo'), ' Nadie@Empresa.test ');
    await u.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    expect(await screen.findByRole('heading', { name: 'Revisa tu correo' })).toBeInTheDocument();
    expect(api.last('POST /auth/forgot')?.body).toMatchObject({ email: 'nadie@empresa.test' });
    expect(screen.getByRole('link', { name: 'Volver a iniciar sesión' })).toHaveAttribute('href', '/login');
  });

  it('valida el correo antes de llamar y muestra el 503 sin proveedor', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/forgot': () => err(503, 'PASSWORD_RESET_UNAVAILABLE') });
    renderApp('/forgot');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Enviar enlace' }));
    expect(screen.getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(api.count('POST /auth/forgot')).toBe(0);
    await u.type(screen.getByLabelText('Correo'), 'ana@empresa.test');
    await u.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no está disponible por el momento');
  });
});

describe('Crear contraseña nueva (enlace del correo)', () => {
  const TOKEN = '0192f0aa-0000-7000-8000-000000000001.' + 'A'.repeat(43);

  it('lee el token del fragmento, lo BORRA de la barra de direcciones y lo envía al guardar', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    const api = mockApi({ ...anon(), 'POST /auth/reset': () => ({ body: { status: 'password_updated' } }) });
    renderApp('/reset-password');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Contraseña nueva'), 'Nueva-Clave-2026');
    expect(window.location.hash).toBe(''); // el token ya no está en la URL
    await u.type(screen.getByLabelText('Repite la contraseña'), 'Nueva-Clave-2026');
    await u.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(screen.getByText('Contraseña actualizada. Inicia sesión con la nueva.')).toBeInTheDocument();
    expect(api.last('POST /auth/reset')?.body).toEqual({ token: TOKEN, new_password: 'Nueva-Clave-2026' });
  });

  it('exige 8+ caracteres y que coincidan, sin llamar al servidor', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    const api = mockApi(anon());
    renderApp('/reset-password');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Contraseña nueva'), 'corta');
    await u.type(screen.getByLabelText('Repite la contraseña'), 'otra');
    await u.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(screen.getByText('Usa al menos 8 caracteres')).toBeInTheDocument();
    expect(screen.getByText('Las contraseñas no coinciden')).toBeInTheDocument();
    expect(api.count('POST /auth/reset')).toBe(0);
  });

  it('enlace vencido o ya usado (400 INVALID_TOKEN): pantalla clara con salida para pedir otro', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    mockApi({ ...anon(), 'POST /auth/reset': () => err(400, 'INVALID_TOKEN') });
    renderApp('/reset-password');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Contraseña nueva'), 'Nueva-Clave-2026');
    await u.type(screen.getByLabelText('Repite la contraseña'), 'Nueva-Clave-2026');
    await u.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(await screen.findByRole('heading', { name: 'Enlace inválido o vencido' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pedir un enlace nuevo' })).toHaveAttribute('href', '/forgot');
  });

  it('abrir /reset-password sin token muestra directamente «enlace inválido»', async () => {
    mockApi(anon());
    renderApp('/reset-password');
    expect(await screen.findByRole('heading', { name: 'Enlace inválido o vencido' })).toBeInTheDocument();
  });

  it('también funciona en StrictMode (el inicializador corre dos veces y el token no se pierde)', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    mockApi(anon());
    renderApp('/reset-password', { strict: true });
    expect(await screen.findByLabelText('Contraseña nueva')).toBeInTheDocument();
  });
});
