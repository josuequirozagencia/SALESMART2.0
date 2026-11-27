import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, prepareImage, targetSize, type ImageDeps } from '../src/lib/imagePrep';

const MB = 1024 * 1024;
const file = (name: string, type: string, size: number): File => new File([new Uint8Array(size)], name, { type });
const deps = (over: Partial<ImageDeps> & { out?: number; w?: number; h?: number } = {}): ImageDeps & { encode: ReturnType<typeof vi.fn> } => ({
  decode: over.decode ?? (() => Promise.resolve({ width: over.w ?? 4000, height: over.h ?? 3000, close: () => undefined })),
  encode: vi.fn(over.encode ?? (() => Promise.resolve(new Blob([new Uint8Array(over.out ?? 400_000)], { type: 'image/jpeg' })))),
});

describe('tamaño de reducción', () => {
  it('el lado mayor queda en 1600 px, con la proporción; una imagen chica no se amplía', () => {
    expect(targetSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(targetSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('prepareImage', () => {
  it('una foto de 8 MB se reduce a JPEG y deja de pasar el límite; el nombre cambia a .jpg', async () => {
    const d = deps({ out: 600_000 });
    const out = await prepareImage(file('IMG_001.HEIC.jpeg', 'image/jpeg', 8 * MB), d);
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(600_000);
    expect(out.name).toBe('IMG_001.HEIC.jpg');
    expect(d.encode).toHaveBeenCalledWith(expect.anything(), 1600, 1200);
  });

  it('un JPEG de hasta 2 MB y un PNG de hasta 5 MB se suben tal cual', async () => {
    const d = deps();
    const jpg = file('a.jpg', 'image/jpeg', 1.5 * MB);
    const png = file('b.png', 'image/png', 4 * MB);
    expect(await prepareImage(jpg, d)).toBe(jpg);
    expect(await prepareImage(png, d)).toBe(png);
    expect(d.encode).not.toHaveBeenCalled();
  });

  it('WebP y GIF (que WhatsApp oficial no acepta como imagen) se convierten a JPEG aunque sean chicos', async () => {
    const d = deps({ out: 50_000, w: 800, h: 600 });
    expect((await prepareImage(file('s.webp', 'image/webp', 100_000), d)).type).toBe('image/jpeg');
    expect((await prepareImage(file('g.gif', 'image/gif', 100_000), d)).type).toBe('image/jpeg');
  });

  it('un PNG de más de 5 MB se reduce a JPEG (con fondo blanco: lo hace el codificador)', async () => {
    const out = await prepareImage(file('c.png', 'image/png', 7 * MB), deps({ out: 900_000 }));
    expect(out.type).toBe('image/jpeg');
  });

  it('si aun reducida pasa de 5 MB, el error dice cuánto pesa y el máximo', async () => {
    await expect(prepareImage(file('d.jpg', 'image/jpeg', 30 * MB), deps({ out: MAX_IMAGE_BYTES + 1.2 * MB }))).rejects.toMatchObject({ status: 413, code: 'ATTACHMENT_TOO_LARGE', message: expect.stringContaining('máximo es 5 MB') });
  });

  it('HEIC que el navegador no sabe leer da un motivo claro (no un error genérico)', async () => {
    const d = deps({ decode: () => Promise.reject(new Error('no decode')) });
    await expect(prepareImage(file('IMG.heic', 'image/heic', 3 * MB), d)).rejects.toMatchObject({ status: 415, message: expect.stringContaining('HEIC') });
  });

  it('un JPEG que el navegador no decodifica pero ya cabe se sube como está; uno enorme falla claro', async () => {
    const d = deps({ decode: () => Promise.reject(new Error('x')) });
    const ok = file('e.jpg', 'image/jpeg', 3 * MB);
    expect(await prepareImage(ok, d)).toBe(ok);
    await expect(prepareImage(file('f.jpg', 'image/jpeg', 9 * MB), d)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('lo que no es imagen (audio, video, documentos) no se toca', async () => {
    const d = deps();
    const pdf = file('x.pdf', 'application/pdf', 20 * MB);
    expect(await prepareImage(pdf, d)).toBe(pdf);
    expect(d.encode).not.toHaveBeenCalled();
  });
});
