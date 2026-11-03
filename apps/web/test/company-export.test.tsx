// F3b (ADR-59 #8/#9): «Descargar todo» de una empresa eliminada — la Consola del Súper Admin y la página pública del dueño.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company, CompanyExport, CompanyExportStatus, CompanyList, OwnerExportStatus } from '../src/lib/types';
import { anon, authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });
afterEach(() => { vi.restoreAllMocks(); });

const DAY = 86_400_000;
const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'active', plan: null, users: 2, owner_email: `${over.id}@empresa.test`, timezone: 'UTC', country: 'EC', agency: null, agency_access_level: null, invitation: null, deletion: null, created_at: new Date().toISOString(), trial_ends_at: null, ...over });
const clist = (items: Company[]): CompanyList => ({ items, next_cursor: null });
const ACTIVA = company({ id: 'act', name: 'Café Origen' });
const ELIMINADA = company({ id: 'elim', name: 'Taller Pérez', state: 'deleted', deletion: { requested_at: new Date().toISOString(), purge_after: new Date(Date.now() + 5 * DAY).toISOString(), reason: 'La empresa pidió cerrar su cuenta', state: 'scheduled', purge_error: null, purged_at: null } });

const exportOf = (over: Partial<CompanyExport> = {}): CompanyExport => ({ id: 'e1', state: 'queued', requested_via: 'platform', requested_at: new Date().toISOString(), finished_at: null, expires_at: null, parts: [], total_bytes: 0, error: null, ...over });
const READY = exportOf({ state: 'ready', finished_at: new Date().toISOString(), expires_at: new Date(Date.now() + 47 * 3_600_000).toISOString(), parts: [{ n: 1, filename: 'salesmart-taller-perez-parte-1.zip', bytes: 5_242_880 }, { n: 2, filename: 'salesmart-taller-perez-parte-2.zip', bytes: 1_048_576 }], total_bytes: 6_291_456 });
const status = (over: Partial<CompanyExportStatus> = {}): CompanyExportStatus => ({ available: true, purge_after: new Date(Date.now() + 5 * DAY).toISOString(), export: null, ...over });

const server = (extra: Record<string, Handler> = {}, list: Company[] = [ACTIVA, ELIMINADA]): Record<string, Handler> => ({
  ...authed(ME_ROOT, null),
  'GET /platform/trials': () => ({ body: { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } } }),
  'GET /platform/companies': () => ({ body: clist(list) }),
  'GET /platform/plans': () => ({ body: { items: [], feature_catalog: [] } }),
  ...extra,
});

/** Intercepta el enlace temporal con el que se inicia la descarga (jsdom no navega). */
function spyDownloads(): Array<{ href: string; download: string }> {
  const out: Array<{ href: string; download: string }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { out.push({ href: this.href, download: this.download }); });
  return out;
}

