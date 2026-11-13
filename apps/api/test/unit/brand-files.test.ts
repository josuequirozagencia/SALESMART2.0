import { describe, expect, it } from 'vitest';
import { applyBrand } from '../../src/http';
import { checkName } from '../../src/modules/platform';

describe('checkName: el nombre de la plataforma', () => {
  it('acepta de 2 a 40 caracteres, colapsa espacios y deja el nombre corto opcional', () => {
    expect(checkName('  Mi   Marca ', null)).toEqual({ ok: true, name: 'Mi Marca', shortName: null });
    expect(checkName('AB', 'A')).toEqual({ ok: true, name: 'AB', shortName: 'A' });
    expect(checkName('x'.repeat(40), 'x'.repeat(12))).toMatchObject({ ok: true });
  });
  it('vacío o nulo vuelve al valor por defecto', () => {
    expect(checkName(null, null)).toEqual({ ok: true, name: null, shortName: null });
    expect(checkName('   ', '  ')).toEqual({ ok: true, name: null, shortName: null });
  });
  it('rechaza muy corto o largo, HTML, caracteres de control, nombre corto largo y nombre corto sin nombre', () => {
    for (const [n, s] of [['A', null], ['x'.repeat(41), null], ['<b>Marca</b>', null], ['Mar\u0000ca', null], ['Ok', 'x'.repeat(13)], ['Ok', '<i>'], [null, 'Corto']] as const) {
      expect(checkName(n, s).ok, `${n} / ${s}`).toBe(false);
    }
  });
});

describe('applyBrand: el nombre y los enlaces del icono se escriben en el HTML', () => {
  const html = '<head>\n    <title>Sales Smart 2.0</title>\n    <link rel="icon" href="/v1/branding/favicon" />\n    <!--brand-head-->\n  </head>';
  it('cambia el título, escapa el nombre y agrega el manifest y el icono de instalación con su versión', () => {
    const out = applyBrand(html, { name: 'Marca & "Co" <x>', version: 'abc-123' });
    expect(out).toContain('<title>Marca &amp; &quot;Co&quot; &lt;x&gt;</title>');
    expect(out).not.toContain('<x>');
    expect(out).toContain('href="/v1/branding/manifest.webmanifest?v=abc-123"');
    expect(out).toContain('href="/v1/branding/apple-touch-icon.png?v=abc-123"');
    expect(out).toContain('<meta name="application-name" content="Marca &amp; &quot;Co&quot; &lt;x&gt;" />');
    expect(out).not.toContain('<!--brand-head-->');
  });
  it('un nombre con intento de cerrar el título no puede inyectar etiquetas', () => {
    const out = applyBrand(html, { name: '</title><script>alert(1)</script>', version: 'v1' });
    expect(out).not.toMatch(/<script>/i);
    expect(out.match(/<title>/g)).toHaveLength(1);
  });
  it('escribe los datos de la marca como un bloque JSON de datos que el nombre no puede cerrar', () => {
    const out = applyBrand(html, { name: '</script><b>&amp;', version: 'v1', short_name: 'Corto', logo: { light: '/v1/branding/logo-light?v=a', dark: null }, sound: '/v1/branding/sound?v=s1', icon: { custom: true, icon_192: '/v1/branding/icon-192.png?v=v1', badge_96: '/v1/branding/badge-96.png?v=v1' } });
    const m = /<script id="brand-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/[<>&]/); // nada que cierre la etiqueta ni abra otra
    expect(JSON.parse(m![1]!)).toEqual({ name: '</script><b>&amp;', short_name: 'Corto', version: 'v1', logo: { light: '/v1/branding/logo-light?v=a', dark: null }, sound: '/v1/branding/sound?v=s1', icon: { custom: true, icon_192: '/v1/branding/icon-192.png?v=v1', badge_96: '/v1/branding/badge-96.png?v=v1' } });
    expect(out.match(/<script/g)).toHaveLength(1);
  });
  it('sin logos ni icono el bloque lleva los valores vacíos', () => {
    const m = /<script id="brand-data" type="application\/json">([\s\S]*?)<\/script>/.exec(applyBrand(html, { name: 'M', version: 'v' }));
    expect(JSON.parse(m![1]!)).toEqual({ name: 'M', short_name: null, version: 'v', logo: { light: null, dark: null }, sound: null, icon: null });
  });
  it('la versión se codifica para la dirección', () => {
    expect(applyBrand(html, { name: 'M', version: 'a b&c' })).toContain('?v=a%20b%26c');
  });
  it('sin las marcas esperadas en el HTML lo devuelve igual', () => {
    expect(applyBrand('<html></html>', { name: 'M', version: 'v' })).toBe('<html></html>');
  });
});
