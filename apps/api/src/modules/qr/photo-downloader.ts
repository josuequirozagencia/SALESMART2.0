/** Tope de una foto de perfil (la misma que las de agentes). */
export const MAX_CONTACT_PHOTO_BYTES = 2 * 1024 * 1024;
export const PHOTO_DOWNLOADER = Symbol('PHOTO_DOWNLOADER');

/** Baja los bytes de una foto a partir de la dirección que dio el proveedor. null = no se pudo o no es admisible (nunca lanza). */
export interface PhotoDownloader {
  download(url: string): Promise<Buffer | null>;
}

/** Solo se bajan imágenes de los servidores de WhatsApp: la dirección viene de un tercero y no puede apuntar a nuestra red interna. */
const ALLOWED_HOST = /(^|\.)(whatsapp\.net|fbcdn\.net)$/;

/**
 * Descargador real: https en el puerto estándar, solo hosts de WhatsApp (`*.whatsapp.net`, `*.fbcdn.net`), sin redirecciones, 10 s y un tope de 2 MB leído por partes (el tamaño declarado no se cree).
 * **Sin validar contra la red de WhatsApp real.**
 */
export class HttpPhotoDownloader implements PhotoDownloader {
  async download(url: string): Promise<Buffer | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || !ALLOWED_HOST.test(u.hostname.toLowerCase())) return null;
    try {
      const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } });
      if (!res.ok || !res.body) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_CONTACT_PHOTO_BYTES) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > MAX_CONTACT_PHOTO_BYTES) return null;
        chunks.push(Buffer.from(part));
      }
      return size === 0 ? null : Buffer.concat(chunks);
    } catch {
      return null;
    }
  }
}
