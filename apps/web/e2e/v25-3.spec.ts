// E2E de V25 · 25.3 en un navegador real (almacenamiento y WhatsApp de mentira): se elige un archivo de la biblioteca para una respuesta rápida y desde el chat sale con el texto; en móvil, sin
// desborde, con objetivos de 44 px y contraste AA.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { auditContrast } from './contrast';
import { adminToken, apiLogin, createAccount, state, uiLogin, uniqueEmail } from './support';

test.use({ viewport: { width: 1440, height: 900 } });

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 5)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 32), Buffer.from('\n%%EOF')]);

async function enableWhatsapp(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v253-0123456789abcdef', verify_token: 'verify-e2e-v253-0123456789' } } })).status()).toBe(200);
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

async function fixture(request: APIRequestContext, tag: string): Promise<{ email: string; conversationId: string; token: string }> {
  const { apiBase } = state();
  await enableWhatsapp(request);
  const email = await createAccount(request, uniqueEmail(tag));
  const token = await apiLogin(request, email);
  for (const [name, type, data] of [['foto-e2e.jpg', 'image/jpeg', JPEG], ['lista-e2e.pdf', 'application/pdf', PDF]] as const) {
    const r = await request.post(`${apiBase}/v1/library/assets`, { headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-filename': name }, data });
    expect(r.status(), await r.text()).toBe(201);
  }
  const ch = await request.post(`${apiBase}/v1/channels`, { headers: json(token), data: { name: 'Línea adjuntos', waba_id: '1234567890123', phone_number_id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, access_token: 'fake-valid-token' } });
  expect(ch.status(), await ch.text()).toBe(201);
  const channel = (await ch.json()) as { id: string };
  const conversationId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente Adjuntos', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984216666', true)`, [me.org, contact]);
    return (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593984216666') RETURNING id`, [me.org, contact, channel.id, me.uid])).rows[0].id as string;
  });
  return { email, conversationId, token };
}

async function login(page: Page, email: string): Promise<void> {
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

test('respuesta rápida con archivos: se arma desde la biblioteca y sale desde el chat con el texto como pie del primero', async ({ page, request }) => {
  const f = await fixture(request, 'v253');
  await login(page, f.email);
  await page.goto('/settings/quick-replies');
  await page.getByRole('button', { name: 'Nueva respuesta' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nueva respuesta rápida' });
  await dlg.getByRole('textbox', { name: /Atajo/ }).fill('catalogo');
  await dlg.getByRole('textbox', { name: /Mensaje/ }).fill('Hola {{primer_nombre}}, te dejo el catálogo');
  await dlg.getByRole('checkbox', { name: /Compartir con toda la empresa/ }).check();
  for (const name of ['foto-e2e.jpg', 'lista-e2e.pdf']) {
    await dlg.getByRole('button', { name: 'Elegir de la biblioteca' }).click();
    const picker = page.getByRole('dialog', { name: 'Elegir un archivo para la respuesta' });
    await picker.getByRole('button', { name: `Elegir ${name}` }).click();
    await picker.getByRole('button', { name: 'Usar este archivo' }).click();
  }
  await dlg.getByRole('button', { name: 'Crear respuesta' }).click();
  await expect(page.getByText('📎 2 archivos')).toBeVisible();

  await page.goto(`/inbox/${f.conversationId}`);
  const box = page.getByRole('textbox', { name: 'Mensaje' });
  await box.fill('/cata');
  await page.getByRole('option', { name: /catalogo/ }).click();
  await expect(box).toHaveValue('Hola Cliente, te dejo el catálogo');
  const chips = page.getByRole('list', { name: 'Archivos que se enviarán' });
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await expect(chips).not.toContainText('e2e');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(chips).toHaveCount(0);
  await expect.poll(() => withDb(async (db) => (await db.query(`SELECT kind, body, status FROM messages WHERE conversation_id = $1 AND direction = 'out' AND kind <> 'note' ORDER BY sent_at`, [f.conversationId])).rows)).toEqual([
    { kind: 'image', body: 'Hola Cliente, te dejo el catálogo', status: 'sent' },
    { kind: 'document', body: null, status: 'sent' },
  ]);
  await expect(page.getByRole('log', { name: 'Mensajes' })).not.toContainText('e2e');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`adjuntos en móvil (${scheme}): chips en una fila, sin desborde a 360, 390 y 412 px, objetivos de 44 px y contraste AA`, async ({ page, request }) => {
    const { apiBase } = state();
    const f = await fixture(request, `v253${scheme}`);
    const list = (await (await request.get(`${apiBase}/v1/library`, { headers: json(f.token) })).json()) as { items: Array<{ id: string }> };
    const r = await request.post(`${apiBase}/v1/quick-replies`, { headers: json(f.token), data: { shortcut: 'todo', body: 'Te dejo todo', shared: true, asset_ids: list.items.map((a) => a.id) } });
    expect(r.status(), await r.text()).toBe(201);
    await page.emulateMedia({ colorScheme: scheme });
    await login(page, f.email);
    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: 840 });
      await page.goto(`/inbox/${f.conversationId}`);
      const box = page.getByRole('textbox', { name: 'Mensaje' });
      await box.fill('/tod');
      await page.getByRole('option', { name: /todo/ }).click();
      const chips = page.getByRole('list', { name: 'Archivos que se enviarán' });
      await expect(chips.getByRole('listitem')).toHaveCount(2);
      // Se mide cada control: la pantalla del chat recorta lo que sobra, así que el ancho de desplazamiento no lo delataría
      const bad = await page.evaluate(() => {
        const composer = [...document.querySelectorAll('.chat-screen textarea, .chat-screen button')];
        const out = composer.filter((e) => {
          if (e.closest('ul[aria-label="Archivos que se enviarán"]')) return false; // la fila de chips se desplaza en horizontal
          const b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > window.innerWidth + 0.5 || b.left < -0.5);
        }).length;
        const row = document.querySelector('ul[aria-label="Archivos que se enviarán"]')!.getBoundingClientRect();
        const small = [...document.querySelectorAll('ul[aria-label="Archivos que se enviarán"] button')].filter((e) => { const b = e.getBoundingClientRect(); return b.width < 44 || b.height < 44; }).length;
        return { out, small, rowInside: row.left >= -0.5 && row.right <= window.innerWidth + 0.5 };
      });
      expect(bad, `${width}px`).toEqual({ out: 0, small: 0, rowInside: true });
      const { low } = await page.evaluate(auditContrast);
      expect(low, `${scheme} ${width}px`).toEqual([]);
    }
  });
}
