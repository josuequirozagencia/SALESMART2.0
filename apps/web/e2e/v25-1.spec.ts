// E2E de V25 · 25.1 en un navegador real: Configuración › Empresa. El nombre nuevo se ve en el menú sin recargar, la zona horaria pide confirmación, sin desborde en móvil y con contraste AA.
import { expect, test } from '@playwright/test';
import { auditContrast } from './contrast';
import { apiLogin, createAccount, state, uiLogin, uniqueEmail } from './support';

test.use({ viewport: { width: 1440, height: 900 } });

test('perfil de empresa: nombre en el menú sin recargar, confirmación de la zona horaria y datos de contacto', async ({ page, request }) => {
  const { apiBase } = state();
  const email = await createAccount(request, uniqueEmail('v251'));
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
  await page.goto('/settings/company');

  const identity = page.getByRole('form', { name: 'Identidad' });
  await identity.getByRole('textbox', { name: 'Nombre comercial' }).fill('Barbería E2E del Sur');
  await identity.getByRole('button', { name: 'Guardar' }).click();
  await expect(identity.getByText('Guardado')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Menú principal' }).getByText('Barbería E2E del Sur')).toBeVisible();

  const place = page.getByRole('form', { name: 'Ubicación y hora' });
  await place.getByRole('combobox', { name: 'País' }).selectOption('EC');
  await place.getByRole('combobox', { name: 'Zona horaria' }).selectOption('America/Bogota');
  await place.getByRole('button', { name: 'Guardar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cambiar la zona horaria' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cambiar zona horaria' }).click();
  await expect(place.getByText('Guardado')).toBeVisible();

  const contact = page.getByRole('form', { name: 'Datos de contacto' });
  await contact.getByRole('textbox', { name: 'Teléfono de contacto' }).fill('+593 98 765 4321');
  await contact.getByRole('textbox', { name: 'Sitio web' }).fill('https://barberia.example');
  await contact.getByRole('button', { name: 'Guardar' }).click();
  await expect(contact.getByText('Guardado')).toBeVisible();

  const token = await apiLogin(request, email);
  const saved = await (await request.get(`${apiBase}/v1/organization/profile`, { headers: { authorization: `Bearer ${token}` } })).json();
  expect(saved).toMatchObject({ name: 'Barbería E2E del Sur', country: 'EC', timezone: 'America/Bogota', contact_phone: '+593987654321', website: 'https://barberia.example' });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`perfil de empresa (${scheme}): sin desborde a 360, 390 y 412 px y contraste AA`, async ({ page, request }) => {
    const email = await createAccount(request, uniqueEmail(`v251${scheme}`));
    await page.emulateMedia({ colorScheme: scheme });
    await uiLogin(page, email);
    await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
    for (const width of [360, 390, 412, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/settings/company');
      await expect(page.getByRole('form', { name: 'Datos de contacto' })).toBeVisible();
      // Se mide cada control, no el ancho de desplazamiento: una pantalla que recorta no se delataría
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('form input, form select, form textarea, form button')].filter((e) => {
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
