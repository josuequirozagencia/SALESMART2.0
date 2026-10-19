import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderField, ProviderItem, ProviderService, ProvidersList } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const SECRET = 'sk-live-ABCDEF1234567890cdef';

/** Un campo de un proveedor: TODO se guarda cifrado y solo se ve su final; `masked` solo decide cómo se teclea. */
const fld = (key: string, label: string, over: Partial<ProviderField> = {}): ProviderField => ({ key, label, masked: true, required: true, hint: null, set: false, last4: null, ...over });
const prov = (key: string, label: string, fields: ProviderField[], over: Partial<ProviderItem> = {}): ProviderItem => ({ key, label, maturity: 'planned', note: null, configured: fields.every((f) => !f.required || f.set), fields, updated_at: null, ...over });
const svc = (key: string, label: string, providers: ProviderItem[], over: Partial<ProviderService> = {}): ProviderService => ({ key, label, adapter: 'XProvider', managed: 'platform', note: `Nota de ${label}`, active: null, mode: null, webhook_url: null, providers, ...over });

const world = (): ProvidersList => ({
  vault: { available: true },
  services: [
    svc('text_ai', 'IA de texto', [
      prov('openai', 'OpenAI', [fld('api_key', 'Clave de API', { set: true, last4: 'cdef' })]),
      prov('gemini', 'Google Gemini', [fld('api_key', 'Clave de API')]),
    ], { active: 'openai', adapter: 'AIProvider' }),
    svc('storage', 'Almacenamiento', [
      prov('s3_compatible', 'S3 compatible', [
        fld('endpoint', 'Endpoint', { masked: false, set: true, last4: 'test' }),
        fld('region', 'Región', { masked: false, set: true, last4: 'st-1' }),
        fld('secret_access_key', 'Clave de acceso secreta', { set: true, last4: 'EKEY' }),
      ]),
    ]),
    svc('whatsapp_qr', 'WhatsApp por QR', [prov('evolution', 'Evolution API (QR)', [fld('base_url', 'URL de la instancia', { masked: false }), fld('api_key', 'Clave global de la API')], { maturity: 'reserved', note: 'No oficial: riesgo de bloqueo del número.' })]),
    svc('mail', 'Correo transaccional', [prov('resend', 'Resend', [], { configured: false })], { managed: 'env', mode: 'none', note: 'Se configura con variables de entorno.' }),
    svc('captcha', 'Anti-bots del registro', [prov('turnstile', 'Cloudflare Turnstile', [], { configured: true })], { managed: 'env', mode: 'turnstile', active: 'turnstile' }),
    svc('auth', 'Autenticación', [prov('local', 'LocalAuthProvider · Argon2id', [])], { managed: 'fixed', active: 'local' }),
    svc('ghl', 'GoHighLevel', [prov('private_token', 'Token privado por empresa', [])], { managed: 'client', active: 'private_token' }),
    svc('payments', 'Pasarela de pago', [], { note: 'Decisión abierta.' }),
  ],
});

interface Calls { saves: unknown[]; actives: unknown[]; clears: string[] }
const newCalls = (): Calls => ({ saves: [], actives: [], clears: [] });

/** Servidor de proveedores con estado (como el real: ningún valor vuelve, solo su final). mockApi no admite rutas con parámetros: se enrutan una a una. */
function routed(w: ProvidersList, calls: Calls, over: { save?: () => ReturnType<Handler>; active?: () => ReturnType<Handler>; clear?: () => ReturnType<Handler> } = {}): Record<string, Handler> {
  const out: Record<string, Handler> = {
    ...authed(ME_ROOT, null),
    'GET /platform/trials': () => ({ body: NO_TRIALS }),
    'GET /platform/providers': () => ({ body: structuredClone(w) }),
  };
  for (const s of w.services) {
    out[`PUT /platform/providers/${s.key}/active`] = over.active ?? (({ body }) => {
      calls.actives.push({ service: s.key, ...(body as object) });
      s.active = (body as { provider: string | null }).provider;
      return { body: { service: s.key, active: s.active, changed: true } };
    });
    for (const p of s.providers) {
      out[`PUT /platform/providers/${s.key}/${p.key}/credentials`] = over.save ?? (({ body }) => {
        const b = body as { values?: Record<string, string>; clear?: string[] };
        calls.saves.push({ service: s.key, provider: p.key, ...b });
        for (const f of p.fields) {
          const v = b.values?.[f.key];
          if (v !== undefined) Object.assign(f, { set: true, last4: v.length >= 8 ? v.slice(-4) : null });
          if (b.clear?.includes(f.key)) Object.assign(f, { set: false, last4: null });
        }
        p.configured = p.fields.every((f) => !f.required || f.set);
        return { body: structuredClone(p) };
      });
      out[`DELETE /platform/providers/${s.key}/${p.key}/credentials`] = over.clear ?? (() => {
        calls.clears.push(`${s.key}/${p.key}`);
        for (const f of p.fields) Object.assign(f, { set: false, last4: null });
        p.configured = false;
        return { body: { service: s.key, provider: p.key, cleared: true } };
      });
    }
  }
  return out;
}
const card = async (name: string) => screen.findByRole('region', { name });

