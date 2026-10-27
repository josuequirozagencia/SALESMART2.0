// M9.2 — El formulario embebible (ADR-09/54) ejecutado con el MISMO texto que sirve la API, en un documento simulado (jsdom): dibujo, validación, envío, errores, evento para el Pixel,
// redirección y aislamiento del estilo de la página. El comportamiento en un navegador real (CSP de otras páginas, Turnstile real) se prueba en el E2E y con páginas reales.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORM_EMBED_SCRIPT } from '../../../packages/shared/src/form-embed';

const BASE = 'https://app.salesmart.test';
const TOKEN = '8a1d2e3f-0000-4000-8000-000000000001';
const DEF = {
  id: TOKEN,
  name: 'Landing de cursos',
  fields: [
    { key: 'nombre', kind: 'text', label: 'Nombre', required: true, options: null, placeholder: 'Tu nombre' },
    { key: 'whatsapp', kind: 'phone', label: 'WhatsApp', required: true, options: null, placeholder: null },
    { key: 'correo', kind: 'email', label: 'Correo', required: false, options: null, placeholder: null },
    { key: 'interes', kind: 'select', label: 'Interés', required: true, options: ['Uñas', 'Pestañas'], placeholder: null },
    { key: 'mensaje', kind: 'long_text', label: 'Mensaje', required: false, options: null, placeholder: null },
  ],
  consent_text: 'Acepto que me contacten por WhatsApp.',
  thanks_message: '¡Gracias, te escribimos!',
  redirect_url: null,
  captcha: { provider: 'fake', site_key: 'fake' },
};

interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }
let sent: Sent[] = [];
let respond: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, event_id: 'ev-1', message: '¡Gracias, te escribimos!', redirect_url: null } });
let definition: { status: number; body: unknown } = { status: 200, body: DEF };

function stubFetch(): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const s: Sent = { url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    sent.push(s);
    const r = s.method === 'GET' ? definition : respond(s);
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) });
  });
}

/** Pone la etiqueta `<script>` del cliente en la página, ejecuta el texto del embed como lo haría el navegador y espera a que dibuje. */
async function embed(attrs: Record<string, string> = {}, markup = ''): Promise<{ host: HTMLElement; shadow: ShadowRoot }> {
  document.body.innerHTML = markup;
  const s = document.createElement('script');
  s.src = `${BASE}/v1/embed/v1.js`;
  s.setAttribute('data-form', TOKEN);
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.body.appendChild(s);
  new Function(FORM_EMBED_SCRIPT)();
  const host = document.querySelector<HTMLElement>('[data-salesmart-form]')!;
  await vi.waitFor(() => expect(host.shadowRoot!.querySelector('form') ?? host.shadowRoot!.querySelector('.bad')).not.toBeNull());
  return { host, shadow: host.shadowRoot! };
}

