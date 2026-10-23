import { describe, expect, it } from 'vitest';
import { ACCEPTED_MIMES, baseMime, checkUpload, inlineAllowed, kindOfInbound, MAX_BYTES, MAX_UPLOAD_BYTES, outboundKind, safeFilename, sniff, storageKey } from '../../src/modules/attachments/attachment-rules';

const MB = 1024 * 1024;
const b = (...bytes: number[]): Buffer => Buffer.from(bytes);
const ascii = (s: string, pad = 0): Buffer => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(pad)]);
/** Contenido mínimo que cada firma reconoce. */
const SAMPLE = {
  jpeg: b(0xff, 0xd8, 0xff, 0xe0, 0, 0x10),
  png: Buffer.concat([b(0x89), ascii('PNG\r\n'), b(0x1a, 0x0a)]),
  webp: Buffer.concat([ascii('RIFF'), b(1, 0, 0, 0), ascii('WEBP')]),
  gif: ascii('GIF89a'),
  pdf: ascii('%PDF-1.4\n'),
  mp4: Buffer.concat([b(0, 0, 0, 0x18), ascii('ftypmp42')]),
  ogg: ascii('OggS', 8),
  mp3Id3: ascii('ID3', 8),
  mp3Frame: b(0xff, 0xfb, 0x90, 0x00),
  aac: b(0xff, 0xf1, 0x50, 0x80),
  amr: ascii('#!AMR\n'),
  webm: b(0x1a, 0x45, 0xdf, 0xa3, 0, 0),
  zip: b(0x50, 0x4b, 0x03, 0x04, 0, 0),
  ole: b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1),
  text: Buffer.from('Hola, esto es texto plano\n', 'utf8'),
};

describe('baseMime y outboundKind', () => {
  it('baseMime quita parámetros y mayúsculas; sin valor es vacío', () => {
    expect(baseMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(baseMime('  IMAGE/JPEG ')).toBe('image/jpeg');
    expect(baseMime(undefined)).toBe('');
  });
  it('outboundKind clasifica solo los tipos aceptados', () => {
    expect(outboundKind('image/png')).toBe('image');
    expect(outboundKind('video/3gpp')).toBe('video');
    expect(outboundKind('audio/webm')).toBe('audio');
    expect(outboundKind('application/pdf')).toBe('document');
    for (const no of ['image/gif', 'image/webp', 'application/zip', 'text/html', 'application/x-msdownload', '']) expect(outboundKind(no), no).toBeNull();
    expect(ACCEPTED_MIMES).toContain('image/jpeg');
    expect(ACCEPTED_MIMES).not.toContain('text/html');
  });
});

describe('sniff · reconoce el contenido real por sus primeros bytes', () => {
  it.each(Object.entries(SAMPLE))('%s', (name, bytes) => {
    const expected: Record<string, string> = { mp3Id3: 'mp3', mp3Frame: 'mp3' };
    expect(sniff(bytes)).toBe(expected[name] ?? name);
  });
  it('lo muy corto, o binario que no se conoce, no se reconoce', () => {
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(b(1, 2, 3))).toBeNull();
    expect(sniff(b(0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0))).toBeNull(); // un ejecutable ELF (tiene bytes nulos)
    expect(sniff(Buffer.alloc(64))).toBeNull();
  });
  it('un archivo con el tamaño justo de una firma (4 bytes) todavía se reconoce', () => {
    expect(sniff(ascii('%PDF'))).toBe('pdf');
  });
});

