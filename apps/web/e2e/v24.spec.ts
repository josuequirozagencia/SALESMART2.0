// E2E de V24 en un navegador real contra la API y la web COMPILADAS: una conversación sin departamento → «Asignar departamento» dentro de «Registrar venta» → la venta se registra.
import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin, uniqueEmail } from './support';

test.use({ viewport: { width: 1440, height: 900 } });

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function enableWhatsapp(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v24-0123456789abcdef', verify_token: 'verify-e2e-v24-0123456789' } } })).status()).toBe(200);
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

test('«Asignación»: el panel dice quién la tiene, cómo y con quién está compartida, y la ficha enlaza a la conversación', async ({ page, request }) => {
  const { apiBase } = state();
  await enableWhatsapp(request);
  const email = await createAccount(request, uniqueEmail('v24asig'));
  const adm = json(await apiLogin(request, email));
  const ch = await request.post(`${apiBase}/v1/channels`, { headers: adm, data: { name: 'Línea asignación', waba_id: '1234567890123', phone_number_id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, access_token: 'fake-valid-token' } });
  expect(ch.status(), await ch.text()).toBe(201);
  const channel = (await ch.json()) as { id: string };
  const conversationId = await withDb(async (db) => {
    const org = (await db.query(`SELECT m.organization_id AS org FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0].org as string;
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'Cliente Asignado') RETURNING id`, [org])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984219999', true)`, [org, contact]);
    return (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', now(), now(), 0, '593984219999') RETURNING id`, [org, contact, channel.id])).rows[0].id as string;
  });
  expect((await request.post(`${apiBase}/v1/conversations/${conversationId}/take`, { headers: adm })).status()).toBe(200);

  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
  await page.goto(`/inbox/${conversationId}`);
  const block = page.getByRole('region', { name: 'Asignación' });
  await expect(block.getByText(/Tomada por /)).toBeVisible();
  await expect(block.getByText('No está compartida')).toBeVisible();
  await expect(block.getByRole('list', { name: 'Historial de asignación' }).getByRole('listitem')).toHaveCount(1);
  await expect(block).not.toContainText('@');

  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Abrir el contacto Cliente Asignado' }).click();
  const ficha = page.getByRole('dialog', { name: 'Contacto' });
  await expect(ficha.getByText(/Conversación abierta: atendida por/)).toBeVisible();
  await ficha.getByRole('link', { name: 'Abrir conversación' }).click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}$`));
});

test('conversación sin departamento: se asigna desde «Registrar venta» y la venta se registra con el catálogo', async ({ page, request }) => {
  const { apiBase } = state();
  await enableWhatsapp(request);
  const email = await createAccount(request, uniqueEmail('v24'));
  const adm = json(await apiLogin(request, email));
  const queue = (await (await request.post(`${apiBase}/v1/queues`, { headers: adm, data: { name: 'Ventas' } })).json()) as { id: string };
  expect((await request.post(`${apiBase}/v1/queues/${queue.id}/products`, { headers: adm, data: { name: 'Corte E2E', price: '12.50' } })).status()).toBe(201);
  // La conexión NO tiene departamento: es el caso en que solo se arregla asignándolo a la conversación
  const ch = await request.post(`${apiBase}/v1/channels`, { headers: adm, data: { name: 'Línea sin departamento', waba_id: '1234567890123', phone_number_id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, access_token: 'fake-valid-token' } });
  expect(ch.status(), await ch.text()).toBe(201);
  const channel = (await ch.json()) as { id: string };
  const conversationId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente sin departamento', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984218888', true)`, [me.org, contact]);
    return (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593984218888') RETURNING id`, [me.org, contact, channel.id, me.uid])).rows[0].id as string;
  });

  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
  await page.goto(`/inbox/${conversationId}`);
  await page.getByRole('group', { name: 'Acciones de la conversación' }).getByRole('button', { name: 'Registrar venta' }).click();
  const sale = page.getByRole('dialog', { name: 'Registrar venta' });
  await expect(sale.getByText(/no pertenece a ningún departamento/)).toBeVisible();
  await sale.getByRole('button', { name: 'Asignar departamento' }).click();
  const pick = page.getByRole('dialog', { name: 'Asignar departamento' });
  await pick.getByRole('combobox', { name: 'Departamento' }).selectOption({ label: 'Ventas' });
  await pick.getByRole('button', { name: 'Guardar' }).click();
  // Quien la tiene no es del departamento: se avisa y, al aceptar, se vuelve al formulario
  await expect(pick.getByText(/no pertenece a ese departamento/)).toBeVisible();
  await pick.getByRole('button', { name: 'Entendido' }).click();
  await sale.getByRole('combobox', { name: 'Producto o servicio' }).selectOption({ index: 1 });
  await sale.getByRole('button', { name: 'Registrar venta' }).click();
  await expect(page.getByRole('dialog', { name: 'Venta registrada' })).toBeVisible();
  await withDb(async (db) => {
    expect((await db.query('SELECT queue_id FROM conversations WHERE id = $1', [conversationId])).rows[0].queue_id).toBe(queue.id);
    expect((await db.query('SELECT queue_id FROM sales WHERE conversation_id = $1', [conversationId])).rows[0].queue_id).toBe(queue.id);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND field = 'queue_id' AND source = 'manual'`, [conversationId])).rows[0].n).toBe(1);
  });
});
