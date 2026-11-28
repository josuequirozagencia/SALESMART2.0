import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NAME_NOTICE } from '../src/features/profile/NameNotice';
import type { MyProfile } from '../src/features/profile/useMyProfile';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const profile = (over: Partial<MyProfile> = {}): MyProfile => ({ email: 'ana@empresa.test', full_name: 'Ana Pérez', phone: '+593984217730', hours: null, time_zone: 'America/Guayaquil', photo: false, ...over });

function server(p: MyProfile, me = ME_ADMIN, extra: Record<string, Handler> = {}) {
  let current = p;
  return mockApi({
    ...authed(me),
    'GET /me/profile': () => ({ body: current }),
    'PATCH /me/profile': (c) => { current = { ...current, ...(c.body as Partial<MyProfile>) }; return { body: current }; },
    'POST /auth/password': (c) => ((c.body as { current_password: string }).current_password === 'mal' ? err(400, 'INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta') : { status: 204 }),
    ...extra,
  });
}
const form = async (name: string) => within(await screen.findByRole('form', { name }));

describe('Mi perfil (V25)', () => {
  it('guarda solo lo que cambió, el correo es de solo lectura y al cambiar el nombre vuelve a preguntar quién soy', async () => {
    const api = server(profile());
    renderApp('/profile');
    const f = await form('Mis datos');
    expect(f.getByRole('textbox', { name: 'Correo' })).toBeDisabled();
    expect(f.getByText('Para cambiar tu correo, contacta con tu administrador.')).toBeInTheDocument();
    expect(f.getByText('Este nombre lo verán todas tus empresas.')).toBeInTheDocument();
    const before = api.count('GET /auth/me');
    await userEvent.clear(f.getByRole('textbox', { name: 'Nombre completo' }));
    await userEvent.type(f.getByRole('textbox', { name: 'Nombre completo' }), 'Ana María Pérez');
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText('Guardado')).toBeInTheDocument();
    expect(api.last('PATCH /me/profile')?.body).toEqual({ full_name: 'Ana María Pérez' });
    await waitFor(() => expect(api.count('GET /auth/me')).toBeGreaterThan(before));
  });

  it('el teléfono no se puede dejar vacío ni sin código de país; el horario propio se ve en solo lectura', async () => {
    const week = { mon: [['09:00', '13:00'], ['15:00', '18:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } as unknown as NonNullable<MyProfile['hours']>;
    const api = server(profile({ hours: week }), ME_ADVISOR);
    renderApp('/profile');
    const f = await form('Mis datos');
    await userEvent.clear(f.getByRole('textbox', { name: 'Teléfono' }));
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText(/no dejar vacío/)).toBeInTheDocument();
    await userEvent.type(f.getByRole('textbox', { name: 'Teléfono' }), '0987654321');
    await userEvent.click(f.getByRole('button', { name: 'Guardar' }));
    expect(await f.findByText(/empieza por \+/)).toBeInTheDocument();
    expect(api.count('PATCH /me/profile')).toBe(0);
    const hours = within(screen.getByRole('region', { name: 'Mi horario' }));
    expect(hours.getByText('09:00–13:00, 15:00–18:00')).toBeInTheDocument();
    expect(hours.queryByRole('button')).toBeNull();
  });

  it('cambiar la contraseña: avisa de la actual incorrecta y de la repetición; si sale bien lo dice', async () => {
    const api = server(profile());
    renderApp('/profile');
    const f = await form('Cambiar contraseña');
    await userEvent.type(f.getByLabelText('Contraseña actual'), 'mal');
    await userEvent.type(f.getByLabelText('Contraseña nueva'), 'clave-nueva-1');
    await userEvent.type(f.getByLabelText('Repite la contraseña nueva'), 'otra');
    await userEvent.click(f.getByRole('button', { name: 'Cambiar contraseña' }));
    expect(await f.findByText('Las contraseñas no coinciden')).toBeInTheDocument();
    await userEvent.clear(f.getByLabelText('Repite la contraseña nueva'));
    await userEvent.type(f.getByLabelText('Repite la contraseña nueva'), 'clave-nueva-1');
    await userEvent.click(f.getByRole('button', { name: 'Cambiar contraseña' }));
    expect(await f.findByText('La contraseña actual no es correcta')).toBeInTheDocument();
    await userEvent.clear(f.getByLabelText('Contraseña actual'));
    await userEvent.type(f.getByLabelText('Contraseña actual'), 'buena');
    await userEvent.click(f.getByRole('button', { name: 'Cambiar contraseña' }));
    expect(await f.findByText('Contraseña cambiada')).toBeInTheDocument();
    expect(api.last('POST /auth/password')?.body).toEqual({ current_password: 'buena', new_password: 'clave-nueva-1' });
  });

  it('el aviso de nombre aparece solo mientras falte, con enlace a «Mi perfil»', async () => {
    server(profile({ full_name: null }), { ...ME_ADMIN, user: { ...ME_ADMIN.user, full_name: null } });
    const view = renderApp('/');
    const links = await screen.findAllByRole('link', { name: NAME_NOTICE });
    expect(links.every((l) => l.getAttribute('href') === '/profile')).toBe(true);
    await userEvent.click(links[0]!);
    expect(await screen.findByRole('heading', { name: 'Mi perfil' })).toBeInTheDocument();
    view.unmount();
    resetWorld();
    server(profile());
    renderApp('/');
    expect((await screen.findAllByRole('link', { name: 'Mi perfil' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: NAME_NOTICE })).toBeNull();
  });
});