describe('checkUpload', () => {
  it('acepta cada tipo con su contenido', () => {
    const cases: Array<[string, Buffer, string]> = [
      ['image/jpeg', SAMPLE.jpeg, 'image'],
      ['image/png', SAMPLE.png, 'image'],
      ['video/mp4', SAMPLE.mp4, 'video'],
      ['video/3gpp', SAMPLE.mp4, 'video'],
      ['audio/ogg', SAMPLE.ogg, 'audio'],
      ['audio/mpeg', SAMPLE.mp3Id3, 'audio'],
      ['audio/mpeg', SAMPLE.mp3Frame, 'audio'],
      ['audio/mp4', SAMPLE.mp4, 'audio'],
      ['audio/aac', SAMPLE.aac, 'audio'],
      ['audio/amr', SAMPLE.amr, 'audio'],
      ['audio/webm', SAMPLE.webm, 'audio'],
      ['application/pdf', SAMPLE.pdf, 'document'],
      ['application/msword', SAMPLE.ole, 'document'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', SAMPLE.zip, 'document'],
      ['text/plain', SAMPLE.text, 'document'],
    ];
    for (const [mime, bytes, kind] of cases) expect(checkUpload(mime, bytes), mime).toEqual({ ok: true, mime, kind });
  });

  it('rechaza un tipo que no se envía (415 en la API) aunque el contenido sea válido', () => {
    for (const mime of ['image/gif', 'image/webp', 'application/zip', 'text/html', 'image/svg+xml', '']) {
      const r = checkUpload(mime, SAMPLE.jpeg);
      expect(r, mime).toMatchObject({ ok: false, code: 'unsupported_type' });
    }
  });

  it('rechaza lo vacío', () => {
    expect(checkUpload('image/png', Buffer.alloc(0))).toMatchObject({ ok: false, code: 'empty' });
  });

  it('rechaza lo que pesa más que el tope de su tipo y acepta justo el tope', () => {
    const big = (head: Buffer, size: number): Buffer => Buffer.concat([head, Buffer.alloc(size - head.length)]);
    expect(checkUpload('image/jpeg', big(SAMPLE.jpeg, MAX_BYTES.image))).toMatchObject({ ok: true });
    expect(checkUpload('image/jpeg', big(SAMPLE.jpeg, MAX_BYTES.image + 1))).toMatchObject({ ok: false, code: 'too_large' });
    expect(checkUpload('video/mp4', big(SAMPLE.mp4, MAX_BYTES.video + 1))).toMatchObject({ ok: false, code: 'too_large' });
    expect(checkUpload('application/pdf', big(SAMPLE.pdf, MAX_BYTES.document + 1))).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('rechaza un contenido que no corresponde a su tipo declarado (un .png que es otra cosa)', () => {
    expect(checkUpload('image/png', SAMPLE.jpeg)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(checkUpload('image/jpeg', SAMPLE.zip)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(checkUpload('application/pdf', SAMPLE.text)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(checkUpload('text/plain', SAMPLE.pdf)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(checkUpload('image/jpeg', b(0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0))).toMatchObject({ ok: false, code: 'type_mismatch' });
    // un Word moderno (zip) no se hace pasar por el antiguo (OLE) ni al revés
    expect(checkUpload('application/msword', SAMPLE.zip)).toMatchObject({ ok: false, code: 'type_mismatch' });
    expect(checkUpload('application/vnd.openxmlformats-officedocument.wordprocessingml.document', SAMPLE.ole)).toMatchObject({ ok: false, code: 'type_mismatch' });
  });

  it('los mensajes de rechazo hablan en claro (sin rutas ni detalles internos)', () => {
    const r = checkUpload('image/png', SAMPLE.jpeg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no corresponde/i);
  });
});

describe('topes', () => {
  it('el tope de la subida es el del tipo más grande', () => {
    expect(MAX_UPLOAD_BYTES).toBe(Math.max(...Object.values(MAX_BYTES)));
    expect(MAX_BYTES.document).toBe(25 * MB);
    expect(MAX_BYTES.image).toBe(5 * MB);
  });
});

describe('safeFilename', () => {
  it('quita rutas, caracteres de control y de sistema de archivos', () => {
    expect(safeFilename('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(safeFilename('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(safeFilename('../../etc/passwd').startsWith('.')).toBe(false);
    expect(safeFilename('.env')).toBe('env');
    expect(safeFilename('a\u0000b\u0007c.pdf')).toBe('abc.pdf');
    expect(safeFilename('re<po>rt:"x"|y?*.pdf')).toBe('re_po_rt__x__y__.pdf');
  });
  it('decodifica lo que manda el navegador en X-Filename y tolera una codificación rota', () => {
    expect(safeFilename(encodeURIComponent('lista de precios ñandú.pdf'))).toBe('lista de precios ñandú.pdf');
    expect(safeFilename('%E0%A4%A')).toBe('%E0%A4%A');
  });
  it('acota el largo conservando la extensión', () => {
    const long = `${'x'.repeat(300)}.pdf`;
    const out = safeFilename(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  it('sin nombre usa el de reserva', () => {
    expect(safeFilename(null)).toBe('archivo');
    expect(safeFilename(undefined)).toBe('archivo');
    expect(safeFilename('   ')).toBe('archivo');
    expect(safeFilename('...')).toBe('archivo');
    expect(safeFilename('', 'audio.ogg')).toBe('audio.ogg');
  });
});

describe('storageKey, inlineAllowed y kindOfInbound', () => {
  it('la clave siempre cuelga de la organización y nunca usa el nombre del archivo', () => {
    expect(storageKey('0190a000-0000-7000-8000-000000000001', 'abc')).toBe('org/0190a000-0000-7000-8000-000000000001/attachments/abc');
  });
  it('solo se muestran en la página imágenes, audio y video de tipos conocidos; un documento o un tipo raro, nunca', () => {
    expect(inlineAllowed('image', 'image/jpeg')).toBe(true);
    expect(inlineAllowed('image', 'image/webp')).toBe(true);
    expect(inlineAllowed('audio', 'audio/ogg')).toBe(true);
    expect(inlineAllowed('video', 'video/mp4')).toBe(true);
    expect(inlineAllowed('document', 'application/pdf')).toBe(false);
    expect(inlineAllowed('document', 'text/html')).toBe(false);
    expect(inlineAllowed('image', 'image/svg+xml')).toBe(false); // un SVG puede llevar scripts
    expect(inlineAllowed('video', 'video/x-matroska')).toBe(false);
    expect(inlineAllowed('image', 'text/html')).toBe(false);
  });
  it('kindOfInbound solo reconoce los mensajes que traen archivo', () => {
    for (const k of ['image', 'video', 'audio', 'document', 'sticker'] as const) expect(kindOfInbound(k)).toBe(k);
    for (const k of ['text', 'location', 'contacts', 'interactive', 'button', 'unsupported', '']) expect(kindOfInbound(k), k).toBeNull();
  });
});
