import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttributionEndpoint, AttributionEndpointIssued, Contact, ContactAttribution } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const none: AttributionEndpoint = { configured: false, id: null, path: null, created_at: null, rotated_at: null, last_used_at: null };
const ID = '5f1d7c0e-1111-4222-8333-444455556666';
const live: AttributionEndpoint = { configured: true, id: ID, path: `/v1/attribution/ctwa/${ID}`, created_at: '2026-10-10T15:00:00.000Z', rotated_at: null, last_used_at: null };
const issued = (rotated: boolean, secret = 'ssw_secreto-de-prueba-1234567890'): AttributionEndpointIssued => ({ id: ID, secret, rotated, path: `/v1/attribution/ctwa/${ID}` });

function server(initial: AttributionEndpoint, over: { post?: Handler } = {}) {
  const s = { state: initial, posts: 0, routes: {} as Record<string, Handler> };
  s.routes = {
    ...authed(ME_ADMIN),
    'GET /attribution/endpoint': () => ({ body: s.state }),
    'POST /attribution/endpoint': over.post ?? (() => {
      s.posts += 1;
      const r = issued(s.state.configured, `ssw_secreto-${s.posts}-de-prueba-1234567890`);
      s.state = { ...live, rotated_at: s.state.configured ? '2026-10-16T12:00:00.000Z' : null };
      return { status: 201, body: r };
    }),
  };
  return s;
}

describe('Configuración › Atribución de Meta', () => {
  it('sin punto de entrada: lo genera y muestra la URL y el secreto UNA sola vez; al cerrarlo el secreto desaparece', async () => {
    const s = server(none);
    mockApi(s.routes);
    renderApp('/settings/attribution');
    expect(await screen.findByText(/Aún no hay un punto de entrada/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Atribución de Meta' })).toHaveAttribute('href', '/settings/attribution');
    expect(screen.getByRole('link', { name: 'Campos personalizados' })).toHaveAttribute('href', '/settings/fields');
    await userEvent.click(screen.getByRole('button', { name: 'Generar punto de entrada' }));
    const card = within(await screen.findByRole('region', { name: 'Datos del punto de entrada' }));
    expect(card.getByLabelText('URL del punto de entrada')).toHaveValue(`${window.location.origin}/v1/attribution/ctwa/${ID}`);
    expect(card.getByLabelText('Secreto')).toHaveValue('ssw_secreto-1-de-prueba-1234567890');
    expect(card.getByText(/no se volverá a mostrar/)).toBeInTheDocument();
    await userEvent.click(card.getByRole('button', { name: 'Ya lo guardé' }));
    expect(screen.queryByRole('region', { name: 'Datos del punto de entrada' })).not.toBeInTheDocument();
    const status = within(await screen.findByRole('region', { name: 'Punto de entrada' }));
    expect(status.getByText('Punto de entrada activo.')).toBeInTheDocument();
    expect(status.getByText(/Aún no ha recibido ningún aviso/)).toBeInTheDocument();
    expect(status.getByLabelText('URL del punto de entrada')).toHaveValue(`${window.location.origin}/v1/attribution/ctwa/${ID}`);
    expect(screen.queryByLabelText('Secreto')).not.toBeInTheDocument(); // el secreto no vuelve
    expect(document.body.textContent).not.toContain('ssw_secreto');
  });

  it('regenerar pide confirmación; «No» la cancela; al confirmar entrega un secreto nuevo', async () => {
    const s = server({ ...live, last_used_at: '2026-10-15T10:00:00.000Z' });
    mockApi(s.routes);
    renderApp('/settings/attribution');
    expect(await screen.findByText(/Último aviso recibido/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Regenerar secreto' }));
    expect(screen.getByText(/El actual dejará de funcionar/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(s.posts).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Regenerar secreto' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, regenerar' }));
    const card = within(await screen.findByRole('region', { name: 'Datos del punto de entrada' }));
    expect(card.getByLabelText('Secreto')).toHaveValue('ssw_secreto-1-de-prueba-1234567890');
    expect(s.posts).toBe(1);
  });

  it('sin permiso (403) se explica y no se ofrece generar nada; un error al generar se muestra', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /attribution/endpoint': () => err(403, 'FORBIDDEN') });
    const a = renderApp('/settings/attribution');
    expect(await screen.findByRole('alert')).toHaveTextContent('Solo el administrador de la empresa puede ver y cambiar esto.');
    expect(screen.queryByRole('button', { name: /Generar|Regenerar/ })).not.toBeInTheDocument();
    a.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    const s = server(none, { post: () => err(500, 'INTERNAL') });
    mockApi(s.routes);
    renderApp('/settings/attribution');
    await userEvent.click(await screen.findByRole('button', { name: 'Generar punto de entrada' }));
    expect(await screen.findByText('Tuvimos un problema de nuestro lado. Inténtalo en unos minutos.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Datos del punto de entrada' })).not.toBeInTheDocument();
  });

  it('explica cómo conectarlo en GoHighLevel con la cabecera y el cuerpo esperados', async () => {
    mockApi(server(live).routes);
    renderApp('/settings/attribution');
    const how = within(await screen.findByRole('region', { name: 'Cómo conectarlo' }));
    expect(how.getByText('X-Webhook-Secret')).toBeInTheDocument();
    expect(how.getByText(/"ctwa_cl_id"/)).toBeInTheDocument();
  });
});

// ── Ficha del contacto: etiquetas y origen del lead ──

const attribution = (over: Partial<ContactAttribution> = {}): ContactAttribution => ({
  ctwa_cl_id: 'ARAbC123456789xyzQ',
  first_touch: { at: '2026-10-10T15:00:00.000Z', source: 'meta_ctwa', campaign: 'Cursos octubre', adset: 'Conjunto A', ad: 'Anuncio 1' },
  last_touch: { at: '2026-10-12T09:00:00.000Z', source: 'meta_ctwa', campaign: 'Barbería', adset: 'Conjunto B', ad: 'Anuncio 2' },
  capi: null,
  ...over,
});
const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1', name: 'Ana Torres', email: null, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'meta_ctwa', consent: 'unknown', consent_updated_at: null,
  custom_fields: {}, tags: [{ id: 't1', name: 'Lead', color: '#2563eb', system_key: 'lead', is_system: true }], attribution: attribution(), created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});
