import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile } from '../src/features/organization/useCompanyProfile';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const profile = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  name: 'Barbería Norte', country: null, timezone: 'America/Guayaquil', currency: 'USD', currency_locked: false, currency_locked_reason: null,
  legal_name: null, tax_id: null, contact_phone: null, contact_email: null, website: null, address: null, city: 'Guayaquil', description: null, access: { edit: true }, ...over,
});

function server(p: CompanyProfile, o: { fail?: boolean } = {}) {
  let current = p;
  const handlers: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /organization/profile': () => ({ body: current }),
    'PATCH /organization/profile': (c) => {
      if (o.fail) return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Revisa los datos', request_id: 'r', details: [{ path: 'website', code: 'invalid', message: 'debe empezar por https://' }] } } };
      current = { ...current, ...(c.body as Partial<CompanyProfile>) };
      return { body: current };
    },
  };
  return mockApi(handlers);
}
const block = async (name: string) => within(await screen.findByRole('form', { name }));

describe('Configuración › Empresa (V25)', () => {
  it('guarda por bloque solo lo que cambió y avisa «Guardado»; al cambiar el nombre vuelve a preguntar quién soy', async () => {
    const api = server(profile());
    renderApp('/settings/company');
    const identity = await block('Identidad');
    const before = api.count('GET /auth/me');
    await userEvent.clear(identity.getByRole('textbox', { name: 'Nombre comercial' }));
    await userEvent.type(identity.getByRole('textbox', { name: 'Nombre comercial' }), 'Barbería del Sur');
    await userEvent.click(identity.getByRole('button', { name: 'Guardar' }));
    expect(await identity.findByText('Guardado')).toBeInTheDocument();
    expect(api.last('PATCH /organization/profile')?.body).toEqual({ name: 'Barbería del Sur' });
    await waitFor(() => expect(api.count('GET /auth/me')).toBeGreaterThan(before));
    const contact = await block('Datos de contacto');
    await userEvent.type(contact.getByRole('textbox', { name: 'Teléfono de contacto' }), '+593 98 765 4321');
    await userEvent.clear(contact.getByRole('textbox', { name: 'Ciudad' }));
    await userEvent.click(contact.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.last('PATCH /organization/profile')?.body).toEqual({ contact_phone: '+593987654321', city: null }));
  });

  it('la zona horaria pide confirmación con sus efectos; cancelar no guarda; la moneda es de solo lectura con su motivo', async () => {
    const api = server(profile({ currency_locked: true, currency_locked_reason: 'Ya hay ventas registradas: la moneda de la empresa no se puede cambiar' }));
    renderApp('/settings/company');
    const loc = await block('Ubicación y hora');
    expect(loc.getByRole('textbox', { name: 'Moneda' })).toBeDisabled();
    expect(loc.getByText(/Ya hay ventas registradas/)).toBeInTheDocument();
    await userEvent.selectOptions(loc.getByRole('combobox', { name: 'Zona horaria' }), 'America/Bogota');
    await userEvent.click(loc.getByRole('button', { name: 'Guardar' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Cambiar la zona horaria' }));
    expect(dialog.getByText(/No se mueven los recordatorios de citas ya creados/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancelar' }));
    expect(api.count('PATCH /organization/profile')).toBe(0);
    await userEvent.click(loc.getByRole('button', { name: 'Guardar' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Cambiar la zona horaria' })).getByRole('button', { name: 'Cambiar zona horaria' }));
    await waitFor(() => expect(api.last('PATCH /organization/profile')?.body).toEqual({ timezone: 'America/Bogota' }));
  });

  it('muestra el error del servidor en su campo y el teléfono sin código de país no se envía', async () => {
    const api = server(profile(), { fail: true });
    renderApp('/settings/company');
    const contact = await block('Datos de contacto');
    await userEvent.type(contact.getByRole('textbox', { name: 'Teléfono de contacto' }), '0987654321');
    await userEvent.click(contact.getByRole('button', { name: 'Guardar' }));
    expect(await contact.findByText(/empieza por \+/)).toBeInTheDocument();
    expect(api.count('PATCH /organization/profile')).toBe(0);
    await userEvent.clear(contact.getByRole('textbox', { name: 'Teléfono de contacto' }));
    await userEvent.type(contact.getByRole('textbox', { name: 'Sitio web' }), 'http://x.test');
    await userEvent.click(contact.getByRole('button', { name: 'Guardar' }));
    expect(await contact.findByText('debe empezar por https://')).toBeInTheDocument();
  });

  it('en solo lectura no hay botones y los campos están deshabilitados; un fallo al cargar ofrece reintentar', async () => {
    server(profile({ access: { edit: false } }));
    const view = renderApp('/settings/company');
    const identity = await block('Identidad');
    expect(identity.getByRole('textbox', { name: 'Nombre comercial' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Guardar' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Empresa' })).toBeInTheDocument();
    view.unmount();
    resetWorld();
    mockApi({ ...authed(ME_ADVISOR), 'GET /organization/profile': () => err(500, 'INTERNAL_ERROR', 'Error') });
    renderApp('/settings/company');
    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Empresa' })).toBeNull();
  });
});
