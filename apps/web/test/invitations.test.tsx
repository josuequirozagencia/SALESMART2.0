import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTRY_CODES as SHARED_COUNTRIES } from '../../../packages/shared/src/countries';
import { COUNTRY_CODES, countryOptions, suggestedTimezone } from '../src/lib/countries';
import type { Company, CompanyCreated, CompanyList, InvitationIssued, InvitationPreview, Plan, PlanList } from '../src/lib/types';
import { anon, authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });
afterEach(() => { vi.restoreAllMocks(); });

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const PRO: Plan = { id: 'pro', name: 'Pro', description: null, max_users: null, max_connections: null, max_queues: null, features: {}, archived: false, created_at: new Date().toISOString(), companies: 0 } as Plan;
const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'trial', plan: null, users: 1, owner_email: `${over.id}@empresa.test`, timezone: 'UTC', country: 'EC', agency: null, agency_access_level: null, invitation: null, created_at: new Date().toISOString(), trial_ends_at: null, ...over });
const INVITED = company({ id: 'inv', name: 'Café Origen', state: 'invited', users: 0, owner_email: 'dueno@cafe.test', invitation: { email: 'dueno@cafe.test', expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), expired: false } });
const EXPIRED = company({ id: 'exp', name: 'Taller Vega', state: 'invited', users: 0, owner_email: 'vega@taller.test', invitation: { email: 'vega@taller.test', expires_at: new Date(Date.now() - 86_400_000).toISOString(), expired: true } });
const ACTIVE = company({ id: 'act', name: 'Barbería Norte', state: 'active' });
const clist = (items: Company[]): CompanyList => ({ items, next_cursor: null });
const URL_OK = 'https://app.ejemplo.test/accept-invite#token=0192f0aa-0000-7000-8000-000000000001.AbCdEf';
const sent = (email = 'nuevo@empresa.test'): InvitationIssued => ({ email, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), delivery: 'sent' });
const created = (invitation: InvitationIssued, plan: Plan | null = null): CompanyCreated => ({ company: { id: 'new', name: 'Nueva SA', kind: 'client', state: 'invited', plan: plan ? { id: plan.id, name: plan.name } : null, timezone: 'America/Guayaquil', country: 'EC' }, invitation });

const server = (extra: Record<string, Handler> = {}, items: Company[] = [ACTIVE]): Record<string, Handler> => ({
  ...authed(ME_ROOT, null),
  'GET /platform/trials': () => ({ body: NO_TRIALS }),
  'GET /platform/companies': () => ({ body: clist(items) }),
  'GET /platform/plans': () => ({ body: { items: [PRO], feature_catalog: [] } satisfies PlanList }),
  ...extra,
});

async function openNew() {
  const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Nueva empresa' }));
  return { u, dialog: await screen.findByRole('dialog', { name: 'Nueva empresa' }) };
}

