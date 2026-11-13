// E2E del v13 · S1 (Inbox móvil) en un navegador real contra la API y la web COMPILADAS, a 390 × 844: «Aceptar» en la fila de «Esperando», el icono de etiquetas de la cabecera y su popover, y mantener
// pulsado «Enviar» para programar (en una conversación de WhatsApp por QR, sin ventana de 24 h).
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

/** Una empresa con un chip QR, una conversación POR ACEPTAR y otra EN CURSO (con la etiqueta de sistema Venta y una etiqueta personalizada disponible). */
async function fixture(request: APIRequestContext): Promise<{ email: string; workingId: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v13s1'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip v13' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  const t = await request.post(`${apiBase}/v1/tags`, { headers: adm, data: { name: 'Interesado', color: '#4f46e5' } });
  expect(t.status(), await t.text()).toBe(201);
  const workingId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const make = async (name: string, phone: string, status: 'pending' | 'working'): Promise<string> => {
      const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [me.org, name, me.uid])).rows[0].id as string;
      await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [me.org, contact, `+${phone}`]);
      const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now(), now() - interval '3 days', 0, $6) RETURNING id`, [me.org, contact, qr.id, status, me.uid, phone])).rows[0].id as string;
      await db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola, ¿hay turno?', 'received', now() - interval '3 days')`, [me.org, conv, qr.id, `wamid.${phone}`]);
      return contact;
    };
    await make('Cliente Pendiente', '593984210001', 'pending');
    const contact = await make('Cliente Activo', '593984210002', 'working');
    await db.query(`INSERT INTO tags(id, organization_id, name, color, is_system, system_key) VALUES (gen_random_uuid(), $1, 'Venta', '#d97706', true, 'sale') ON CONFLICT DO NOTHING`, [me.org]);
    await db.query(`INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) SELECT $1, $2, id, 'system' FROM tags WHERE organization_id = $1 AND system_key = 'sale' ON CONFLICT DO NOTHING`, [me.org, contact]);
    return (await db.query(`SELECT id FROM conversations WHERE contact_id = $1`, [contact])).rows[0].id as string;
  });
  return { email, workingId };
}

test.describe('390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('«Aceptar» en la fila de Esperando acepta sin abrir el chat y la fila pasa a Trabajando', async ({ page, request }) => {
    const { email } = await fixture(request);
    await uiLogin(page, email);
    await page.goto('/inbox');
    await page.getByRole('tab', { name: /^Esperando/ }).click();
    const row = page.getByRole('link', { name: /Cliente Pendiente/ });
    await expect(row).toBeVisible();
    // alto de la fila (v13 S1.3) y área táctil del botón
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(75.5);
    const accept = page.getByRole('button', { name: 'Aceptar la conversación de Cliente Pendiente' });
    const box = (await accept.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await accept.click();
    await expect(page.getByRole('status').filter({ hasText: 'Aceptaste la conversación de Cliente Pendiente' })).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('link', { name: /Cliente Pendiente/ })).toHaveCount(0);
    await page.getByRole('tab', { name: /^Trabajando/ }).click();
    await expect(page.getByRole('link', { name: /Cliente Pendiente/ })).toBeVisible();
  });

  test('el icono de etiquetas abre el popover: Venta (sistema) solo se lee y una etiqueta personalizada se marca; Esc cierra y devuelve el foco', async ({ page, request }) => {
    const { email, workingId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${workingId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Activo' });
    await expect(chat.getByRole('button', { name: 'Ver los datos de Cliente Activo' })).toContainText('· QR');
    const icon = chat.getByRole('button', { name: /^Etiquetas de la conversación/ });
    await expect(icon).toBeVisible();
    expect((await icon.boundingBox())!.width).toBeGreaterThanOrEqual(43.5);
    await icon.click();
    const pop = page.getByRole('dialog', { name: 'Etiquetas de la conversación' });
    await expect(pop).toBeVisible();
    await expect(pop.getByText('Venta', { exact: true })).toBeVisible();
    await expect(pop.getByRole('checkbox', { name: 'Venta' })).toHaveCount(0);
    const mine = pop.getByRole('checkbox', { name: 'Interesado' });
    await mine.click(); // el cambio llega cuando el servidor responde (no es síncrono)
    await expect(mine).toBeChecked();
    await expect(chat.getByRole('button', { name: 'Etiquetas de la conversación (2)' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(chat.getByRole('button', { name: /^Etiquetas de la conversación/ })).toBeFocused();
  });

  test('mantener pulsado «Enviar» abre «Programar mensaje» (QR: sin ventana de 24 h) y no envía; un toque corto sí envía', async ({ page, request }) => {
    const { email, workingId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${workingId}`);
    const box = page.getByRole('textbox', { name: 'Mensaje' });
    // sin texto, el botón de la derecha es el micrófono
    await expect(page.getByRole('button', { name: 'Grabar nota de voz' })).toBeVisible();
    await box.fill('Te escribo mañana temprano');
    await expect(page.getByRole('button', { name: 'Grabar nota de voz' })).toHaveCount(0);
    const send = page.getByRole('button', { name: 'Enviar' });
    const b = (await send.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    const dlg = page.getByRole('dialog', { name: 'Programar mensaje' });
    await expect(dlg).toBeVisible();
    // el último mensaje del cliente es de hace 3 días y por QR no importa: se puede programar y no pide plantilla
    await expect(dlg.getByText(/Pasaron más de 24 horas/)).toHaveCount(0);
    await expect(dlg.getByText(/Puedes programarlo hasta/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancelar' }).click();
    await expect(box).toHaveValue('Te escribo mañana temprano'); // no se envió
    await send.click();
    await expect(box).toHaveValue('');
    await expect(page.getByRole('region', { name: 'Conversación con Cliente Activo' }).getByText('Te escribo mañana temprano', { exact: true })).toBeVisible();
  });
});
