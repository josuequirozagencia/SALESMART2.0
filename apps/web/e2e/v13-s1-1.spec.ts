// E2E del addendum v13 · S1.1 («Aceptar» y «Asignarme» en la fila de la lista, solo móvil) en un navegador real contra la API y la web COMPILADAS, a 412 × 915 y a 360 × 800: el botón aparece
// SOLO en las conversaciones de «Esperando» (por aceptar o sin asignar) y no en las que ya están en curso; tocarlo acepta o asigna SIN abrir el chat y la fila pasa a «Trabajando»; si la
// conversación cambió, se explica con claridad y la lista se refresca; y nada se desborda en horizontal.
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
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v13s11-0123456789abcdef', verify_token: 'verify-e2e-v13s11-0123456789' } } })).status()).toBe(200);
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

type Kind = 'pending' | 'working' | 'unassigned';

/** Una empresa con un chip QR y cuatro conversaciones: dos POR ACEPTAR, una SIN ASIGNAR y una EN CURSO (la persona de la prueba es la administradora). */
async function fixture(request: APIRequestContext): Promise<string> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v13s11'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip s11' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const make = async (name: string, phone: string, status: Kind): Promise<void> => {
      const owned = status !== 'unassigned';
      const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [me.org, name, owned ? me.uid : null])).rows[0].id as string;
      await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [me.org, contact, `+${phone}`]);
      const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, ${owned ? 'now()' : 'NULL'}, now(), now(), 0, $6) RETURNING id`, [me.org, contact, qr.id, status, owned ? me.uid : null, phone])).rows[0].id as string;
      await db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola, ¿hay turno?', 'received', now())`, [me.org, conv, qr.id, `wamid.${phone}`]);
    };
    await make('Cliente Pendiente', '593984211001', 'pending');
    await make('Cliente Pendiente Dos', '593984211002', 'pending');
    await make('Cliente Sin Asignar', '593984211003', 'unassigned');
    await make('Cliente Activo', '593984211004', 'working');
  });
  return email;
}

const SIZES = [{ width: 412, height: 915 }, { width: 360, height: 800 }] as const;

for (const size of SIZES) {
  test.describe(`${size.width} × ${size.height}`, () => {
    test.use({ viewport: size });

    test('el botón aparece solo en «Esperando»: «Aceptar» en las pendientes y «Asignarme» en la sin asignar, con área táctil de 44 px y sin desborde', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/inbox');
      // en curso: ninguno
      await page.getByRole('tab', { name: /^Trabajando/ }).click();
      await expect(page.getByRole('link', { name: /Cliente Activo/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Aceptar|Asignarme)/ })).toHaveCount(0);
      // esperando
      await page.getByRole('tab', { name: /^Esperando/ }).click();
      const accept = page.getByRole('button', { name: 'Aceptar conversación con Cliente Pendiente', exact: true });
      const take = page.getByRole('button', { name: 'Asignarme la conversación con Cliente Sin Asignar' });
      await expect(accept).toBeVisible();
      await expect(take).toBeVisible();
      await expect(accept).toHaveText('Aceptar');
      await expect(take).toHaveText('Asignarme');
      const box = (await accept.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      // lo que se ve mide ~36 px de alto y está pegado al borde derecho de la fila
      const visible = (await accept.locator('span').boundingBox())!;
      expect(visible.height).toBeGreaterThanOrEqual(35);
      expect(visible.height).toBeLessThanOrEqual(37);
      expect(visible.x + visible.width).toBeLessThanOrEqual(size.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('aceptar desde la fila no abre el chat: avisa «Chat aceptado» y la conversación pasa a Trabajando', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/inbox');
      await page.getByRole('tab', { name: /^Esperando/ }).click();
      await page.getByRole('button', { name: 'Aceptar conversación con Cliente Pendiente', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Chat aceptado' })).toBeVisible();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.getByRole('link', { name: /Cliente Pendiente$/ })).toHaveCount(0);
      await page.getByRole('tab', { name: /^Trabajando/ }).click();
      await expect(page.getByRole('link', { name: /Cliente Pendiente$/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test('«Asignarme» toma la conversación sin asignar sin abrir el chat y la deja en Trabajando', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/inbox');
      await page.getByRole('tab', { name: /^Esperando/ }).click();
      await page.getByRole('button', { name: 'Asignarme la conversación con Cliente Sin Asignar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Chat asignado a ti' })).toBeVisible();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.getByRole('link', { name: /Cliente Sin Asignar/ })).toHaveCount(0);
      await page.getByRole('tab', { name: /^Trabajando/ }).click();
      await expect(page.getByRole('link', { name: /Cliente Sin Asignar/ })).toBeVisible();
    });

    test('tocar el resto de la fila sigue abriendo el chat', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/inbox');
      await page.getByRole('tab', { name: /^Esperando/ }).click();
      await page.getByRole('link', { name: /Cliente Pendiente Dos/ }).click();
      await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    });

    for (const [verb, label, name, said] of [
      ['aceptar', 'Aceptar conversación con Cliente Pendiente', 'Cliente Pendiente', 'Esta conversación ya fue aceptada por otra persona'],
      ['asignarme', 'Asignarme la conversación con Cliente Sin Asignar', 'Cliente Sin Asignar', 'Esta conversación ya fue tomada por otra persona'],
    ] as const) {
      test(`si la conversación cambió mientras tanto (${verb}), se explica con claridad y la lista se refresca`, async ({ page, request }) => {
        const email = await fixture(request);
        await uiLogin(page, email);
        await page.goto('/inbox');
        await page.getByRole('tab', { name: /^Esperando/ }).click();
        const btn = page.getByRole('button', { name: label, exact: true });
        await expect(btn).toBeVisible();
        // «otra persona» la dejó fuera de «Esperando» entre tanto
        await withDb((db) => db.query(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE contact_id IN (SELECT id FROM contacts WHERE name = $1)`, [name]));
        await btn.click();
        await expect(page.getByRole('alert').filter({ hasText: said })).toBeVisible();
        await expect(page.getByRole('link', { name: new RegExp(`${name}$`) })).toHaveCount(0);
        await expect(page).toHaveURL(/\/inbox$/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }
  });
}