describe('Nueva empresa', () => {
  it('propone Ecuador, su zona horaria y «Sin plan»; valida antes de llamar', async () => {
    const api = mockApi(server());
    renderApp('/platform/companies');
    const { u, dialog } = await openNew();
    expect(within(dialog).getByLabelText('País')).toHaveValue('EC');
    expect(within(dialog).getByLabelText('Zona horaria')).toHaveValue('America/Guayaquil');
    expect(within(dialog).getByLabelText('Plan')).toHaveValue('');
    expect(within(dialog).getByText(/Sin plan, la prueba de 7 días empieza cuando el dueño acepte/)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(within(dialog).getByText('Escribe el nombre de la empresa')).toBeInTheDocument();
    expect(within(dialog).getByText('Escribe un correo válido')).toBeInTheDocument();
    await u.type(within(dialog).getByLabelText('Nombre de la empresa'), 'Nueva SA');
    await u.type(within(dialog).getByLabelText('Correo del dueño'), 'no-es-correo');
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(within(dialog).getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(api.count('POST /platform/companies')).toBe(0);
  });

  it('cambiar el país sugiere su zona horaria (editable); elegir plan avisa que no habrá prueba', async () => {
    mockApi(server());
    renderApp('/platform/companies');
    const { u, dialog } = await openNew();
    await u.selectOptions(within(dialog).getByLabelText('País'), 'CO');
    expect(within(dialog).getByLabelText('Zona horaria')).toHaveValue('America/Bogota');
    await u.selectOptions(within(dialog).getByLabelText('Zona horaria'), 'America/Lima');
    expect(within(dialog).getByLabelText('Zona horaria')).toHaveValue('America/Lima');
    await u.selectOptions(within(dialog).getByLabelText('Plan'), 'pro');
    expect(within(dialog).getByText(/Con plan no hay prueba gratuita/)).toBeInTheDocument();
  });

  it('crea la empresa con el cuerpo normalizado, informa que el correo salió SIN mostrar enlace y refresca la lista', async () => {
    const api = mockApi(server({ 'POST /platform/companies': () => ({ status: 201, body: created(sent('dueno@nueva.test'), PRO) }) }));
    renderApp('/platform/companies');
    const { u, dialog } = await openNew();
    await u.type(within(dialog).getByLabelText('Nombre de la empresa'), '  Nueva SA ');
    await u.type(within(dialog).getByLabelText('Correo del dueño'), ' Dueno@Nueva.TEST ');
    await u.selectOptions(within(dialog).getByLabelText('Plan'), 'pro');
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(await screen.findByRole('dialog', { name: 'Empresa creada' })).toBeInTheDocument();
    expect(api.last('POST /platform/companies')?.body).toEqual({ name: 'Nueva SA', owner_email: 'dueno@nueva.test', timezone: 'America/Guayaquil', country: 'EC', plan_id: 'pro' });
    expect(screen.getByText(/Enviamos la invitación a/)).toBeInTheDocument();
    expect(screen.getByText('dueno@nueva.test')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enlace de invitación')).not.toBeInTheDocument();
    await waitFor(() => expect(api.count('GET /platform/companies')).toBeGreaterThanOrEqual(2));
    await u.click(screen.getByRole('button', { name: 'Listo' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('si el correo no pudo salir muestra el enlace para entregarlo por otro medio y permite copiarlo', async () => {
    mockApi(server({ 'POST /platform/companies': () => ({ status: 201, body: created({ ...sent(), delivery: 'unavailable', invite_url: URL_OK }) }) }));
    renderApp('/platform/companies');
    const { u, dialog } = await openNew();
    await u.type(within(dialog).getByLabelText('Nombre de la empresa'), 'Nueva SA');
    await u.type(within(dialog).getByLabelText('Correo del dueño'), 'nuevo@empresa.test');
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(await screen.findByText(/El envío de correos no está configurado todavía/)).toBeInTheDocument();
    expect(screen.getByLabelText('Enlace de invitación')).toHaveValue(URL_OK);
    await u.click(screen.getByRole('button', { name: 'Copiar enlace' }));
    expect(await navigator.clipboard.readText()).toBe(URL_OK); // user-event instala un portapapeles de prueba al crear la sesión
    expect(await screen.findByText('Copiado')).toBeInTheDocument();
  });

  it('muestra el 503 sin URL de la aplicación y los errores de validación del servidor sin cerrar el diálogo', async () => {
    let n = 0;
    mockApi(server({
      'POST /platform/companies': () => (++n === 1
        ? err(503, 'INVITATIONS_UNAVAILABLE')
        : { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'country', code: 'custom', message: 'país no válido' }] } } }),
    }));
    renderApp('/platform/companies');
    const { u, dialog } = await openNew();
    await u.type(within(dialog).getByLabelText('Nombre de la empresa'), 'Nueva SA');
    await u.type(within(dialog).getByLabelText('Correo del dueño'), 'nuevo@empresa.test');
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(await within(dialog).findByText(/falta configurar la URL de la aplicación/)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Crear e invitar' }));
    expect(await within(dialog).findByText('Elige un país válido')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Nueva empresa' })).toBeInTheDocument();
  });
});

describe('Invitaciones pendientes en la lista', () => {
  it('muestra «Invitación pendiente», el correo y la caducidad; solo esas filas llevan «Reenviar invitación»', async () => {
    mockApi(server({}, [INVITED, EXPIRED, ACTIVE]));
    renderApp('/platform/companies');
    const rows = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Invitación pendiente')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/dueno@cafe\.test/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/La invitación vence el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/La invitación venció el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Reenviar la invitación de Café Origen' })).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole('button', { name: /Reenviar/ })).not.toBeInTheDocument();
  });

  it('el filtro de estado ofrece «Invitación pendiente» y lo pide a la API', async () => {
    const api = mockApi(server({}, [INVITED]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText('Estado'), 'invited');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/companies' && c.query.get('state') === 'invited')).toBe(true));
  });

  it('«Reenviar invitación»: llama a la API y confirma el envío; si el correo falla muestra el enlace nuevo', async () => {
    let n = 0;
    const api = mockApi(server({ 'POST /platform/companies/inv/invitation/resend': () => ({ body: ++n === 1 ? sent('dueno@cafe.test') : { ...sent('dueno@cafe.test'), delivery: 'failed', invite_url: URL_OK } }) }, [INVITED]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reenviar la invitación de Café Origen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Invitación de Café Origen' });
    expect(within(dlg).getByText(/Enviamos la invitación a/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText('Enlace de invitación')).not.toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Listo' }));
    await u.click(screen.getByRole('button', { name: 'Reenviar la invitación de Café Origen' }));
    expect(await screen.findByLabelText('Enlace de invitación')).toHaveValue(URL_OK);
    expect(screen.getByText(/No pudimos enviar el correo/)).toBeInTheDocument();
    expect(api.count('POST /platform/companies/inv/invitation/resend')).toBe(2);
  });

  it('el enfriamiento del reenvío (429) se explica sin abrir el diálogo de resultado', async () => {
    mockApi(server({ 'POST /platform/companies/inv/invitation/resend': () => err(429, 'TOO_MANY_ATTEMPTS', 'x', { headers: { 'retry-after': '45' } }) }, [INVITED]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reenviar la invitación de Café Origen' }));
    expect(await screen.findByText(/Demasiados intentos\. Inténtalo de nuevo en 45 segundos/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

const PREVIEW_NEW: InvitationPreview = { organization_name: 'Café Origen', email: 'dueno@cafe.test', role: 'client_admin', expires_at: new Date(Date.now() + 86_400_000).toISOString(), account_exists: false };
const PREVIEW_OLD: InvitationPreview = { ...PREVIEW_NEW, account_exists: true };
const TOKEN = '0192f0aa-0000-7000-8000-000000000001.AbCdEf_-0123456789AbCdEf_-0123456789AbCdEf_';
const goInvite = (strict = false) => { window.history.replaceState(null, '', `/accept-invite#token=${TOKEN}`); return renderApp('/accept-invite', { strict }); };

describe('Aceptar la invitación', () => {
  it('sin token en el enlace: «Invitación no válida» sin llamar a la API', async () => {
    const api = mockApi(anon());
    renderApp('/accept-invite');
    expect(await screen.findByRole('heading', { name: 'Invitación no válida' })).toBeInTheDocument();
    expect(api.count('POST /auth/invitations/preview')).toBe(0);
  });

  it.each([['INVALID_INVITATION', 'Invitación no válida'], ['INVITATION_EXPIRED', 'La invitación venció']])('vista previa con %s → «%s»', async (code, title) => {
    mockApi({ ...anon(), 'POST /auth/invitations/preview': () => err(400, code) });
    goInvite();
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a iniciar sesión' })).toHaveAttribute('href', '/login');
  });

  it('el token viaja en el CUERPO (nunca en la URL), se borra de la barra de direcciones y la vista previa se pide UNA vez (también en StrictMode)', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/invitations/preview': () => ({ body: PREVIEW_NEW }) });
    goInvite(true);
    expect(await screen.findByRole('heading', { name: 'Crea tu cuenta' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(api.count('POST /auth/invitations/preview')).toBe(1);
    expect(api.last('POST /auth/invitations/preview')).toMatchObject({ path: '/auth/invitations/preview', body: { token: TOKEN } });
    expect(JSON.stringify(api.calls.map((c) => c.path))).not.toContain(TOKEN);
    expect(screen.getByText('Café Origen')).toBeInTheDocument();
    expect(screen.getByText('dueno@cafe.test')).toBeInTheDocument();
  });

  it('cuenta nueva: valida nombre, WhatsApp y contraseñas; envía nombre, teléfono E.164 y contraseña; lleva al acceso con un aviso', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/invitations/preview': () => ({ body: PREVIEW_NEW }), 'POST /auth/invitations/accept': () => ({ body: { status: 'accepted', email: 'dueno@cafe.test', account_created: true } }) });
    goInvite();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Crear cuenta y entrar' }));
    expect(screen.getByText('Escribe tu nombre')).toBeInTheDocument();
    expect(screen.getByText('Escribe un número de WhatsApp válido')).toBeInTheDocument();
    expect(screen.getByText('Usa al menos 8 caracteres')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Nombre completo'), 'Dora Quinde');
    await u.type(screen.getByLabelText('WhatsApp'), '098 765 4321');
    await u.type(screen.getByLabelText('Contraseña'), 'Nueva-Clave-2026');
    await u.type(screen.getByLabelText('Repite la contraseña'), 'otra-distinta');
    await u.click(screen.getByRole('button', { name: 'Crear cuenta y entrar' }));
    expect(screen.getByText('Las contraseñas no coinciden')).toBeInTheDocument();
    expect(api.count('POST /auth/invitations/accept')).toBe(0);
    await u.clear(screen.getByLabelText('Repite la contraseña'));
    await u.type(screen.getByLabelText('Repite la contraseña'), 'Nueva-Clave-2026');
    await u.click(screen.getByRole('button', { name: 'Crear cuenta y entrar' }));
    expect(await screen.findByText('Cuenta lista. Inicia sesión con dueno@cafe.test y la contraseña que elegiste.')).toBeInTheDocument();
    expect(api.last('POST /auth/invitations/accept')?.body).toEqual({ token: TOKEN, password: 'Nueva-Clave-2026', full_name: 'Dora Quinde', phone: '+593987654321' });
  });

  it('cuenta existente: pide solo la contraseña actual, no manda nombre ni teléfono, y una contraseña equivocada se marca en el campo', async () => {
    let n = 0;
    const api = mockApi({ ...anon(), 'POST /auth/invitations/preview': () => ({ body: PREVIEW_OLD }), 'POST /auth/invitations/accept': () => (++n === 1 ? err(400, 'INVALID_PASSWORD') : { body: { status: 'accepted', email: 'dueno@cafe.test', account_created: false } }) });
    goInvite();
    const u = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Confirma tu identidad' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Nombre completo')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Añadir esta empresa' }));
    expect(screen.getByText('Escribe tu contraseña actual')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Tu contraseña actual'), 'mala');
    await u.click(screen.getByRole('button', { name: 'Añadir esta empresa' }));
    expect(await screen.findByText('La contraseña no es correcta')).toBeInTheDocument();
    await u.clear(screen.getByLabelText('Tu contraseña actual'));
    await u.type(screen.getByLabelText('Tu contraseña actual'), 'la-buena-2026');
    await u.click(screen.getByRole('button', { name: 'Añadir esta empresa' }));
    expect(await screen.findByText(/ya tienes acceso a Café Origen/)).toBeInTheDocument();
    expect(api.last('POST /auth/invitations/accept')?.body).toEqual({ token: TOKEN, password: 'la-buena-2026' });
  });

  it('si al aceptar el enlace ya venció o se usó, pasa a la pantalla correspondiente', async () => {
    mockApi({ ...anon(), 'POST /auth/invitations/preview': () => ({ body: PREVIEW_NEW }), 'POST /auth/invitations/accept': () => err(400, 'INVITATION_EXPIRED') });
    goInvite();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Nombre completo'), 'Dora Quinde');
    await u.type(screen.getByLabelText('WhatsApp'), '098 765 4321');
    await u.type(screen.getByLabelText('Contraseña'), 'Nueva-Clave-2026');
    await u.type(screen.getByLabelText('Repite la contraseña'), 'Nueva-Clave-2026');
    await u.click(screen.getByRole('button', { name: 'Crear cuenta y entrar' }));
    expect(await screen.findByRole('heading', { name: 'La invitación venció' })).toBeInTheDocument();
  });
});

describe('Países', () => {
  it('la lista de la web coincide EXACTAMENTE con la que valida la API (packages/shared)', () => {
    expect([...COUNTRY_CODES].sort()).toEqual([...SHARED_COUNTRIES].sort());
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
  });
  it('Ecuador y los mercados iniciales van primero y el resto por orden alfabético; sugiere zona horaria solo donde hay una dominante', () => {
    const o = countryOptions();
    expect(o.slice(0, 3).map((c) => c.code)).toEqual(['EC', 'CO', 'PE']);
    expect(o[0]!.name).toBe('Ecuador');
    const rest = o.slice(8).map((c) => c.name);
    expect([...rest].sort((a, b) => a.localeCompare(b, 'es'))).toEqual(rest);
    expect(suggestedTimezone('EC')).toBe('America/Guayaquil');
    expect(suggestedTimezone('BR')).toBeUndefined();
  });
});
