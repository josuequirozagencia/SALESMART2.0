// E2E del redactor móvil a las medidas de varios teléfonos (Samsung Galaxy Note 20: 412 × 915 en CSS; también 393, 384 y 360 de ancho): TODOS los botones del redactor (+, emojis y
// micrófono/enviar) deben quedar DENTRO de la pantalla. `scrollWidth` no basta: la pantalla del chat recorta lo que sobra (`overflow: hidden`), así que se mide la posición de cada botón.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin as login, uniqueEmail } from './support';

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function enableQr(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v17-0123456789abcdef', verify_token: 'verify-e2e-v17-0123456789' } } })).status()).toBe(200);
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/active`, { headers: root, data: { provider: 'meta_cloud' } })).status()).toBe(200);
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_qr/evolution/credentials`, { headers: root, data: { values: { base_url: 'https://evolution.ejemplo.com', api_key: 'fake-qr-key' } } })).status()).toBe(200);
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_qr/active`, { headers: root, data: { provider: 'evolution' } })).status()).toBe(200);
}

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: state().adminDbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Una empresa con un chip QR y UNA conversación en curso de la persona de la prueba. Devuelve el correo y el id de la conversación. */
async function fixture(request: APIRequestContext): Promise<{ email: string; conv: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v17'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip v17' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  const conv = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Movil', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984217001', true)`, [me.org, contact]);
    const id = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593984217001') RETURNING id`, [me.org, contact, qr.id, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'wamid.v17', 'in', 'contact', 'text', 'Buenas, quiero información', 'received', now())`, [me.org, id, qr.id]);
    return id;
  });
  return { email, conv };
}

async function uiLogin(page: Page, email: string): Promise<void> {
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

/** Cada control del redactor dentro de la ventana: [nombre, izquierda, derecha]. */
async function composerBoxes(page: Page): Promise<Array<{ name: string; left: number; right: number; width: number }>> {
  return page.evaluate(() => {
    const out: Array<{ name: string; left: number; right: number; width: number }> = [];
    for (const label of ['Más opciones', 'Mensaje', 'Emojis', 'Grabar nota de voz', 'Enviar']) {
      const el = document.querySelector(`[aria-label="${label}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out.push({ name: label, left: r.left, right: r.right, width: r.width });
    }
    return out;
  });
}

// Samsung Galaxy Note 20 (1080 × 2400 px, ~2,6 de densidad → 412 × 915 CSS) y otros anchos habituales; el último es un Android con «Tamaño de pantalla» grande.
const SIZES = [
  { width: 412, height: 915 },
  { width: 393, height: 851 },
  { width: 384, height: 800 },
  { width: 360, height: 740 },
  { width: 320, height: 640 },
] as const;

for (const size of SIZES) {
  test.describe(`${size.width} × ${size.height}`, () => {
    test.use({ viewport: size });

    test('los tres botones del redactor quedan dentro de la pantalla, también con texto largo escrito', async ({ page, request }) => {
      const { email, conv } = await fixture(request);
      await uiLogin(page, email);
      await page.goto(`/inbox/${conv}`);
      const input = page.getByRole('textbox', { name: 'Mensaje' });
      await expect(input).toBeVisible();

      // Sin texto: «+», cuadro, emojis y micrófono
      let boxes = await composerBoxes(page);
      expect(boxes.map((b) => b.name)).toEqual(['Más opciones', 'Mensaje', 'Emojis', 'Grabar nota de voz']);
      for (const b of boxes) {
        expect(b.left, `${b.name} no debe salirse por la izquierda`).toBeGreaterThanOrEqual(0);
        expect(b.right, `${b.name} no debe salirse por la derecha (ancho de la ventana ${size.width})`).toBeLessThanOrEqual(size.width + 0.5);
      }
      // los botones conservan su tamaño táctil: es el cuadro de texto el que cede
      for (const b of boxes.filter((x) => x.name !== 'Mensaje')) expect(b.width).toBeGreaterThanOrEqual(43.5);

      // Con texto largo (varias líneas) aparece «Enviar» en lugar del micrófono y también cabe
      await input.fill('Hola, claro que sí. Te explico el proceso completo de la estética integral y los horarios disponibles para esta semana.');
      boxes = await composerBoxes(page);
      expect(boxes.map((b) => b.name)).toEqual(['Más opciones', 'Mensaje', 'Emojis', 'Enviar']);
      for (const b of boxes) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right, `${b.name} no debe salirse por la derecha`).toBeLessThanOrEqual(size.width + 0.5);
      }
      await expect(page.getByRole('button', { name: 'Enviar' })).toBeVisible();
      // y nada de la pantalla del chat asoma fuera de la ventana
      const over = await page.evaluate(() => {
        const root = document.querySelector('.chat-screen');
        if (!root) return ['sin .chat-screen'];
        const bad: string[] = [];
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (el.closest('[aria-hidden="true"], .sr-only')) continue;
          if (r.right > window.innerWidth + 0.5) bad.push(`${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} → ${Math.round(r.right)}`);
        }
        return bad.slice(0, 8);
      });
      expect(over).toEqual([]);
    });
  });
}
