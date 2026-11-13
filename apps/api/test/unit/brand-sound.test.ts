import { describe, expect, it } from 'vitest';
import { checkSound, looksLikeM4a, looksLikeMp3, SOUND_MAX_BYTES } from '../../src/modules/platform';

/** Cuadro MPEG-1 capa III, 128 kbps, 44,1 kHz (FF FB 90 64) de 417 bytes. */
const frame = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
/** Etiqueta ID3v2.4 con `n` bytes de cuerpo (enteros «syncsafe»). */
const id3 = (n: number): Buffer => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, (n >> 7) & 0x7f, n & 0x7f]), Buffer.alloc(n)]);
const box = (type: string, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + b.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, b]);
};
const m4a = (handler: string, brand = 'M4A '): Buffer =>
  Buffer.concat([box('ftyp', Buffer.from(brand, 'latin1'), Buffer.alloc(4)), box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12))))), box('mdat', Buffer.alloc(64))]);

describe('checkSound: el sonido se valida por su contenido', () => {
  it('acepta un MP3 con o sin etiqueta ID3 (con relleno) y un M4A de audio', () => {
    expect(checkSound(frame())).toEqual({ ok: true, contentType: 'audio/mpeg' });
    expect(checkSound(Buffer.concat([id3(40), frame()]))).toEqual({ ok: true, contentType: 'audio/mpeg' });
    expect(checkSound(Buffer.concat([id3(40), Buffer.alloc(300), frame()]))).toEqual({ ok: true, contentType: 'audio/mpeg' });
    expect(checkSound(m4a('soun'))).toEqual({ ok: true, contentType: 'audio/mp4' });
    expect(checkSound(m4a('soun', 'mp42'))).toEqual({ ok: true, contentType: 'audio/mp4' });
  });

  it('rechaza vacío, más de 200 KB y todo lo que no sea MP3 o M4A, aunque se llame sonido.mp3', () => {
    expect(checkSound(Buffer.alloc(0))).toMatchObject({ ok: false, status: 400, code: 'SOUND_EMPTY' });
    expect(checkSound(Buffer.alloc(SOUND_MAX_BYTES + 1, 0xff))).toMatchObject({ ok: false, status: 413, code: 'SOUND_TOO_LARGE' });
    for (const [name, b] of [
      ['texto', Buffer.from('sonido.mp3')],
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
      ['WAV', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)])],
      ['sincronía sin versión (reservada)', Buffer.concat([Buffer.from([0xff, 0xe9, 0x90, 0x64]), Buffer.alloc(400)])],
      ['capa I', Buffer.concat([Buffer.from([0xff, 0xff, 0x90, 0x64]), Buffer.alloc(400)])],
      ['tasa de bits inválida', Buffer.concat([Buffer.from([0xff, 0xfb, 0xf0, 0x64]), Buffer.alloc(400)])],
      ['frecuencia reservada', Buffer.concat([Buffer.from([0xff, 0xfb, 0x9c, 0x64]), Buffer.alloc(400)])],
      ['MP4 de video', m4a('vide', 'isom')],
      ['MP4 sin audio', m4a('text')],
      ['marca desconocida', m4a('soun', 'qt  ')],
    ] as const) {
      expect(checkSound(b), name).toMatchObject({ ok: false, status: 400, code: 'SOUND_FORMAT_INVALID' });
    }
  });

  it('el MP3 no se confunde: una etiqueta ID3 mal formada o sin cuadro después no vale; sin etiqueta el cuadro va al principio', () => {
    const bad = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x80, 0, 0, 0]), frame()]); // tamaño con el bit alto: no es «syncsafe»
    expect(looksLikeMp3(bad)).toBe(false);
    expect(looksLikeMp3(id3(20))).toBe(false);
    expect(looksLikeMp3(Buffer.concat([Buffer.alloc(8), frame()]))).toBe(false);
    expect(looksLikeMp3(Buffer.alloc(3))).toBe(false);
  });

  it('el M4A exige una caja ftyp consistente', () => {
    expect(looksLikeM4a(Buffer.from('ftyp'))).toBe(false);
    const big = m4a('soun');
    big.writeUInt32BE(big.length + 10, 0); // tamaño de ftyp mayor que el archivo
    expect(looksLikeM4a(big)).toBe(false);
  });

  it('un cuadro MP3 truncado al final no rompe nada', () => {
    expect(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90]))).toBe(false);
    expect(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe(true);
  });
});
