import { describe, expect, it } from 'vitest';
import { checkFavicon, FAVICON_MAX_BYTES } from '../../src/modules/platform/branding/favicon-image';
import { ico, png, SVG, webpExtended, webpLossless, webpLossy } from '../support/favicon-images';

describe('validación del favicon por su contenido', () => {
  it('acepta PNG, ICO y WebP (con pérdida, sin pérdida y extendido) cuadrados de 32 a 512 px y dice su tamaño', () => {
    expect(checkFavicon(png(32, 32))).toEqual({ ok: true, contentType: 'image/png', px: 32 });
    expect(checkFavicon(png(512, 512))).toEqual({ ok: true, contentType: 'image/png', px: 512 });
    expect(checkFavicon(ico([32, 32]))).toEqual({ ok: true, contentType: 'image/x-icon', px: 32 });
    expect(checkFavicon(ico([32, 32], [48, 48], [256, 256]))).toEqual({ ok: true, contentType: 'image/x-icon', px: 256 });
    expect(checkFavicon(webpLossy(64, 64))).toEqual({ ok: true, contentType: 'image/webp', px: 64 });
    expect(checkFavicon(webpLossless(128, 128))).toEqual({ ok: true, contentType: 'image/webp', px: 128 });
    expect(checkFavicon(webpExtended(256, 256))).toEqual({ ok: true, contentType: 'image/webp', px: 256 });
  });

  it('rechaza SVG, texto y cualquier formato que no sea PNG, ICO o WebP, aunque se disfrace', () => {
    for (const b of [SVG, Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.from('GIF89a' + 'x'.repeat(40)), Buffer.from('%PDF-1.4 ' + 'x'.repeat(40)), Buffer.from('hola, esto no es una imagen')]) {
      const r = checkFavicon(b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('UNSUPPORTED');
    }
  });

  it('rechaza lo que no es cuadrado y lo que mide menos de 32 o más de 512 px', () => {
    for (const b of [png(64, 32), ico([32, 16]), webpLossy(48, 64)]) {
      const r = checkFavicon(b);
      expect(r.ok ? 'ok' : r.code).toBe('NOT_SQUARE');
    }
    for (const b of [png(31, 31), png(16, 16), png(513, 513), png(1024, 1024), ico([16, 16]), webpLossless(600, 600)]) {
      const r = checkFavicon(b);
      expect(r.ok ? 'ok' : r.code).toBe('BAD_SIZE');
    }
  });

  it('rechaza archivos vacíos, demasiado pesados (más de 256 KB) y cabeceras dañadas', () => {
    expect(checkFavicon(Buffer.alloc(0))).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(checkFavicon(png(64, 64, FAVICON_MAX_BYTES + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(checkFavicon(png(64, 64, FAVICON_MAX_BYTES))).toMatchObject({ ok: true }); // justo en el tope
    const noIhdr = png(64, 64);
    noIhdr.write('IDAT', 12, 'latin1');
    expect(checkFavicon(noIhdr)).toMatchObject({ ok: false, code: 'CORRUPT' });
    expect(checkFavicon(png(64, 64).subarray(0, 20))).toMatchObject({ ok: false, code: 'CORRUPT' });
    const badIco = ico([32, 32]);
    badIco.writeUInt32LE(9999, 6 + 12); // la imagen empezaría fuera del archivo
    expect(checkFavicon(badIco)).toMatchObject({ ok: false, code: 'CORRUPT' });
    const badWebp = webpLossy(64, 64);
    badWebp[23] = 0;
    expect(checkFavicon(badWebp)).toMatchObject({ ok: false, code: 'CORRUPT' });
  });

  it('el tipo lo decide el contenido: un PNG con cualquier nombre sigue siendo PNG', () => {
    expect(checkFavicon(png(48, 48))).toMatchObject({ contentType: 'image/png' });
  });
});
