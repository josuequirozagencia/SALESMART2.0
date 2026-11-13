// E2E del v13 · S2 (Inbox de escritorio) en un navegador real contra la API y la web COMPILADAS: las acciones de la conversación son iconos de la cabecera (y el «⋮» aparece SOLO cuando no caben),
// el reloj de «programados» ya no está en la cabecera, y un mensaje programado se ve dentro del chat con «Enviar ahora» (en una conversación de WhatsApp por QR, sin ventana de 24 h).
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

/** Una empresa con un chip QR y una conversación EN CURSO del administrador. */
async function fixture(request: APIRequestContext): Promise<{ email: string; convId: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v13s2'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip v13s2' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  const convId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const phone = '593984220001';
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Escritorio', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [me.org, contact, `+${phone}`]);
    const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now() - interval '3 days', 0, $5) RETURNING id`, [me.org, contact, qr.id, me.uid, phone])).rows[0].id as string;
    await db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola, ¿hay turno?', 'received', now() - interval '3 days')`, [me.org, conv, qr.id, `wamid.${phone}`]);
    return conv;
  });
  return { email, convId };
}

test.describe('escritorio 1920 × 1080', () => {
  // 1920 de ancho: con el panel de contacto abierto la columna del chat mide ~1090 px y todas las acciones caben (a 1440 el chat queda cerca de su mínimo y es CORRECTO que algunas pasen al «⋮»)
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('las acciones son iconos con nombre y ayuda, sin botón «Más»; sin el reloj de programados ni la barra del agente', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Escritorio' });
    const bar = chat.getByRole('group', { name: 'Acciones de la conversación' });
    for (const name of ['Registrar venta', 'Agendar', 'Transferir o compartir', 'Finalizar']) {
      const b = bar.getByRole('button', { name });
      await expect(b).toBeVisible();
      await expect(b).toHaveAttribute('title', name);
      expect((await b.boundingBox())!.width).toBeGreaterThanOrEqual(43.5);
    }
    await expect(chat.getByRole('button', { name: 'Más acciones' })).toHaveCount(0);
    await expect(chat.getByRole('button', { name: /^Mensajes programados/ })).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Agente de IA' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // «Programar» es solo el reloj del redactor
    await expect(chat.getByRole('button', { name: 'Programar mensaje' })).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Programar', exact: true })).toHaveCount(0);
  });

  test('un mensaje programado se ve dentro del chat y «Enviar ahora» lo manda al instante', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Escritorio' });
    const box = chat.getByRole('textbox', { name: 'Mensaje' });
    await box.fill('Te escribo más tarde');
    await chat.getByRole('button', { name: 'Programar mensaje' }).click();
    const dlg = page.getByRole('dialog', { name: 'Programar mensaje' });
    await dlg.getByRole('button', { name: 'En 1 hora' }).click();
    await dlg.getByRole('button', { name: 'Programar', exact: true }).click();
    const pending = chat.getByRole('list', { name: 'Mensajes programados de esta conversación' });
    await expect(pending.getByText(/Mensaje programado · /)).toBeVisible();
    await expect(pending.getByText('Te escribo más tarde')).toBeVisible();
    const log = chat.getByRole('log', { name: 'Mensajes' });
    // los programados se ven DENTRO del registro del chat, pero en su propia lista: la de los mensajes del hilo es la que no lleva nombre
    const thread = log.locator('ul:not([aria-label])');
    await expect(thread.getByText('Te escribo más tarde')).toHaveCount(0); // todavía no es un mensaje del hilo
    await pending.getByRole('button', { name: /^Enviar ahora/ }).click();
    await expect(pending).toHaveCount(0);
    await expect(thread.getByText('Te escribo más tarde')).toBeVisible({ timeout: 30_000 });
    const rows = await withDb(async (db) => (await db.query(`SELECT status FROM scheduled_messages WHERE conversation_id = $1`, [convId])).rows as Array<{ status: string }>);
    expect(rows).toEqual([{ status: 'sent' }]);
  });
});

test.describe('cabecera estrecha', () => {
  // 1920 de ancho: con el panel de contacto abierto la columna del chat mide ~1090 px y todas las acciones caben (a 1440 el chat queda cerca de su mínimo y es CORRECTO que algunas pasen al «⋮»)
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('si las acciones no caben, aparece UN «⋮ Más acciones» con las que sobran; al ensanchar la cabecera desaparece', async ({ page, request }) => {
    const { email, convId } = await fixture(request);
    await uiLogin(page, email);
    await page.goto(`/inbox/${convId}`);
    const chat = page.getByRole('region', { name: 'Conversación con Cliente Escritorio' });
    const icons = chat.getByRole('group', { name: 'Acciones de la conversación' }).getByRole('button');
    await expect(icons.first()).toBeVisible();
    const all = await icons.count(); // los que tiene esta persona (el administrador, también «Eliminar conversación»)
    expect(all).toBeGreaterThanOrEqual(4);
    await expect(chat.getByRole('button', { name: 'Más acciones' })).toHaveCount(0);
    // se estrecha la columna del chat (el ancho de la ventana depende del diseño; así la prueba no depende de él): el ResizeObserver de la cabecera debe reaccionar
    // (con el DOM, no con una etiqueta de estilo: la política de contenido de la aplicación no permite estilos en línea inyectados)
    const resizeChat = (width: number) => page.evaluate((w) => { const el = document.querySelector<HTMLElement>('section[aria-label^="Conversación con"]')!; el.style.flex = 'none'; el.style.width = `${w}px`; }, width);
    await resizeChat(440);
    const more = chat.getByRole('button', { name: 'Más acciones' });
    await expect(more).toBeVisible();
    await more.click();
    const menu = page.getByRole('menu', { name: 'Más acciones' });
    await expect(menu.getByRole('menuitem').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    // al ensanchar todo cabe y el «⋮» desaparece
    await resizeChat(1000);
    await expect(chat.getByRole('button', { name: 'Más acciones' })).toHaveCount(0);
    await expect(chat.getByRole('group', { name: 'Acciones de la conversación' }).getByRole('button')).toHaveCount(all);
  });
});
