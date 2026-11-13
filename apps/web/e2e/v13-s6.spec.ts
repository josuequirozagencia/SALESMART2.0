// E2E del v13 · S6 (alineación visual con el prototipo) en un navegador real contra la API y la web COMPILADAS: la barra lateral con los valores del prototipo (icono de 16 px, texto de 12,5 px,
// botón de 6 × 10 px), sin desborde horizontal a 320 px en las pantallas que se tocaron, y contraste AA de esas pantallas en los tres temas de color, claro y oscuro.
import { expect, test } from '@playwright/test';
import { auditContrast } from './contrast';
import { createAccount, uiLogin, uniqueEmail } from './support';

const SCREENS = ['/departments', '/settings/quick-replies', '/users', '/forms', '/agents', '/automations', '/contacts', '/opportunities', '/tasks', '/agenda', '/sales', '/settings/fields'];

test.describe('escritorio 1440 × 900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('la barra lateral usa los valores del prototipo: icono de 16 px, texto de 12,5 px y botón compacto', async ({ page, request }) => {
    const email = await createAccount(request, uniqueEmail('v13s6side'));
    // «Cómodo»: con el «Compacto» de escritorio (por omisión, v11) la escala baja 3 px con piso de 10 px y el texto mediría 10 px; aquí se mide el valor del prototipo
    await page.addInitScript(() => window.localStorage.setItem('ss.textsize.v1', 'comfortable'));
    await uiLogin(page, email);
    await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
    const nav = page.getByRole('navigation', { name: /Secciones/ });
    const links = nav.getByRole('link');
    expect(await links.count()).toBeGreaterThan(5);
    const m = await links.first().evaluate((a) => {
      const s = getComputedStyle(a);
      const icon = a.querySelector('svg')!.getBoundingClientRect();
      return { size: s.fontSize, top: s.paddingTop, left: s.paddingLeft, height: a.getBoundingClientRect().height, icon: [Math.round(icon.width), Math.round(icon.height)] };
    });
    expect(['12.5px', '13px']).toContain(m.size); // la escala tipográfica central (11–13 px) redondea el 12,5 del prototipo a 13 px en «Cómodo»
    expect(m.top).toBe('6px');
    expect(m.left).toBe('10px');
    expect(m.icon).toEqual([16, 16]);
    expect(m.height).toBeLessThan(36); // antes 40 px
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`contraste AA de las pantallas alineadas en los tres temas de color (${scheme})`, async ({ page, request }) => {
      const email = await createAccount(request, uniqueEmail(`v13s6${scheme}`));
      await page.addInitScript((mode) => window.localStorage.setItem('ss.theme.v1', mode), scheme);
      await uiLogin(page, email);
      await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
      const failures: string[] = [];
      for (const brand of ['indigo', 'green', 'red'] as const) {
        for (const path of ['/departments', '/settings/quick-replies', '/users']) {
          await page.goto(path);
          await expect(page.getByRole('main')).toBeVisible();
          await page.evaluate((b) => { if (b === 'indigo') delete document.documentElement.dataset['brand']; else document.documentElement.dataset['brand'] = b; }, brand);
          const { low, examined } = await page.evaluate(auditContrast);
          expect(examined, `textos examinados en ${path}`).toBeGreaterThan(0);
          for (const l of low) failures.push(`${brand}/${scheme} ${path}: «${l.text}» ${l.ratio}:1 (mín. ${l.needed}) [${l.classes}]`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

for (const width of [320, 360]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 740 } });

    test(`sin desborde horizontal en las pantallas alineadas a ${width} px`, async ({ page, request }) => {
      const email = await createAccount(request, uniqueEmail(`v13s6w${width}`));
      await uiLogin(page, email);
      await expect(page.getByRole('heading', { name: /Hola, / })).toBeVisible();
      for (const path of SCREENS) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, `${path} a ${width} px`).toBeLessThanOrEqual(0);
      }
    });
  });
}
