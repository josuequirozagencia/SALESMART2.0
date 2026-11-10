// E2E del v9 en un navegador real contra la API y la web COMPILADAS: los mensajes escritos desde el teléfono de la línea QR se ven con «Desde el teléfono» y las burbujas llevan la sombra mínima
// en claro, en oscuro y con el tema WhatsApp. (La entrada del aviso `fromMe` por el webhook, el eco y los efectos —SLA, pausa del agente— se prueban con PostgreSQL real en `apps/api/test/qr/qr.test.ts`:
// aquí la conversación se crea directo, como en los demás E2E.)
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin as login, uniqueEmail } from './support';

async function uiLogin(page: Page, email: string): Promise<void> {
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function enableWhatsapp(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v9-0123456789abcdef', verify_token: 'verify-e2e-v9-0123456789' } } })).status()).toBe(200);
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/active`, { headers: root, data: { provider: 'meta_cloud' } })).status()).toBe(200);
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

/** Una conversación con un mensaje del cliente, una respuesta de la plataforma (con autor) y un mensaje escrito desde el teléfono (sin autor). */
async function fixture(request: APIRequestContext): Promise<{ email: string; conversationId: string }> {
  const { apiBase } = state();
  await enableWhatsapp(request);
  const email = await createAccount(request, uniqueEmail('v9'));
  const adm = json(await apiLogin(request, email));
  const ch = await request.post(`${apiBase}/v1/channels`, { headers: adm, data: { name: 'Línea v9', waba_id: '1234567890123', phone_number_id: `10901234503${String(Math.floor(Math.random() * 90) + 10)}`, access_token: 'fake-valid-token' } });
  expect(ch.status(), await ch.text()).toBe(201);
  const channel = (await ch.json()) as { id: string };
  const conversationId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Teléfono', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984218888', true)`, [me.org, contact]);
    const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593984218888') RETURNING id`, [me.org, contact, channel.id, me.uid])).rows[0].id as string;
    const ins = (ext: string, dir: 'in' | 'out', sender: string, body: string, status: string, ago: number, createdBy: string | null, meta: string) =>
      db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at, created_by, meta) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'text', $7, $8, now() - make_interval(mins => $9), $10, $11::jsonb)`, [me.org, conv, channel.id, ext, dir, sender, body, status, ago, createdBy, meta]);
    await ins('wamid.V9A', 'in', 'contact', 'Hola, ¿hay turno?', 'received', 6, null, '{}');
    await ins('wamid.V9B', 'out', 'human', 'Respuesta desde la plataforma', 'sent', 4, me.uid, '{}');
    await ins('wamid.V9C', 'out', 'human', 'Te confirmo desde el celular', 'sent', 2, null, '{"origin":"device"}');
    return conv;
  });
  return { email, conversationId };
}

const shadowOf = (page: Page, text: string): Promise<string> =>
  page.getByText(text, { exact: true }).locator('xpath=ancestor::div[contains(@class,"relative")][1]').evaluate((el) => getComputedStyle(el).boxShadow);

test('mensajes desde el teléfono: la etiqueta «Desde el teléfono» solo en ese mensaje y la sombra de las burbujas es mínima en claro, en oscuro y con el tema WhatsApp', async ({ page, request }) => {
  const { email, conversationId } = await fixture(request);
  await page.emulateMedia({ colorScheme: 'light' });
  await uiLogin(page, email);
  await page.goto(`/inbox/${conversationId}`);
  const log = page.getByRole('log', { name: 'Mensajes' });
  await expect(log.getByText('Te confirmo desde el celular')).toBeVisible();

  // La etiqueta: solo el mensaje escrito en el teléfono, sin nombre de persona
  await expect(log.getByText('Desde el teléfono')).toHaveCount(1);
  const phoneBubble = log.getByText('Te confirmo desde el celular', { exact: true }).locator('xpath=ancestor::div[contains(@class,"relative")][1]');
  await expect(phoneBubble).toContainText('Desde el teléfono');
  await expect(log.getByText('Respuesta desde la plataforma', { exact: true }).locator('xpath=ancestor::div[contains(@class,"relative")][1]')).not.toContainText('Desde el teléfono');

  // Sombra mínima en claro: 1 px, desenfoque 1 px, opacidad 0,04 (no la de los paneles)
  for (const t of ['Hola, ¿hay turno?', 'Respuesta desde la plataforma', 'Te confirmo desde el celular']) {
    const s = await shadowOf(page, t);
    expect(s, t).toMatch(/rgba\(0, 0, 0, 0\.04\) 0px 1px 1px 0px/);
  }

  // Oscuro: la misma sombra con opacidad 0,12
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const t of ['Hola, ¿hay turno?', 'Te confirmo desde el celular']) expect(await shadowOf(page, t), t).toMatch(/rgba\(0, 0, 0, 0\.12\) 0px 1px 1px 0px/);

  // Tema WhatsApp (claro y oscuro): la sombra no depende de la marca
  await page.evaluate(() => document.documentElement.setAttribute('data-brand', 'whatsapp'));
  expect(await shadowOf(page, 'Hola, ¿hay turno?')).toMatch(/rgba\(0, 0, 0, 0\.12\) 0px 1px 1px 0px/);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await shadowOf(page, 'Hola, ¿hay turno?')).toMatch(/rgba\(0, 0, 0, 0\.04\) 0px 1px 1px 0px/);
});