describe('Proveedores (solo Súper Admin)', () => {
  it('la consola tiene la pestaña «Proveedores»; cada servicio muestra su proveedor en uso, su modo y la advertencia de lo no oficial', async () => {
    mockApi(routed(world(), newCalls()));
    renderApp('/platform/providers');
    expect(await screen.findByRole('link', { name: 'Proveedores' })).toHaveAttribute('href', '/platform/providers');
    const ai = await card('IA de texto');
    expect(within(ai).getByText('En uso: OpenAI')).toBeInTheDocument();
    expect(within(ai).getByText('Con credenciales')).toBeInTheDocument();
    expect(within(ai).getByText('Faltan datos')).toBeInTheDocument();
    expect(within(await card('Almacenamiento')).getByText('Sin proveedor en uso')).toBeInTheDocument();
    const qr = await card('WhatsApp por QR');
    expect(within(qr).getByText('Con reservas')).toBeInTheDocument();
    expect(within(qr).getByText('No oficial: riesgo de bloqueo del número.')).toBeInTheDocument();
    expect(within(await card('Correo transaccional')).getByText('Sin proveedor: los correos no salen')).toBeInTheDocument();
    expect(within(await card('Anti-bots del registro')).getByText('Turnstile activo')).toBeInTheDocument();
    expect(within(await card('Autenticación')).getByText('Fijo')).toBeInTheDocument();
    expect(within(await card('GoHighLevel')).getByText('Por empresa')).toBeInTheDocument();
    expect(within(await card('Pasarela de pago')).getByText('Todavía no hay candidatos.')).toBeInTheDocument();
    // los servicios que no se configuran aquí no ofrecen «Configurar»
    expect(within(await card('Correo transaccional')).queryByRole('button', { name: /Configurar/ })).not.toBeInTheDocument();
  });

  it('quien no es Súper Admin no ve la pantalla ni la pide al servidor', async () => {
    const api = mockApi({ ...authed(ME_ADMIN, null), 'GET /trials/me': () => err(404, 'NOT_FOUND') });
    renderApp('/platform/providers');
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(api.count('GET /platform/providers')).toBe(0);
  });

  it('un valor guardado se muestra solo como «termina en …»; guardar uno nuevo envía únicamente ese campo y el valor NUNCA queda en pantalla', async () => {
    const calls = newCalls();
    mockApi(routed(world(), calls));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('IA de texto')).getByRole('button', { name: 'Configurar Google Gemini' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de Google Gemini' });
    const input = within(dlg).getByLabelText('Clave de API');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    await u.type(input, SECRET);
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    expect(await within(dlg).findByText('Guardado.')).toBeInTheDocument();
    expect(calls.saves).toEqual([{ service: 'text_ai', provider: 'gemini', values: { api_key: SECRET } }]);
    expect(input).toHaveValue(''); // el campo se vacía
    expect(document.body.textContent).not.toContain(SECRET);
    expect(await within(dlg).findByText(/Guardado \(termina en cdef\)/)).toBeInTheDocument();
  });

  it('un valor ya guardado: se conserva si se deja vacío (no hay petición) y se puede quitar con la casilla', async () => {
    const calls = newCalls();
    const w = world();
    w.services[0]!.active = null; // OpenAI deja de estar en uso: sus valores se pueden quitar
    mockApi(routed(w, calls));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('IA de texto')).getByRole('button', { name: 'Configurar OpenAI' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de OpenAI' });
    expect(within(dlg).getByText(/Guardado \(termina en cdef\)\. Déjalo vacío para conservarlo/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    expect(await within(dlg).findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(calls.saves).toEqual([]);
    await u.click(within(dlg).getByLabelText('Quitar clave de api'));
    expect(within(dlg).getByText('Se quitará al guardar.')).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls.saves).toEqual([{ service: 'text_ai', provider: 'openai', clear: ['api_key'] }]));
  });

  it('también la URL y la región: no se muestran (solo cómo terminan), se teclean a la vista y solo se envía lo que se escribió; quitar uno envía «clear»', async () => {
    const calls = newCalls();
    mockApi(routed(world(), calls));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('Almacenamiento')).getByRole('button', { name: 'Configurar S3 compatible' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de S3 compatible' });
    expect(within(dlg).getByLabelText('Endpoint')).toHaveValue('');
    expect(within(dlg).getByLabelText('Endpoint')).toHaveAttribute('type', 'text'); // a la vista al teclear
    expect(within(dlg).getByLabelText('Clave de acceso secreta')).toHaveAttribute('type', 'password');
    expect(within(dlg).getByText(/Guardado \(termina en test\)/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Guardado \(termina en st-1\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('eu-west-1');
    await u.type(within(dlg).getByLabelText('Región'), 'us-east-1');
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls.saves).toEqual([{ service: 'storage', provider: 's3_compatible', values: { region: 'us-east-1' } }]));
    expect(await within(dlg).findByText(/Guardado \(termina en st-1\)/)).toBeInTheDocument(); // «us-east-1» termina igual: el final sale del servidor
    await u.click(within(dlg).getByLabelText('Quitar región'));
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls.saves.at(-1)).toEqual({ service: 'storage', provider: 's3_compatible', clear: ['region'] }));
  });

  it('un error de validación del servidor se muestra junto al campo, sin eco del valor', async () => {
    const calls = newCalls();
    mockApi(routed(world(), calls, { save: () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'x', request_id: 'r', details: [{ path: 'values.base_url', code: 'invalid_url', message: 'Debe ser una URL http(s) sin usuario, contraseña, parámetros ni fragmento' }] } } }) }));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('WhatsApp por QR')).getByRole('button', { name: 'Configurar Evolution API (QR)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de Evolution API (QR)' });
    await u.type(within(dlg).getByLabelText('URL de la instancia'), 'ftp://x');
    await u.type(within(dlg).getByLabelText('Clave global de la API'), SECRET);
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    expect(await within(dlg).findByText(/Debe ser una URL http\(s\)/)).toBeInTheDocument();
    expect(within(dlg).getAllByRole('alert').map((a) => a.textContent).join(' ')).not.toContain(SECRET);
  });

  it('sin clave de cifrado en el servidor: aviso en la página y TODOS los campos deshabilitados en el diálogo', async () => {
    const w = world();
    w.vault.available = false;
    mockApi(routed(w, newCalls()));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    expect(await screen.findByText(/Falta la clave de cifrado en el servidor \(PROVIDER_CREDENTIALS_KEY\): todavía no se pueden guardar credenciales/)).toBeInTheDocument();
    await u.click(within(await card('WhatsApp por QR')).getByRole('button', { name: 'Configurar Evolution API (QR)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de Evolution API (QR)' });
    expect(within(dlg).getByLabelText('Clave global de la API')).toBeDisabled();
    expect(within(dlg).getByLabelText('URL de la instancia')).toBeDisabled();
  });

  it('si el servidor responde 503 por la clave de cifrado, se muestra su motivo', async () => {
    mockApi(routed(world(), newCalls(), { save: () => err(503, 'PROVIDER_VAULT_UNAVAILABLE', 'No se pueden guardar credenciales: falta la clave de cifrado en el servidor (PROVIDER_CREDENTIALS_KEY)') }));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('WhatsApp por QR')).getByRole('button', { name: 'Configurar Evolution API (QR)' }));
    const dlg = await screen.findByRole('dialog', { name: 'Credenciales de Evolution API (QR)' });
    await u.type(within(dlg).getByLabelText('URL de la instancia'), 'https://evo.ejemplo.test');
    await u.click(within(dlg).getByRole('button', { name: 'Guardar' }));
    expect(await within(dlg).findByText(/falta la clave de cifrado en el servidor/)).toBeInTheDocument();
  });

  it('«Usar» solo con credenciales completas; activa, cambia y deja de usar', async () => {
    const calls = newCalls();
    mockApi(routed(world(), calls));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    const ai = await card('IA de texto');
    expect(within(ai).getByRole('button', { name: 'Usar Google Gemini' })).toBeDisabled(); // sin credenciales
    expect(within(ai).getByRole('button', { name: 'Dejar de usar OpenAI' })).toBeInTheDocument();
    await u.click(within(ai).getByRole('button', { name: 'Dejar de usar OpenAI' }));
    await waitFor(() => expect(calls.actives).toEqual([{ service: 'text_ai', provider: null }]));
    await u.click(await within(await card('IA de texto')).findByRole('button', { name: 'Usar OpenAI' }));
    await waitFor(() => expect(calls.actives.at(-1)).toEqual({ service: 'text_ai', provider: 'openai' }));
    expect(await within(await card('IA de texto')).findByText('En uso: OpenAI')).toBeInTheDocument();
  });

  it('un rechazo del servidor al activar (409) se explica en pantalla', async () => {
    mockApi(routed(world(), newCalls(), { active: () => err(409, 'PROVIDER_NOT_CONFIGURED', 'Faltan datos obligatorios de este proveedor: guárdalos antes de activarlo') }));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(await within(await card('IA de texto')).findByRole('button', { name: 'Dejar de usar OpenAI' }));
    expect(await screen.findByText(/Faltan datos obligatorios/)).toBeInTheDocument();
  });

  it('«Quitar todas las credenciales» pide confirmación y no se ofrece si el proveedor está en uso', async () => {
    const calls = newCalls();
    mockApi(routed(world(), calls));
    renderApp('/platform/providers');
    const u = userEvent.setup();
    await u.click(within(await card('IA de texto')).getByRole('button', { name: 'Configurar OpenAI' })); // en uso
    let dlg = await screen.findByRole('dialog', { name: 'Credenciales de OpenAI' });
    expect(within(dlg).getByText(/Este proveedor está en uso/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Quitar todas las credenciales' })).not.toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/Quitar clave/)).not.toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Cerrar' }));

    await u.click(within(await card('Almacenamiento')).getByRole('button', { name: 'Configurar S3 compatible' }));
    dlg = await screen.findByRole('dialog', { name: 'Credenciales de S3 compatible' });
    await u.click(within(dlg).getByRole('button', { name: 'Quitar todas las credenciales' }));
    expect(calls.clears).toEqual([]); // todavía no: pide confirmación
    await u.click(within(dlg).getByRole('button', { name: 'No' }));
    expect(calls.clears).toEqual([]);
    await u.click(within(dlg).getByRole('button', { name: 'Quitar todas las credenciales' }));
    await u.click(within(dlg).getByRole('button', { name: 'Sí, quitar' }));
    await waitFor(() => expect(calls.clears).toEqual(['storage/s3_compatible']));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('error de carga con «Reintentar»', async () => {
    let n = 0;
    mockApi({ ...routed(world(), newCalls()), 'GET /platform/providers': () => (++n === 1 ? err(500, 'INTERNAL') : { body: world() }) });
    renderApp('/platform/providers');
    const u = userEvent.setup();
    expect(await screen.findByText(/Tuvimos un problema de nuestro lado/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await card('IA de texto')).toBeInTheDocument();
  });
});

