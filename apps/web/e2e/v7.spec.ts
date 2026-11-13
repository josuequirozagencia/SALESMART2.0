// E2E del v7 (ADR-65) en un navegador real contra la API y la web COMPILADAS: el departamento elige sus conexiones, la conexión QR cambia de departamento y la venta se celebra.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin as login, uniqueEmail } from './support';

/** Entra por la interfaz y espera a que la sesión esté lista (si se navega antes, el inicio de sesión en curso se pierde). */
async function uiLogin(page: Page, email: string): Promise<void> {
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

// El panel de datos del contacto necesita ancho (en una ventana angosta el botón se desactiva)
test.use({ viewport: { width: 1440, height: 900 } });

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** Los proveedores de la plataforma (solo el Súper Admin): WhatsApp oficial (sin él no se puede conectar un número) y Evolution (QR) de mentira, con su URL y su clave. */
async function enableQr(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v7-0123456789abcdef', verify_token: 'verify-e2e-v7-0123456789' } } })).status()).toBe(200);
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
const queueOf = (db: pg.Client, id: string): Promise<string | null> => db.query('SELECT queue_id FROM channel_accounts WHERE id = $1', [id]).then((r) => r.rows[0].queue_id as string | null);

test('departamentos y conexiones: asignar una oficial y una QR desde el departamento, quitar con destino y cambiar el departamento de la QR desde su tarjeta; otra empresa no ve nada', async ({ page, request }) => {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v7conn'));
  const other = await createAccount(request, uniqueEmail('v7conn-b'));
  const adm = json(await apiLogin(request, email));
  const ventas = (await (await request.post(`${apiBase}/v1/queues`, { headers: adm, data: { name: 'Ventas' } })).json()) as { id: string };
  const soporte = (await (await request.post(`${apiBase}/v1/queues`, { headers: adm, data: { name: 'Soporte' } })).json()) as { id: string };
  const o = await request.post(`${apiBase}/v1/channels`, { headers: adm, data: { name: 'Línea E2E', waba_id: '1234567890123', phone_number_id: '1090123450191', access_token: 'fake-valid-token' } });
  expect(o.status(), await o.text()).toBe(201);
  const official = (await o.json()) as { id: string };
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip E2E', queue_id: soporte.id } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  expect(official.id && qr.id).toBeTruthy();

  await uiLogin(page, email);
  await page.goto('/departments');
  await page.getByRole('button', { name: 'Configurar Ventas' }).click();
  const dlg = page.getByRole('dialog', { name: 'Configurar Ventas' });
  const sec = dlg.getByRole('region', { name: 'Conexiones del departamento' });

  // 1) Activa la oficial (sin departamento) y la QR (está en Soporte: avisa que se mueve) y guarda
  await expect(sec.getByText('Está en Soporte')).toBeVisible();
  await sec.getByRole('switch', { name: 'Usar «Línea E2E» en este departamento' }).check();
  await sec.getByRole('switch', { name: 'Usar «Chip E2E» en este departamento' }).check();
  await expect(sec.getByText('Está en Soporte · al usarla aquí se mueve')).toBeVisible();
  await expect(sec.getByText(/Las conversaciones que ya existen siguen en el departamento que tenían/)).toBeVisible();
  await sec.getByRole('button', { name: 'Guardar conexiones' }).click();
  await expect(sec.getByText('Conexiones guardadas.')).toBeVisible();
  await withDb(async (db) => {
    expect(await queueOf(db, official.id)).toBe(ventas.id);
    expect(await queueOf(db, qr.id)).toBe(ventas.id);
    // una auditoría por conexión que cambió
    const a = (await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'channel' AND field = 'queue_id' AND entity_id = ANY($1::uuid[])`, [[official.id, qr.id]])).rows[0].n as number;
    expect(a).toBeGreaterThanOrEqual(2); // la oficial y la QR cambiaron de departamento
  });

  // 2) Quita la oficial: pide el destino (obligatorio) y la manda a Soporte
  await sec.getByRole('switch', { name: 'Usar «Línea E2E» en este departamento' }).uncheck();
  await sec.getByRole('button', { name: 'Guardar conexiones' }).click();
  const ask = sec.getByRole('group', { name: 'Destino de las conexiones que quitas' });
  await expect(ask.getByRole('button', { name: 'Confirmar y guardar' })).toBeDisabled();
  await ask.getByRole('combobox', { name: 'Departamento de destino' }).selectOption({ label: 'Soporte' });
  await expect(ask.getByText(/Las conversaciones nuevas de Línea E2E irán a Soporte/)).toBeVisible();
  await ask.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await expect(sec.getByText('Conexiones guardadas.')).toBeVisible();
  await withDb(async (db) => expect(await queueOf(db, official.id)).toBe(soporte.id));
  await dlg.getByRole('button', { name: 'Cerrar' }).click();

  // 3) Fase C: la tarjeta QR permite cambiar su departamento (aquí de vuelta a Soporte), con el aviso
  await page.goto('/settings/connections');
  const card = page.getByRole('region', { name: 'WhatsApp por QR' }).getByRole('listitem', { name: 'Chip E2E' });
  await card.getByRole('button', { name: 'Cambiar departamento de Chip E2E' }).click();
  await card.getByRole('combobox', { name: /Departamento de/ }).selectOption({ label: 'Soporte' });
  await expect(card.getByText(/Las conversaciones nuevas de este número irán al departamento elegido/)).toBeVisible();
  await card.getByRole('button', { name: 'Guardar' }).click();
  await expect(card.getByRole('definition').filter({ hasText: 'Soporte' })).toBeVisible();
  await withDb(async (db) => expect(await queueOf(db, qr.id)).toBe(soporte.id));

  // 4) Otra empresa no ve estas conexiones ni departamentos, y no puede tocarlos por la API
  const otherHdr = json(await apiLogin(request, other));
  const mine = (await (await request.get(`${apiBase}/v1/queues`, { headers: otherHdr })).json()) as { items: Array<{ name: string }> };
  expect(mine.items.map((q) => q.name)).not.toEqual(expect.arrayContaining(['Ventas']));
  expect(mine.items.some((q) => q.name === 'Ventas' || q.name === 'Soporte')).toBe(false);
  expect((await request.put(`${apiBase}/v1/queues/${ventas.id}/connections`, { headers: otherHdr, data: { connections: [{ kind: 'channel', id: official.id }], move_removed_to: null } })).status()).toBe(404);
  await withDb(async (db) => expect(await queueOf(db, official.id)).toBe(soporte.id));
});

/** Cuenta lo que el navegador intenta sonar: sustituye `AudioContext` por uno que solo cuenta osciladores iniciados (no se oye nada, se verifica la llamada). */
async function spyAudio(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __tones: number; AudioContext: unknown };
    w.__tones = 0;
    class FakeAudio {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume() { return Promise.resolve(); }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 }, connect() {} }; }
      createOscillator() { return { type: 'sine', frequency: { value: 0 }, connect() {}, start() { w.__tones += 1; }, stop() {} }; }
    }
    w.AudioContext = FakeAudio;
  });
  return () => page.evaluate(() => (window as unknown as { __tones: number }).__tones);
}

/** Una empresa con una conversación asignada a su administrador y un producto en el catálogo del departamento (la conversación se crea directo: ya hay E2E del flujo por el webhook). */
async function saleFixture(request: APIRequestContext): Promise<{ email: string; conversationId: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v7sale'));
  const adm = json(await apiLogin(request, email));
  const queue = (await (await request.post(`${apiBase}/v1/queues`, { headers: adm, data: { name: 'Ventas' } })).json()) as { id: string };
  expect((await request.post(`${apiBase}/v1/queues/${queue.id}/products`, { headers: adm, data: { name: 'Corte E2E', price: '12.50' } })).status()).toBe(201);
  const ch = await request.post(`${apiBase}/v1/channels`, { headers: adm, data: { name: 'Línea venta', waba_id: '1234567890123', phone_number_id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, access_token: 'fake-valid-token', queue_id: queue.id } });
  expect(ch.status(), await ch.text()).toBe(201);
  const channel = (await ch.json()) as { id: string };
  const conversationId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Celebra', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984217777', true)`, [me.org, contact]);
    return (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, queue_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'working', $5, now(), now(), now(), 1, '593984217777') RETURNING id`, [me.org, contact, channel.id, queue.id, me.uid])).rows[0].id as string;
  });
  return { email, conversationId };
}

async function registerSale(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/inbox/${conversationId}`);
  // La columna del contacto se abre sola en una ventana ancha; si no, se abre con su botón
  const toggle = page.getByRole('button', { name: 'Datos del contacto', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'Registrar venta' }).first().click();
  const d = page.getByRole('dialog', { name: 'Registrar venta' });
  await d.getByLabel('Producto o servicio').selectOption({ index: 1 });
  await d.getByRole('button', { name: 'Registrar venta' }).click();
}

test('celebrar la venta: suena la caja registradora y cae el confeti solo a quien la registra; apagado no hay nada; con «reducir movimiento» no hay confeti', async ({ page, request }) => {
  const tones = await spyAudio(page);
  const { email, conversationId } = await saleFixture(request);
  await uiLogin(page, email);

  // 1) Por omisión: sonido y confeti, y el mensaje «Venta registrada» sigue visible (anunciado)
  await registerSale(page, conversationId);
  await expect(page.getByText(/Venta de .* registrada/)).toBeVisible();
  await expect(page.getByTestId('confetti')).toBeVisible();
  expect(await tones()).toBeGreaterThanOrEqual(5); // tres golpes y la campanilla (dos parciales)
  // el confeti no intercepta clics y se limpia al cerrar el diálogo
  expect(await page.getByTestId('confetti').evaluate((c) => getComputedStyle(c).pointerEvents)).toBe('none');
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page.getByTestId('confetti')).toHaveCount(0);
});

test('celebrar la venta: con la preferencia apagada no hay confeti ni sonido; con «reducir movimiento» no hay confeti y el sonido sigue', async ({ page, request }) => {
  const tones = await spyAudio(page);
  const { email, conversationId } = await saleFixture(request);
  await uiLogin(page, email);

  // Apagada en Configuración › Notificaciones
  await page.goto('/settings/notifications');
  await page.getByRole('switch', { name: 'Celebrar las ventas' }).uncheck();
  await registerSale(page, conversationId);
  await expect(page.getByText(/Venta de .* registrada/)).toBeVisible();
  await expect(page.getByTestId('confetti')).toHaveCount(0);
  expect(await tones()).toBe(0);

  // Encendida otra vez, pero con «reducir movimiento» en el sistema: sin confeti, con sonido (otra venta en otra conversación)
  const second = await saleFixture(request);
  await page.goto('/settings/notifications');
  await page.getByRole('switch', { name: 'Celebrar las ventas' }).check();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.context().clearCookies();
  await uiLogin(page, second.email);
  await page.goto('/settings/notifications');
  await expect(page.getByRole('switch', { name: 'Celebrar las ventas' })).toBeChecked();
  await registerSale(page, second.conversationId);
  await expect(page.getByText(/Venta de .* registrada/)).toBeVisible();
  await expect(page.getByTestId('confetti')).toHaveCount(0);
  expect(await tones()).toBeGreaterThanOrEqual(5);
});
