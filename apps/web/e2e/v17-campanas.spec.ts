// E2E de v17 · 17.2 «Campañas masivas» en un navegador real contra la API y la web COMPILADAS: el administrador arma una campaña por WhatsApp QR en la pantalla de una sola página (cinco secciones),
// desmarca a un destinatario, comprueba que quien pidió la baja no se puede marcar, guarda el borrador, lo ve en la tabla y lo vuelve a abrir con lo desmarcado intacto. Y a 412 × 915 (Samsung
// Galaxy Note 20) y 360 de ancho nada se desborda en horizontal.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { adminToken, apiLogin, createAccount, state, uiLogin as login, uniqueEmail } from './support';

const json = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function enableQr(request: APIRequestContext): Promise<void> {
  const { apiBase } = state();
  const root = json(await adminToken(request));
  expect((await request.put(`${apiBase}/v1/platform/providers/whatsapp_official/meta_cloud/credentials`, { headers: root, data: { values: { app_id: '1234567890', app_secret: 'app-secret-e2e-v17c-0123456789abcdef', verify_token: 'verify-e2e-v17c-0123456789' } } })).status()).toBe(200);
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

/** Una empresa con un chip QR y tres contactos del administrador: Ana y Beto (consentimiento dado) y uno que pidió la baja. */
async function fixture(request: APIRequestContext): Promise<string> {
  const { apiBase } = state();
  await enableQr(request);
  const email = await createAccount(request, uniqueEmail('v17c'));
  const adm = json(await apiLogin(request, email));
  const q = await request.post(`${apiBase}/v1/qr-channels`, { headers: adm, data: { name: 'Chip campañas' } });
  expect(q.status(), await q.text()).toBe(201);
  await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const make = async (name: string, phone: string, consent: string): Promise<void> => {
      const c = (await db.query(`INSERT INTO contacts(id, organization_id, name, owner_id, consent) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [me.org, name, me.uid, consent])).rows[0].id as string;
      await db.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [me.org, c, phone]);
    };
    await make('Ana Lema', '+593988210001', 'granted');
    await make('Beto Vera', '+593988210002', 'granted');
    await make('Pidió Baja', '+593988210003', 'revoked');
  });
  return email;
}

async function uiLogin(page: Page, email: string): Promise<void> {
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
}

test.describe('escritorio 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

  test('el administrador arma una campaña por QR, desmarca a alguien, la guarda como borrador y la edita con lo desmarcado intacto', async ({ page, request }) => {
    const email = await fixture(request);
    await uiLogin(page, email);
    // el menú trae la sección en «Comunicación»
    await page.goto('/campaigns');
    await expect(page.getByRole('heading', { level: 1, name: 'Campañas masivas' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Campañas masivas' })).toBeVisible();

    const form = page.getByRole('form', { name: 'Nueva campaña' });
    await expect(form.getByText('WhatsApp QR · no oficial')).toBeVisible();
    await expect(form.getByText(/Conexión no oficial/)).toBeVisible();
    await form.getByLabel(/1 · Nombre/).fill('Cupos de octubre');

    // destinatarios: la baja no se puede marcar; se desmarca a Beto
    const group = form.getByRole('group', { name: 'Destinatarios' });
    await expect(group.getByRole('checkbox', { name: 'Pidió Baja: No contactar' })).toBeDisabled();
    await expect(form.getByText(/1 excluidos por «no contactar»/)).toBeVisible();
    await group.getByRole('checkbox', { name: 'Beto Vera: Recibirá el mensaje' }).uncheck();
    await expect(group.getByRole('checkbox', { name: 'Beto Vera: Desmarcado' })).not.toBeChecked();

    // mensaje con variable y vista previa con un contacto real; pausa mínima de 45 s
    await expect(form.getByLabel(/Pausa entre mensajes/)).toHaveAttribute('min', '45');
    const msg = form.getByRole('textbox', { name: 'Mensaje' });
    await msg.fill('Hola {{primer_nombre}}, tenemos cupos para esta semana.');
    await expect(form.getByText('Hola Ana, tenemos cupos para esta semana.')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Enviar campaña (próximamente)' })).toBeDisabled();

    await form.getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Campaña «Cupos de octubre» guardada como borrador' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table.getByText('Cupos de octubre')).toBeVisible();
    await expect(table.getByText('Borrador').first()).toBeVisible();
    await expect(table.getByText('Chip campañas · texto libre')).toBeVisible();

    // sobrevive a recargar, y al editar sigue desmarcado Beto
    await page.reload();
    await page.getByRole('button', { name: 'Editar Cupos de octubre' }).click();
    const edit = page.getByRole('form', { name: 'Editar campaña' });
    await expect(edit.getByLabel(/1 · Nombre/)).toHaveValue('Cupos de octubre');
    await expect(edit.getByRole('group', { name: 'Destinatarios' }).getByRole('checkbox', { name: 'Beto Vera: Desmarcado' })).not.toBeChecked();
    await expect(edit.getByRole('group', { name: 'Destinatarios' }).getByRole('checkbox', { name: 'Ana Lema: Recibirá el mensaje' })).toBeChecked();
    await edit.getByLabel(/1 · Nombre/).fill('Cupos de octubre (v2)');
    await edit.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('table').getByText('Cupos de octubre (v2)')).toBeVisible();
    // duplicar abre la copia para editarla
    await page.getByRole('button', { name: 'Duplicar Cupos de octubre (v2)' }).click();
    await expect(page.getByRole('form', { name: 'Editar campaña' }).getByLabel(/1 · Nombre/)).toHaveValue('Cupos de octubre (v2) (copia)');
  });
});

for (const size of [{ width: 412, height: 915 }, { width: 360, height: 800 }] as const) {
  test.describe(`${size.width} × ${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'reduce' });

    test('la pantalla no se desborda en horizontal y el formulario cabe entero (el botón de guardar se ve)', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/campaigns');
      const form = page.getByRole('form', { name: 'Nueva campaña' });
      await expect(form).toBeVisible();
      await form.getByLabel(/1 · Nombre/).fill('Móvil');
      await expect(form.getByRole('group', { name: 'Destinatarios' }).getByRole('checkbox', { name: 'Ana Lema: Recibirá el mensaje' })).toBeVisible();
      const save = form.getByRole('button', { name: 'Guardar borrador' });
      await save.scrollIntoViewIfNeeded();
      const box = (await save.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      // ningún elemento de la pantalla asoma por la derecha (la tabla se desplaza por dentro de su propia caja) y la página no se desplaza en horizontal
      const over = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll('main *'))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > window.innerWidth + 0.5 && !el.closest('.sr-only, [class*="overflow-x-auto"]')) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} → ${Math.round(r.right)}`);
        }
        return bad.slice(0, 6);
      });
      expect(over).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}
