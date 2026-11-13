// E2E del v13 · S3 (burbujas y mensajes) en un navegador real contra la API y la web COMPILADAS: el color del tema en lo que escribe una persona, la ubicación con mapa (y la política de contenido
// que deja cargar las baldosas de OpenStreetMap) y responder citando —con el botón en escritorio y arrastrando con el dedo en móvil—.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin as login, uniqueEmail } from './support';

async function uiLogin(page: Page, email: string): Promise<void> {
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** Los proveedores de la plataforma que hacen falta para conectar un chip por QR (Evolution de mentira). */
async function enableQr(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v13-0123456789abcdef', verify_token: 'verify-e2e-v13-0123456789' } } })).status()).toBe(200);
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


/** Una empresa con un chip QR y una conversación EN CURSO con tres mensajes: uno del cliente con su identificador, una ubicación y uno nuestro ya enviado. */
async function fixture(request: APIRequestContext): Promise<{ email: string; convId: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v13s3'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip v13s3' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  const convId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const phone = '593984230001';
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Burbujas', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [me.org, contact, `+${phone}`]);
    const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now() - interval '2 minutes', 0, $5) RETURNING id`, [me.org, contact, qr.id, me.uid, phone])).rows[0].id as string;
    const add = (ext: string, dir: 'in' | 'out', kind: string, body: string | null, meta: unknown, at: string) =>
      db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, meta, status, sent_at, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now() - $11::interval, $12)`, [me.org, conv, qr.id, ext, dir, dir === 'in' ? 'contact' : 'human', kind, body, JSON.stringify(meta), dir === 'in' ? 'received' : 'sent', at, dir === 'out' ? me.uid : null]);
    await add('wamid.S3.1', 'in', 'text', '¿Atienden mañana?', { wa_id: phone }, '10 minutes');
    await add('wamid.S3.2', 'in', 'location', null, { wa_id: phone, location: { latitude: -2.17, longitude: -79.92, name: 'Oficina Centro', address: 'Av. 9 de Octubre 100' } }, '8 minutes');
    await add('wamid.S3.3', 'out', 'text', 'Sí, de 9 a 18', { wa_id: phone }, '6 minutes');
    return conv;
  });
  return { email, convId };
}

test.describe('escritorio 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lo que escribe una persona lleva el degradado del tema con texto legible; la ubicación se ve como mapa sin que la política de contenido bloquee las baldosas', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    const violations: string[] = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to load/i.test(m.text()) && /openstreetmap/i.test(m.text())) violations.push(m.text()); });
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Burbujas' });
    const mine = chat.getByText('Sí, de 9 a 18').locator('xpath=ancestor::div[contains(@class,"bubble-grad")][1]');
    await expect(mine).toBeVisible();
    const css = await mine.evaluate((el) => { const s = getComputedStyle(el); return { img: s.backgroundImage, color: s.color }; });
    expect(css.img).toContain('linear-gradient');
    expect(css.color).toMatch(/^rgb/);
    // la ubicación: mapa con su enlace; las baldosas cargan (o, sin red, se cae a la tarjeta con el pin) y la política de contenido no las bloquea
    const map = chat.getByRole('link', { name: /^Abrir la ubicación en el mapa: Oficina Centro/ });
    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute('href', /openstreetmap\.org\/\?mlat=-2\.17&mlon=-79\.92/);
    await expect(chat.getByText('Oficina Centro · Av. 9 de Octubre 100')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(violations).toEqual([]);
    // la vista previa de la lista
    await page.goto('/inbox');
    await expect(page.getByRole('link', { name: /Cliente Burbujas/ })).toBeVisible();
  });

  test('«Responder» cita el mensaje: la cita queda sobre el redactor, viaja con el envío y se ve dentro de la burbuja; tocarla salta al original', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Burbujas' });
    const original = chat.getByText('¿Atienden mañana?').locator('xpath=ancestor::li[1]');
    await original.hover();
    await original.getByRole('button', { name: 'Responder a este mensaje' }).click();
    const bar = chat.getByRole('group', { name: 'Respondiendo a un mensaje' });
    await expect(bar).toContainText('Respondiendo a Cliente Burbujas');
    await expect(bar).toContainText('¿Atienden mañana?');
    const box = chat.getByRole('textbox', { name: 'Mensaje' });
    await expect(box).toBeFocused();
    await box.fill('Sí, mañana abrimos a las 9');
    await chat.getByRole('button', { name: 'Enviar', exact: true }).click();
    const quoted = chat.getByRole('log', { name: 'Mensajes' }).getByRole('button', { name: /^Mensaje citado de Cliente Burbujas: ¿Atienden mañana\?/ });
    await expect(quoted).toBeVisible({ timeout: 30_000 });
    await expect(bar).toHaveCount(0);
    const row = await withDb(async (db) => (await db.query(`SELECT m.body, q.external_id AS quoted FROM messages m JOIN messages q ON q.id = m.reply_to_message_id WHERE m.conversation_id = $1`, [convId])).rows as Array<{ body: string; quoted: string }>);
    expect(row).toEqual([{ body: 'Sí, mañana abrimos a las 9', quoted: 'wamid.S3.1' }]);
    await quoted.click();
    await expect(chat.locator('#msg-' + (await withDb(async (db) => (await db.query(`SELECT id FROM messages WHERE external_id = 'wamid.S3.1'`)).rows[0].id as string)))).toHaveClass(/flash-msg/);
  });
});

test.describe('móvil 390 × 844 con pantalla táctil', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('arrastrar una burbuja a la derecha fija la cita sobre el redactor; un arrastre corto o vertical no', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Burbujas' });
    const bubble = chat.getByText('¿Atienden mañana?');
    await expect(bubble).toBeVisible();
    const b = (await bubble.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (dx: number, dy: number): Promise<void> => {
      const x = Math.round(b.x + 20);
      const y = Math.round(b.y + b.height / 2);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(30, 0); // se queda corto
    await expect(chat.getByRole('group', { name: 'Respondiendo a un mensaje' })).toHaveCount(0);
    await swipe(10, 120); // vertical
    await expect(chat.getByRole('group', { name: 'Respondiendo a un mensaje' })).toHaveCount(0);
    await swipe(110, 0); // pasa el umbral
    const bar = chat.getByRole('group', { name: 'Respondiendo a un mensaje' });
    await expect(bar).toContainText('¿Atienden mañana?');
    await bar.getByRole('button', { name: 'Cancelar la respuesta' }).click();
    await expect(bar).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
