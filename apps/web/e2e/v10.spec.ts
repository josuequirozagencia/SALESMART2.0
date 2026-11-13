// E2E del v10 (Inbox móvil) en un navegador real contra la API y la web COMPILADAS, a 360 × 740 y a 428 × 926: la etiqueta «QR», las etiquetas de la lista en UNA línea, «No leídas» fuera de la barra de
// pestañas (y dentro del panel de filtros), el botón «Reanudar agente» en la cabecera sin banner, el panel de contacto que abre el nombre y el ⋮, y las áreas táctiles de 44 × 44 px.
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
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v10-0123456789abcdef', verify_token: 'verify-e2e-v10-0123456789' } } })).status()).toBe(200);
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

/** Una empresa con un chip QR, un agente de IA PAUSADO por una persona y una conversación con las etiquetas Lead y Venta, un mensaje del cliente, una respuesta de la plataforma y otra escrita desde el teléfono. */
async function fixture(request: APIRequestContext): Promise<{ email: string; conversationId: string }> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v10'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip v10' } });
  expect(q.status(), await q.text()).toBe(201);
  const qr = (await q.json()) as { id: string };
  const a = await request.post(`${apiBase}/v1/agents`, { headers: adm, data: { name: 'MAR_IA' } });
  expect(a.status(), await a.text()).toBe(201);
  const agent = (await a.json()) as { id: string };
  expect((await request.put(`${apiBase}/v1/agents/${agent.id}/channels`, { headers: adm, data: { channel_ids: [qr.id] } })).status()).toBe(200);
  const on = await request.patch(`${apiBase}/v1/agents/${agent.id}`, { headers: adm, data: { personality: 'Atiende con amabilidad las dudas de los clientes.', active: true } });
  expect(on.status(), await on.text()).toBe(200);
  const conversationId = await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const contact = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'Cliente V10', $2) RETURNING id`, [me.org, me.uid])).rows[0].id as string;
    await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, '+593984219999', true)`, [me.org, contact]);
    for (const [key, name, color] of [['lead', 'Lead', '#2563eb'], ['sale', 'Venta', '#d97706']] as const) {
      await db.query(`INSERT INTO tags(id, organization_id, name, color, is_system, system_key) VALUES (gen_random_uuid(), $1, $2, $3, true, $4) ON CONFLICT DO NOTHING`, [me.org, name, color, key]);
      await db.query(`INSERT INTO contact_tags(organization_id, contact_id, tag_id, set_by) SELECT $1, $2, id, 'system' FROM tags WHERE organization_id = $1 AND system_key = $3 ON CONFLICT DO NOTHING`, [me.org, contact, key]);
    }
    const conv = (await db.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, now(), now(), now(), 0, '593984219999') RETURNING id`, [me.org, contact, qr.id, me.uid])).rows[0].id as string;
    const ins = (ext: string, dir: 'in' | 'out', sender: string, body: string, status: string, ago: number, createdBy: string | null, meta: string) =>
      db.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at, created_by, meta) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'text', $7, $8, now() - make_interval(mins => $9), $10, $11::jsonb)`, [me.org, conv, qr.id, ext, dir, sender, body, status, ago, createdBy, meta]);
    await ins('wamid.V10A', 'in', 'contact', 'Hola, ¿hay turno?', 'received', 6, null, '{}');
    await ins('wamid.V10B', 'out', 'human', 'Respuesta desde la plataforma', 'sent', 4, me.uid, '{}');
    await ins('wamid.V10C', 'out', 'human', 'Te confirmo desde el celular', 'sent', 2, null, '{"origin":"device"}');
    await db.query(`INSERT INTO ai_conversation_state(organization_id, conversation_id, agent_id, status, reason) VALUES ($1, $2, $3, 'paused', 'human_message')`, [me.org, conv, agent.id]);
    return conv;
  });
  return { email, conversationId };
}

const SIZES = [{ width: 360, height: 740 }, { width: 428, height: 926 }] as const;