describe('WhatsApp oficial · dirección del webhook (M5.2)', () => {
  it('muestra la URL pública del servidor para pegarla en Meta, con el aviso del token de verificación; los demás servicios no la muestran', async () => {
    const w = world();
    w.services.push(svc('whatsapp_official', 'WhatsApp oficial', [prov('meta_cloud', 'Meta WhatsApp Cloud API', [fld('app_secret', 'Secreto de la app')])], { adapter: 'WhatsAppProvider', webhook_url: 'https://app.ejemplo.test/v1/channels/meta/webhook' }));
    mockApi(routed(w, newCalls()));
    renderApp('/platform/providers');
    const card = within(await screen.findByRole('region', { name: 'WhatsApp oficial' }));
    expect(card.getByLabelText('Dirección del webhook')).toHaveValue('https://app.ejemplo.test/v1/channels/meta/webhook');
    expect(card.getByText(/token de verificación/)).toBeInTheDocument();
    expect(screen.getAllByLabelText('Dirección del webhook')).toHaveLength(1);
  });

  it('copia la dirección al portapapeles', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const w = world();
    w.services.push(svc('whatsapp_official', 'WhatsApp oficial', [prov('meta_cloud', 'Meta WhatsApp Cloud API', [fld('app_secret', 'Secreto de la app')])], { webhook_url: 'https://app.ejemplo.test/v1/channels/meta/webhook' }));
    mockApi(routed(w, newCalls()));
    renderApp('/platform/providers');
    await userEvent.click(await screen.findByRole('button', { name: 'Copiar Dirección del webhook' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.ejemplo.test/v1/channels/meta/webhook'));
  });
});
