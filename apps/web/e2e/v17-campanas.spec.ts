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

/** Una campaña ya terminada, con destinatarios en distintos estados (lo que dejaría el envío real), para ver el informe sin enviar nada de verdad. */
async function seedFinishedCampaign(email: string): Promise<void> {
  await withDb(async (db) => {
    const me = (await db.query(`SELECT m.organization_id AS org, u.id AS uid FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.role = 'client_admin'`, [email])).rows[0] as { org: string; uid: string };
    const ch = (await db.query(`SELECT id FROM channel_accounts WHERE organization_id = $1 AND provider = 'evolution' LIMIT 1`, [me.org])).rows[0].id as string;
    const camp = (await db.query(
      `INSERT INTO campaigns(id, organization_id, name, channel_account_id, mode, body, audience, status, gap_seconds, daily_cap, created_by, idempotency_key, launched_at, finished_at)
       VALUES (gen_random_uuid(), $1, 'Cupos de noviembre', $2, 'text', 'Hola {{primer_nombre}}', '{"source":"all"}', 'completed', 60, 50, $3, $4, now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
      [me.org, ch, me.uid, `e2e-175-${Date.now()}`],
    )).rows[0].id as string;
    const rows: Array<[string, string, string, string | null, string | null]> = [
      ['Ana Lema', 'replied', '+593988210001', null, 'now() - interval \'30 minutes\''],
      ['Beto Vera', 'delivered', '+593988210002', null, null],
      ['Pidió Baja', 'skipped', '+593988210003', 'revoked', null],
    ];
    for (const [name, status, phone, reason, replied] of rows) {
      const c = (await db.query(`SELECT id FROM contacts WHERE organization_id = $1 AND name = $2`, [me.org, name])).rows[0].id as string;
      await db.query(
        `INSERT INTO campaign_recipients(id, organization_id, campaign_id, contact_id, phone, status, skip_reason, sent_at, replied_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, ${status === 'skipped' ? 'NULL' : "now() - interval '90 minutes'"}, ${replied ?? 'NULL'})`,
        [me.org, camp, c, phone, status, reason],
      );
    }
  });
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
    await expect(form.getByRole('button', { name: 'Enviar campaña' })).toBeEnabled();

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

test.describe('envío por QR 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

  test('el aviso de riesgo es obligatorio y, con la sesión sin conectar, el envío se explica sin perder el borrador', async ({ page, request }) => {
    const email = await fixture(request);
    await uiLogin(page, email);
    await page.goto('/campaigns');
    const form = page.getByRole('form', { name: 'Nueva campaña' });
    await form.getByLabel(/1 · Nombre/).fill('Envío por QR');
    await form.getByRole('textbox', { name: 'Mensaje' }).fill('Hola {{primer_nombre}}, tenemos cupos esta semana.');
    await form.getByRole('button', { name: 'Enviar campaña' }).click();
    const dlg = page.getByRole('dialog', { name: 'Enviar campaña' });
    await expect(dlg.getByText(/Conexión no oficial/)).toBeVisible();
    const confirm = dlg.getByRole('button', { name: 'Confirmar y enviar' });
    await expect(confirm).toBeDisabled(); // sin aceptar el aviso no se puede
    await dlg.getByRole('checkbox', { name: /Entiendo el riesgo/ }).check();
    await confirm.click();
    // el chip de la prueba no tiene la sesión conectada: se explica y la campaña sigue como borrador
    await expect(dlg.getByRole('alert')).toContainText('La sesión de WhatsApp por QR no está conectada');
    await dlg.getByRole('button', { name: 'Volver' }).click();
    await expect(page.getByRole('table').getByText('Envío por QR')).toBeVisible();
    await expect(page.getByRole('table').getByText('Borrador').first()).toBeVisible();
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

test.describe('resultados y Analítica 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });

  test('el informe de una campaña terminada muestra totales, tasas y cada destinatario; el CSV se descarga con BOM; la tarjeta de Analítica la cuenta', async ({ page, request }) => {
    const email = await fixture(request);
    await seedFinishedCampaign(email);
    await uiLogin(page, email);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Resultados de Cupos de noviembre' }).click();
    const dlg = page.getByRole('dialog', { name: 'Cupos de noviembre' });
    await expect(dlg.getByRole('list', { name: 'Tasas y omitidos' }).getByText('Entrega 100 %')).toBeVisible();
    await expect(dlg.getByRole('list', { name: 'Tasas y omitidos' }).getByText('Respuesta 50 %')).toBeVisible();
    const table = dlg.getByRole('table');
    await expect(table.getByText('Ana Lema')).toBeVisible();
    await expect(table.locator('tr', { hasText: 'Ana Lema' }).getByText('Respondió')).toBeVisible();
    await expect(table.locator('tr', { hasText: 'Beto Vera' }).getByText('Entregado')).toBeVisible();
    await expect(table.locator('tr', { hasText: 'Pidió Baja' }).getByText('No contactar')).toBeVisible();
    // el CSV: nombre del servidor y BOM al principio
    const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Descargar CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^campana-cupos-de-noviembre-\d{4}-\d{2}-\d{2}\.csv$/);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('Ana Lema');
    await dlg.getByRole('button', { name: 'Cerrar' }).first().click();
    // Analítica: la campaña lanzada en el periodo cuenta en la tarjeta
    await page.goto('/analytics');
    const card = page.getByRole('region', { name: 'Campañas del periodo' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Campañas', { exact: true }).locator('xpath=following-sibling::b')).toHaveText('1');
    await expect(card.getByText('Respuesta 50 %')).toBeVisible();
  });
});

test.describe('resultados 360 × 800', () => {
  test.use({ viewport: { width: 360, height: 800 }, reducedMotion: 'reduce' });

  test('el informe cabe en la pantalla sin desbordar', async ({ page, request }) => {
    const email = await fixture(request);
    await seedFinishedCampaign(email);
    await uiLogin(page, email);
    await page.goto('/campaigns');
    await page.getByRole('button', { name: 'Resultados de Cupos de noviembre' }).click();
    const dlg = page.getByRole('dialog', { name: 'Cupos de noviembre' });
    await expect(dlg.getByText('Ana Lema')).toBeVisible();
    const box = (await dlg.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360 + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

for (const size of [{ width: 1440, height: 900 }, { width: 412, height: 915 }, { width: 360, height: 800 }] as const) {
  test.describe(`versiones del mensaje ${size.width} × ${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'reduce' });

    test('por QR se ve la sección de versiones, se escribe una a mano, y sin IA configurada se explica; nada se desborda', async ({ page, request }) => {
      const email = await fixture(request);
      await uiLogin(page, email);
      await page.goto('/campaigns');
      const form = page.getByRole('form', { name: 'Nueva campaña' });
      const section = form.getByRole('region', { name: 'Versiones del mensaje' });
      await expect(section).toBeVisible();
      await expect(section.getByText(/Escríbelo una vez. La IA crea versiones distintas/)).toBeVisible();
      await section.getByRole('button', { name: '+ Escribir versión' }).click();
      const area = section.getByRole('textbox', { name: 'Versión 2' });
      await area.fill('Qué tal {{primer_nombre}}, hay cupos esta semana.');
      await expect(section.getByText('Cada contacto recibirá una de las 2 versiones (la principal y una más).')).toBeVisible();
      // la plataforma de pruebas no tiene IA configurada: el motivo se muestra en la propia sección y lo escrito no se pierde
      await section.getByRole('button', { name: 'Generar versiones' }).click();
      await expect(section.getByRole('alert')).toBeVisible();
      await expect(area).toHaveValue('Qué tal {{primer_nombre}}, hay cupos esta semana.');
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