function contactsServer(c: Contact) {
  const calls = { n: 0 };
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /contacts': () => { calls.n += 1; return { body: { items: [c], next_cursor: null, total: 1, access: { view_all: true, write: true, delete: true } } }; },
    'GET /contacts/owners': () => ({ body: { items: [] } }),
  };
  return { routes, calls };
}
const openContact = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
  return within(await screen.findByRole('dialog', { name: 'Contacto' }));
};

describe('Ficha del contacto · Origen del lead', () => {
  it('muestra las etiquetas del sistema y el origen del lead (solo lectura) con campaña, conjunto, anuncio, clic, fechas y estado de la compra', async () => {
    const s = contactsServer(contact({ attribution: attribution({ capi: { status: 'sent', sent_at: '2026-10-14T18:30:00.000Z' } }) }));
    mockApi(s.routes);
    renderApp('/contacts');
    const d = await openContact();
    expect(within(d.getByRole('list', { name: 'Etiquetas' })).getByText('Lead')).toBeInTheDocument();
    const o = within(d.getByRole('region', { name: 'Origen del lead' }));
    expect(o.getByText('Click to WhatsApp')).toBeInTheDocument();
    expect(o.getByText('Barbería')).toBeInTheDocument(); // el último clic manda
    expect(o.getByText('Conjunto B')).toBeInTheDocument();
    expect(o.getByText('Anuncio 2')).toBeInTheDocument();
    expect(o.getByText('ARAbC123…xyzQ')).toBeInTheDocument(); // truncado
    expect(o.getByText(/Cursos octubre/)).toBeInTheDocument(); // primer clic
    expect(o.getByText('Enviado a Meta')).toBeInTheDocument();
    expect(o.queryByRole('textbox')).not.toBeInTheDocument(); // nada editable
  });

  it('se puede colapsar sin llamar al servidor; sin atribución no hay sección; una compra sin enviar se explica', async () => {
    const s = contactsServer(contact());
    mockApi(s.routes);
    const a = renderApp('/contacts');
    let d = await openContact();
    const before = s.calls.n;
    const toggle = d.getByRole('button', { name: 'Origen del lead' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(d.getByText('Sin compra registrada')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(d.queryByText('Anuncio 2')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(d.getByText('Anuncio 2')).toBeInTheDocument();
    expect(s.calls.n).toBe(before);
    a.unmount();

    vi.unstubAllGlobals();
    resetWorld();
    mockApi(contactsServer(contact({ attribution: null, tags: [], source: 'manual' })).routes);
    renderApp('/contacts');
    d = await openContact();
    expect(d.queryByRole('region', { name: 'Origen del lead' })).not.toBeInTheDocument();
    expect(d.queryByRole('list', { name: 'Etiquetas' })).not.toBeInTheDocument();
  });

  it('copia el CTWA Click ID al portapapeles', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi(contactsServer(contact({ attribution: attribution({ capi: { status: 'pending', sent_at: null } }) })).routes);
    renderApp('/contacts');
    const d = await openContact();
    expect(d.getByText('Pendiente de enviar')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Copiar CTWA Click ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ARAbC123456789xyzQ'));
    expect(await d.findByText('Copiado')).toBeInTheDocument();
  });
});