for (const size of SIZES) {
  test.describe(`${size.width} × ${size.height}`, () => {
    test.use({ viewport: size });

    test('lista: «QR» en una sola línea con Lead y Venta, «No leídas» fuera de la barra y dentro del panel de filtros', async ({ page, request }) => {
      const { email } = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/inbox');
      const row = page.getByRole('link', { name: /Cliente V10/ });
      await expect(row).toBeVisible();

      // Las etiquetas (QR, Lead, Venta) caben en UNA línea: la fila mide menos de 24 px y todas empiezan a la misma altura
      const marks = ['QR', 'Lead', 'Venta'].map((t) => row.getByText(t, { exact: true }));
      for (const m of marks) await expect(m).toBeVisible();
      const line = marks[0]!.locator('xpath=..');
      expect((await line.boundingBox())!.height).toBeLessThan(24);
      const tops = await Promise.all(marks.map(async (m) => Math.round((await m.boundingBox())!.y)));
      expect(new Set(tops).size).toBe(1);
      await expect(page.getByText(/no oficial/i)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // La barra de pestañas queda con tres pestañas; «No leídas» vive en el panel de filtros, como acceso rápido
      await expect(page.getByRole('tab')).toHaveCount(3);
      await expect(page.getByRole('button', { name: /^No leídas/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Filtros' }).click();
      const sheet = page.getByRole('dialog', { name: 'Filtros' });
      const quick = sheet.getByRole('group', { name: 'Accesos rápidos' });
      await expect(quick.getByRole('button', { name: /^No leídas/ })).toBeVisible();
      await expect(quick.getByRole('button', { name: 'Recientes' })).toBeVisible();
      await expect(quick.getByRole('button', { name: 'Destacadas' })).toBeEnabled();
    });

    test('chat: interruptor de IA en la cabecera (apagado) y sin banner; el nombre y el ⋮ abren el panel; áreas táctiles de 44 px; sin correos y con icono de teléfono', async ({ page, request }) => {
      const { email, conversationId } = await fixture(request);
      await uiLogin(page, email);
      await page.goto(`/inbox/${conversationId}`);
      const chat = page.getByRole('region', { name: 'Conversación con Cliente V10' });
      const resume = chat.getByRole('switch', { name: 'Agente de IA' });
      await expect(resume).toBeVisible();
      await expect(resume).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByRole('status', { name: 'Agente de IA' })).toHaveCount(0);
      await expect(page.getByText(/Pausado: una persona intervino/)).toHaveCount(0);
      // v13 S1.2: el canal va como texto del subtítulo («+593… · QR»); el chip «QR» salió de la cabecera
      await expect(chat.getByRole('button', { name: 'Ver los datos de Cliente V10' })).toContainText('· QR');
      await expect(page.getByText(/no oficial/i)).toHaveCount(0);

      // Áreas táctiles de al menos 44 × 44 px
      const name = chat.getByRole('button', { name: 'Ver los datos de Cliente V10' });
      const more = chat.getByRole('button', { name: 'Más acciones' });
      for (const [label, el] of [['nombre', name], ['⋮', more], ['interruptor de IA', resume]] as const) {
        const box = (await el.boundingBox())!;
        expect(box.height, `${label}: alto`).toBeGreaterThanOrEqual(43.5);
        expect(box.width, `${label}: ancho`).toBeGreaterThanOrEqual(43.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // El correo de quien atiende no aparece en la bandeja; el mensaje del teléfono lleva icono de teléfono (no «?») y su etiqueta
      await expect(chat.getByText('Te confirmo desde el celular')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(email);
      await expect(chat.getByText(/Desde el teléfono/)).toBeVisible();
      await expect(page.locator('span[title="Desde el teléfono"] svg')).toHaveCount(1);
      await expect(chat.getByText('?', { exact: true })).toHaveCount(0);

      // El nombre abre el panel de contacto: con el texto de pausa, tarjetas y la X de 44 px; la X cierra
      await name.click();
      const dlg = page.getByRole('dialog', { name: 'Datos del contacto' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('status', { name: 'Agente de IA' })).toContainText('Pausado: una persona intervino. Puedes reanudarlo.');
      for (const n of ['Agendar', 'Editar', 'Ir a notas', 'Ir a tareas', 'Transferir o compartir', 'Mensajes programados']) await expect(dlg.getByRole('button', { name: n })).toBeVisible();
      const x = dlg.getByRole('button', { name: 'Cerrar los datos del contacto' });
      const xb = (await x.boundingBox())!;
      expect(xb.width).toBeGreaterThanOrEqual(43.5);
      expect(xb.height).toBeGreaterThanOrEqual(43.5);
      await x.click();
      await expect(dlg).toHaveCount(0);

      // El ⋮ abre el MISMO panel; Esc lo cierra
      await more.click();
      await expect(page.getByRole('dialog', { name: 'Datos del contacto' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Acciones de la conversación' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Datos del contacto' })).toHaveCount(0);

      // Destacar (v10b): la tarjeta del panel pone MI estrella; la lista la muestra y el filtro «Destacadas» la encuentra
      await more.click();
      await page.getByRole('dialog', { name: 'Datos del contacto' }).getByRole('button', { name: 'Destacar', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Datos del contacto' }).getByRole('button', { name: 'Quitar de destacadas' })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.goto('/inbox');
      await expect(page.getByRole('link', { name: /Cliente V10, destacada/ })).toBeVisible();
      await page.getByRole('button', { name: 'Filtros' }).click();
      await page.getByRole('dialog', { name: 'Filtros' }).getByRole('button', { name: 'Destacadas' }).click();
      await page.getByRole('dialog', { name: 'Filtros' }).getByRole('button', { name: 'Ver conversaciones' }).click();
      await expect(page.getByRole('link', { name: /Cliente V10/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Filtros (1 activos)' })).toBeVisible();
    });
  });
}
