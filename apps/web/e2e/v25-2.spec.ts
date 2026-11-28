// E2E de V25 · 25.2 en un navegador real: «Mi perfil» desde el menú, el aviso de nombre, el cambio de contraseña, sin desborde en móvil y con contraste AA.
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { auditContrast } from './contrast';
import { createAccount, PASSWORD, state, uiLogin, uniqueEmail } from './support';

test.use({ viewport: { width: 1440, height: 900 } });

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: state().adminDbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

test('mi perfil: el aviso lleva a completar el nombre, se ve en el menú sin recargar y la contraseña cambia', async ({ page, request }) => {
  const email = await createAccount(request, uniqueEmail('v252'));
  await withDb((db) => db.query('UPDATE users SET full_name = NULL WHERE email = $1', [email]));
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
  const menu = page.getByRole('complementary', { name: 'Menú principal' });
  await menu.getByRole('link', { name: /Completa tu nombre/ }).click();
  await expect(page.getByRole('heading', { name: 'Mi perfil' })).toBeVisible();

  const data = page.getByRole('form', { name: 'Mis datos' });
  await data.getByRole('textbox', { name: 'Nombre completo' }).fill('Persona Completa E2E');
  await data.getByRole('textbox', { name: 'Teléfono' }).fill('+593 98 765 0001');
  await data.getByRole('button', { name: 'Guardar' }).click();
  await expect(data.getByText('Guardado')).toBeVisible();
  await expect(menu.getByText('Persona Completa E2E')).toBeVisible();
  await expect(page.getByRole('link', { name: /Completa tu nombre/ })).toHaveCount(0);

  const pwd = page.getByRole('form', { name: 'Cambiar contraseña' });
  const next = 'Otra-Clave-E2E-2026';
  await pwd.getByLabel('Contraseña actual').fill('equivocada-1234');
  await pwd.getByLabel('Contraseña nueva', { exact: true }).fill(next);
  await pwd.getByLabel('Repite la contraseña nueva').fill(next);
  await pwd.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(pwd.getByText('La contraseña actual no es correcta')).toBeVisible();
  await pwd.getByLabel('Contraseña actual').fill(PASSWORD);
  await pwd.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(pwd.getByText('Contraseña cambiada')).toBeVisible();

  await menu.getByRole('button', { name: 'Cerrar sesión' }).click();
  await uiLogin(page, email, next);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`mi perfil (${scheme}): sin desborde a 360, 390 y 412 px, contraste AA y acceso desde el menú móvil`, async ({ page, request }) => {
    const email = await createAccount(request, uniqueEmail(`v252${scheme}`));
    await page.emulateMedia({ colorScheme: scheme });
    await uiLogin(page, email);
    await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/menu');
    await page.getByRole('link', { name: 'Mi perfil', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Mi perfil' })).toBeVisible();
    for (const width of [360, 390, 412, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('form', { name: 'Cambiar contraseña' })).toBeVisible();
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('form input, form button, section a')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
        }).length,
      );
      expect(out, `${width}px`).toBe(0);
      const { low, examined } = await page.evaluate(auditContrast);
      expect(examined).toBeGreaterThan(10);
      expect(low, `${scheme} ${width}px`).toEqual([]);
    }
  });
}