const q = <T extends Element>(r: ParentNode, sel: string): T => {
  const e = r.querySelector<T>(sel);
  if (!e) throw new Error(`no hay ${sel}`);
  return e;
};
const type = (r: ParentNode, name: string, value: string): void => {
  const e = q<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(r, `[name=${name}]`);
  e.value = value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
};
const check = (r: ParentNode): void => {
  const c = q<HTMLInputElement>(r, '[name=consent]');
  c.checked = true;
};
const submit = (r: ParentNode): void => {
  q<HTMLFormElement>(r, 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};
function fillGood(r: ParentNode): void {
  type(r, 'nombre', 'Lucía Paredes');
  type(r, 'whatsapp', '0984217730');
  type(r, 'interes', 'Uñas');
  check(r);
}

beforeEach(() => {
  sent = [];
  definition = { status: 200, body: DEF };
  respond = () => ({ status: 200, body: { ok: true, event_id: 'ev-1', message: '¡Gracias, te escribimos!', redirect_url: null } });
  stubFetch();
  document.cookie = '_fbp=; max-age=0';
  document.cookie = '_fbc=; max-age=0';
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('el formulario embebible', () => {
  it('pide la definición pública al origen del propio script y dibuja los campos dentro de un Shadow DOM', async () => {
    const { host, shadow } = await embed();
    expect(sent[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/public/forms/${TOKEN}` });
    expect(shadow.querySelectorAll('label.f')).toHaveLength(5);
    expect(q<HTMLInputElement>(shadow, '[name=whatsapp]').type).toBe('tel');
    expect(q<HTMLInputElement>(shadow, '[name=correo]').type).toBe('email');
    expect(q<HTMLSelectElement>(shadow, '[name=interes]').options).toHaveLength(3);
    expect(q<HTMLTextAreaElement>(shadow, '[name=mensaje]')).toBeTruthy();
    expect(q(shadow, '.consent').textContent).toBe('Acepto que me contacten por WhatsApp.');
    // la página no ve el formulario por su DOM normal: el estilo de la página no lo toca
    expect(host.querySelector('form')).toBeNull();
  });

  it('con data-target lo dibuja en ese contenedor; sin él, justo después de la etiqueta; no se duplica si el script se carga dos veces', async () => {
    const { host } = await embed({ 'data-target': '#aqui' }, '<div id="aqui"></div>');
    expect(host.id).toBe('aqui');
    new Function(FORM_EMBED_SCRIPT)();
    expect(document.querySelectorAll('[data-salesmart-form]')).toHaveLength(1);
    const again = await embed();
    expect(again.host.previousElementSibling?.tagName).toBe('SCRIPT');
  });

  it('textos del servidor como texto, nunca como HTML (una etiqueta con <img onerror> no se interpreta)', async () => {
    definition = { status: 200, body: { ...DEF, name: '<b>x</b>', consent_text: '<img src=x onerror=alert(1)>', fields: [{ key: 'nombre', kind: 'text', label: '<script>alert(1)</script>', required: true, options: null, placeholder: null }, DEF.fields[1]] } };
    const { shadow } = await embed();
    expect(shadow.querySelector('img')).toBeNull();
    expect(shadow.querySelector('script')).toBeNull();
    expect(q(shadow, 'label.f span').textContent).toContain('<script>alert(1)</script>');
  });

  it('valida lo mínimo antes de enviar: obligatorios y consentimiento; no manda nada hasta que esté completo', async () => {
    const { shadow } = await embed();
    submit(shadow);
    expect(sent).toHaveLength(1); // solo la lectura de la definición
    const errs = [...shadow.querySelectorAll<HTMLElement>('.err')].filter((e) => !e.hidden).map((e) => e.textContent);
    expect(errs).toEqual(['Nombre es obligatorio', 'WhatsApp es obligatorio', 'Interés es obligatorio', 'Debes aceptar el consentimiento para enviar el formulario']);
    expect(q(shadow, '[name=nombre]').getAttribute('aria-invalid')).toBe('true');
  });

  it('envía los valores con la llave de idempotencia, el event_id, la página de origen y el captcha; avisa a la página con el evento para el Pixel y muestra el agradecimiento', async () => {
    const { shadow } = await embed();
    const events: Array<{ event_id: string; form: string }> = [];
    window.addEventListener('salesmart:lead', (e) => events.push((e as CustomEvent).detail));
    fillGood(shadow);
    type(shadow, 'correo', ' lucia@example.com ');
    submit(shadow);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const post = sent[1]!;
    expect(post).toMatchObject({ method: 'POST', url: `${BASE}/v1/public/forms/${TOKEN}/submit` });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.body).toMatchObject({ values: { nombre: 'Lucía Paredes', whatsapp: '0984217730', correo: 'lucia@example.com', interes: 'Uñas' }, consent: true, captcha_token: 'fake-pass', hp: '' });
    expect(post.body!['event_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body!['source_url']).toBe(location.href);
    expect(post.body!['values']).not.toHaveProperty('mensaje'); // lo vacío no se manda
    await vi.waitFor(() => expect(shadow.querySelector('.ok')?.textContent).toBe('¡Gracias, te escribimos!'));
    expect(shadow.querySelector('form')).toBeNull();
    expect(events).toEqual([{ event_id: 'ev-1', form: TOKEN }]);
  });

  it('manda los parámetros de campaña de la dirección y las cookies de Meta (fbc a partir de fbclid si no hay cookie)', async () => {
    history.replaceState({}, '', '/oferta?utm_source=facebook&utm_campaign=octubre&fbclid=ABC123&otro=x');
    document.cookie = '_fbp=fb.1.1700000000.999';
    const { shadow } = await embed();
    fillGood(shadow);
    submit(shadow);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const body = sent[1]!.body!;
    expect(body['utm']).toEqual({ utm_source: 'facebook', utm_campaign: 'octubre', fbclid: 'ABC123' });
    expect(String(body['fbc'])).toMatch(/^fb\.1\.\d+\.ABC123$/);
    expect(body['fbp']).toBe('fb.1.1700000000.999');
    history.replaceState({}, '', '/');
  });

  it('un reintento tras un fallo de red usa la MISMA llave y el MISMO event_id; tras un envío válido (nueva persona) cambian', async () => {
    const { shadow } = await embed();
    fillGood(shadow);
    let n = 0;
    respond = () => (++n === 1 ? { status: 500, body: { error: { code: 'INTERNAL_ERROR' } } } : { status: 200, body: { ok: true, event_id: 'ev-1', message: 'ok', redirect_url: null } });
    submit(shadow);
    await vi.waitFor(() => expect(shadow.querySelector('.bad:not([hidden])')?.textContent).toMatch(/No pudimos enviar el formulario/));
    submit(shadow);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]!.headers['idempotency-key']).toBe(sent[1]!.headers['idempotency-key']);
    expect(sent[2]!.body!['event_id']).toBe(sent[1]!.body!['event_id']);
  });

  it('un dato rechazado por el servidor se muestra junto a su campo y el siguiente intento usa otra llave', async () => {
    const { shadow } = await embed();
    fillGood(shadow);
    respond = () => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', details: [{ path: 'values.whatsapp', code: 'invalid_phone', message: 'WhatsApp: escribe un teléfono válido' }] } } });
    submit(shadow);
    await vi.waitFor(() => expect(q(shadow, '[name=whatsapp]').getAttribute('aria-invalid')).toBe('true'));
    expect([...shadow.querySelectorAll('.err')].find((e) => e.textContent === 'WhatsApp: escribe un teléfono válido')).toBeTruthy();
    respond = () => ({ status: 200, body: { ok: true, event_id: 'ev-2', message: 'ok', redirect_url: null } });
    submit(shadow);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]!.headers['idempotency-key']).not.toBe(sent[1]!.headers['idempotency-key']);
  });

  it.each([
    [403, undefined, /no está autorizado para este sitio/],
    [404, undefined, /no está disponible por ahora/],
    [429, undefined, /Demasiados intentos/],
    [400, 'CAPTCHA_FAILED', /No pudimos comprobar que eres una persona/],
  ])('el error %s del servidor se explica con un mensaje claro', async (status, code, text) => {
    const { shadow } = await embed();
    fillGood(shadow);
    respond = () => ({ status, body: code ? { error: { code } } : { error: { code: 'X' } } });
    submit(shadow);
    await vi.waitFor(() => expect(shadow.querySelector('.bad:not([hidden])')?.textContent).toMatch(text));
    expect(q<HTMLButtonElement>(shadow, 'button').disabled).toBe(false);
  });

  it('el campo trampa viaja vacío para las personas', async () => {
    const { shadow } = await embed();
    fillGood(shadow);
    submit(shadow);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body!['hp']).toBe('');
    expect(q(shadow, '.hp').getAttribute('aria-hidden')).toBe('true');
  });

  it('si el formulario no está disponible o no está autorizado para este sitio lo dice en vez de dibujarlo', async () => {
    definition = { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    const a = await embed();
    expect(a.shadow.querySelector('.bad')?.textContent).toMatch(/no está disponible por ahora/);
    expect(a.shadow.querySelector('form')).toBeNull();
    definition = { status: 403, body: { error: { code: 'ORIGIN_NOT_ALLOWED' } } };
    const b = await embed();
    expect(b.shadow.querySelector('.bad')?.textContent).toMatch(/no está autorizado para este sitio/);
  });

  it('sin la etiqueta data-form no hace nada', () => {
    document.body.innerHTML = '';
    const s = document.createElement('script');
    s.src = `${BASE}/v1/embed/v1.js`;
    document.body.appendChild(s);
    new Function(FORM_EMBED_SCRIPT)();
    expect(document.querySelector('[data-salesmart-form]')).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('el texto del embed no usa eval, innerHTML ni document.write', () => {
    expect(FORM_EMBED_SCRIPT).not.toMatch(/\beval\s*\(|new Function|innerHTML|outerHTML|document\.write|insertAdjacentHTML/);
  });
});