describe('Consola › Empresas: «Descargar todo»', () => {
  it('solo una empresa eliminada ofrece «Descargar todo»', async () => {
    mockApi(server());
    renderApp('/platform/companies');
    const list = await screen.findByRole('list', { name: 'Empresas' });
    expect(within(list).getByRole('button', { name: 'Descargar todo de Taller Pérez' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Descargar todo de Café Origen' })).not.toBeInTheDocument();
  });

  it('sin copia pedida: explica qué incluye (y que NO lleva credenciales), pide la contraseña y la envía', async () => {
    const api = mockApi(server({ 'GET /platform/companies/elim/export': () => ({ body: status() }), 'POST /platform/companies/elim/export': () => ({ body: exportOf() }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    expect(await within(dlg).findByText(/No incluye credenciales ni secretos/)).toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Preparar la copia' });
    expect(go).toBeDisabled();
    await u.type(within(dlg).getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    await u.click(go);
    await waitFor(() => expect(api.last('POST /platform/companies/elim/export')?.body).toEqual({ password: 'Correct-Horse-9!' }));
  });

  it('una contraseña incorrecta se explica y vacía el campo', async () => {
    mockApi(server({ 'GET /platform/companies/elim/export': () => ({ body: status() }), 'POST /platform/companies/elim/export': () => err(403, 'PASSWORD_INVALID', 'La contraseña no es correcta') }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    await u.type(await within(dlg).findByLabelText(/Tu contraseña/), 'mala');
    await u.click(within(dlg).getByRole('button', { name: 'Preparar la copia' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('La contraseña no es correcta.');
    expect(within(dlg).getByLabelText(/Tu contraseña/)).toHaveValue('');
  });

  it('mientras se arma muestra el avance y no vuelve a pedir la contraseña; se actualiza sola', async () => {
    mockApi(server({ 'GET /platform/companies/elim/export': () => ({ body: status({ export: exportOf({ state: 'running' }) }) }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    expect(await within(dlg).findByText(/Armando la copia/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/Tu contraseña/)).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Preparar la copia' })).not.toBeInTheDocument();
  });

  it('lista: muestra las partes con su tamaño y hasta cuándo se puede bajar; «Bajar» pide la URL de ESA parte e inicia la descarga', async () => {
    const downloads = spyDownloads();
    const api = mockApi(server({
      'GET /platform/companies/elim/export': () => ({ body: status({ export: READY }) }),
      'POST /platform/companies/elim/export/download': () => ({ body: { url: 'https://almacen.test/org/x/parte-002.zip?firma=1', filename: 'salesmart-taller-perez-parte-2.zip', expires_in_seconds: 900 } }),
    }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    const parts = await within(dlg).findByRole('list', { name: 'Partes de la copia' });
    expect(within(parts).getByText('salesmart-taller-perez-parte-1.zip')).toBeInTheDocument();
    expect(within(parts).getByText(/Parte 1 · 5\.0 MB/)).toBeInTheDocument();
    expect(within(parts).getByText(/Parte 2 · 1\.0 MB/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Total: 6\.0 MB/)).toBeInTheDocument();
    expect(within(dlg).getByText(/ZIP independiente/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Bajar la parte 2' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(api.last('POST /platform/companies/elim/export/download')?.body).toEqual({ part: 2 });
    expect(downloads[0]).toEqual({ href: 'https://almacen.test/org/x/parte-002.zip?firma=1', download: 'salesmart-taller-perez-parte-2.zip' });
    // la clave del almacenamiento nunca aparece en pantalla
    expect(dlg.textContent).not.toContain('org/');
  });

  it('empresa fuera de plazo: no se puede pedir', async () => {
    mockApi(server({ 'GET /platform/companies/elim/export': () => ({ body: status({ available: false, purge_after: null }) }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    expect(await within(dlg).findByText(/Solo se puede pedir la copia de una empresa eliminada/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/Tu contraseña/)).not.toBeInTheDocument();
  });

  it('una copia fallida o vencida se explica y deja pedir otra', async () => {
    mockApi(server({ 'GET /platform/companies/elim/export': () => ({ body: status({ export: exportOf({ state: 'failed', error: 'EXPORT_FAILED' }) }) }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Descargar todo de Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Descargar todo de Taller Pérez' });
    expect(await within(dlg).findByText(/No se pudo armar la copia/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Preparar la copia' })).toBeInTheDocument();
  });
});

// ── Página pública del dueño ────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo';
const goOwner = (strict = false) => { window.history.replaceState(null, '', `/company-export#token=${TOKEN}`); return renderApp('/company-export', { strict }); };
const owner = (over: Partial<OwnerExportStatus> = {}): OwnerExportStatus => ({ organization_name: 'Taller Pérez', purge_after: new Date(Date.now() + 5 * DAY).toISOString(), export: null, ...over });

describe('Página pública del dueño: /company-export', () => {
  it('sin token en el enlace: «Enlace no válido» sin llamar a la API', async () => {
    window.history.replaceState(null, '', '/company-export');
    const api = mockApi(anon());
    renderApp('/company-export');
    expect(await screen.findByRole('heading', { name: 'Enlace no válido' })).toBeInTheDocument();
    expect(api.count('POST /public/company-export/status')).toBe(0);
  });

  it('un enlace que ya no vale (404) muestra «Enlace no válido»', async () => {
    mockApi({ ...anon(), 'POST /public/company-export/status': () => err(404, 'NOT_FOUND') });
    goOwner();
    expect(await screen.findByRole('heading', { name: 'Enlace no válido' })).toBeInTheDocument();
  });

  it('el token viaja en el CUERPO (nunca en la URL), se borra de la barra de direcciones y el estado se pide UNA vez (también en StrictMode)', async () => {
    const api = mockApi({ ...anon(), 'POST /public/company-export/status': () => ({ body: owner() }) });
    goOwner(true);
    expect(await screen.findByRole('heading', { name: 'Copia de tus datos' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(api.count('POST /public/company-export/status')).toBe(1);
    expect(api.last('POST /public/company-export/status')).toMatchObject({ body: { token: TOKEN } });
    expect(JSON.stringify(api.calls.map((c) => c.path))).not.toContain(TOKEN);
    expect(screen.getByText('Taller Pérez')).toBeInTheDocument();
  });

  it('pedir la copia envía token y contraseña; la contraseña incorrecta se explica y se vacía', async () => {
    let attempt = 0;
    const api = mockApi({ ...anon(), 'POST /public/company-export/status': () => ({ body: owner() }), 'POST /public/company-export/request': () => (++attempt === 1 ? err(403, 'PASSWORD_INVALID', 'La contraseña no es correcta') : { status: 202, body: exportOf({ requested_via: 'owner' }) }) });
    goOwner();
    const u = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Pedir la copia de mis datos' });
    const send = within(form).getByRole('button', { name: 'Pedir la copia de mis datos' });
    expect(send).toBeDisabled();
    await u.type(within(form).getByLabelText(/Tu contraseña/), 'mala');
    await u.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña no es correcta.');
    expect(within(form).getByLabelText(/Tu contraseña/)).toHaveValue('');
    await u.type(within(form).getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    await u.click(send);
    await waitFor(() => expect(api.count('POST /public/company-export/request')).toBe(2));
    expect(api.last('POST /public/company-export/request')?.body).toEqual({ token: TOKEN, password: 'Correct-Horse-9!' });
  });

  it('mientras se arma avisa que llegará un correo y no vuelve a pedir la contraseña', async () => {
    mockApi({ ...anon(), 'POST /public/company-export/status': () => ({ body: owner({ export: exportOf({ state: 'running', requested_via: 'owner' }) }) }) });
    goOwner();
    expect(await screen.findByText(/te avisaremos por correo cuando esté lista/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Pedir la copia de mis datos' })).not.toBeInTheDocument();
  });

  it('lista: pide la contraseña y baja cada parte con token, contraseña y número de parte; inicia la descarga', async () => {
    const downloads = spyDownloads();
    const api = mockApi({
      ...anon(),
      'POST /public/company-export/status': () => ({ body: owner({ export: { ...READY, requested_via: 'owner' } }) }),
      'POST /public/company-export/download': () => ({ body: { url: 'https://almacen.test/org/x/parte-001.zip?firma=1', filename: 'salesmart-taller-perez-parte-1.zip', expires_in_seconds: 900 } }),
    });
    goOwner();
    const u = userEvent.setup();
    const parts = await screen.findByRole('list', { name: 'Partes de la copia' });
    expect(screen.getByText(/Total: 6\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/No incluye contraseñas ni claves/)).toBeInTheDocument();
    const bajar = within(parts).getByRole('button', { name: 'Bajar la parte 1' });
    expect(bajar).toBeDisabled(); // sin contraseña no se puede
    await u.type(screen.getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    await u.click(bajar);
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(api.last('POST /public/company-export/download')?.body).toEqual({ token: TOKEN, password: 'Correct-Horse-9!', part: 1 });
    expect(downloads[0]!.download).toBe('salesmart-taller-perez-parte-1.zip');
  });

  it('una contraseña incorrecta al bajar se explica y no inicia ninguna descarga', async () => {
    const downloads = spyDownloads();
    mockApi({ ...anon(), 'POST /public/company-export/status': () => ({ body: owner({ export: { ...READY, requested_via: 'owner' } }) }), 'POST /public/company-export/download': () => err(403, 'PASSWORD_INVALID', 'La contraseña no es correcta') });
    goOwner();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Tu contraseña/), 'mala');
    await u.click(screen.getByRole('button', { name: 'Bajar la parte 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña no es correcta.');
    expect(downloads).toHaveLength(0);
  });
});
