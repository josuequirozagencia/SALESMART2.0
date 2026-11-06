import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpPhotoDownloader, MAX_CONTACT_PHOTO_BYTES } from '../../src/modules/qr/photo-downloader';

/** v5: la dirección de la foto viene de un tercero (Evolution/WhatsApp): solo se bajan imágenes de sus servidores, nunca de nuestra red. */
describe('HttpPhotoDownloader', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (fn: () => Promise<Response>) => {
    const f = vi.fn((_url?: unknown, _init?: RequestInit) => fn());
    vi.stubGlobal('fetch', f);
    return f;
  };

  it.each([
    'http://pps.whatsapp.net/v/a.jpg',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/a.jpg',
    'https://pps.whatsapp.net.evil.test/a.jpg',
    'https://evilwhatsapp.net/a.jpg',
    'https://pps.whatsapp.net:8443/a.jpg',
    'https://user:pass@pps.whatsapp.net/a.jpg',
    'no es una dirección',
  ])('no pide %s (devuelve null sin salir a la red)', async (url) => {
    const f = stub(() => Promise.resolve(new Response('x')));
    expect(await new HttpPhotoDownloader().download(url)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('baja una imagen de un host de WhatsApp (sin seguir redirecciones)', async () => {
    const f = stub(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    const bytes = await new HttpPhotoDownloader().download('https://pps.whatsapp.net/v/t61/a.jpg');
    expect([...(bytes ?? [])]).toEqual([1, 2, 3]);
    expect(f.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('rechaza lo vacío, lo que pesa de más (declarado o no) y un servidor que falla', async () => {
    stub(() => Promise.resolve(new Response(null, { status: 200 })));
    expect(await new HttpPhotoDownloader().download('https://pps.whatsapp.net/a.jpg')).toBeNull();
    stub(() => Promise.resolve(new Response(new Uint8Array(MAX_CONTACT_PHOTO_BYTES + 1))));
    expect(await new HttpPhotoDownloader().download('https://pps.whatsapp.net/a.jpg')).toBeNull();
    stub(() => Promise.resolve(new Response('x', { status: 404 })));
    expect(await new HttpPhotoDownloader().download('https://pps.whatsapp.net/a.jpg')).toBeNull();
    stub(() => Promise.reject(new Error('red')));
    expect(await new HttpPhotoDownloader().download('https://pps.whatsapp.net/a.jpg')).toBeNull();
  });
});
