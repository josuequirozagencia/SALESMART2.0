// E2E de v19 (B1/B2) en un navegador real contra la API y la web COMPILADAS: Configuración › Conexiones trae «Salud de las conexiones» y, dentro, lo que ve ESTE navegador del tiempo real. El socket
// real contra la API compilada tiene que quedar «En vivo» (es la medición que faltaba: antes no había forma de saber si el tiempo real llegaba a la pantalla). Y a 1440, 412 y 360 px nada se desborda.
import { expect, test } from '@playwright/test';
import { createAccount, uiLogin as login, uniqueEmail } from './support';

for (const size of [{ width: 1440, height: 900 }, { width: 412, height: 915 }, { width: 360, height: 800 }] as const) {
  test.describe(`salud de las conexiones ${size.width} × ${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: 'reduce' });

    test('el panel aparece, el tiempo real queda «En vivo» con el servidor real y la pantalla no se desborda', async ({ page, request }) => {
      const email = await createAccount(request, uniqueEmail('v19'));
      await login(page, email);
      await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
      await page.goto('/settings/connections');
      const section = page.getByRole('region', { name: 'Salud de las conexiones' });
      await expect(section).toBeVisible();
      await expect(section.getByText(/Cuando conectes un número aparecerá aquí/)).toBeVisible();
      const rt = section.getByRole('region', { name: 'Tiempo real en tu navegador' });
      await expect(rt).toBeVisible();
      // el socket real contra la API compilada: conecta y queda en vivo
      await expect(rt.getByText('En vivo', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(rt.getByText('Avisos recibidos en esta sesión')).toBeVisible();
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
