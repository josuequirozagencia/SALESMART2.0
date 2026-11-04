import { readFile } from 'node:fs/promises';
import { assertDeletablePrefix, StorageError, type SignedUrlOptions, type StorageAdapter } from './storage.port';

/**
 * Almacenamiento de mentira (ADR-02): guarda en memoria. Solo desarrollo y pruebas (la configuración lo prohíbe en producción). Las «URL firmadas» apuntan a un
 * host inexistente pero llevan el vencimiento, para que las pruebas vean que la firma existe y caduca.
 */
export class FakeStorage implements StorageAdapter {
  readonly name = 'fake' as const;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  /** Si es true, todo falla como si el almacenamiento no respondiera. */
  down = false;

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    if (this.down) throw new StorageError('unavailable', 'El almacenamiento no responde');
    this.objects.set(key, { body: await readFile(path), contentType });
  }

  get(key: string): Promise<Buffer> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    const o = this.objects.get(key);
    return o ? Promise.resolve(Buffer.from(o.body)) : Promise.reject(new StorageError('not_found', 'El archivo no existe'));
  }

  signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
    const q = new URLSearchParams({ expires: String(expires), type: options.contentType, disposition: options.disposition, ...(options.filename ? { filename: options.filename } : {}) });
    return Promise.resolve(`https://fake-storage.test/${key}?${q.toString()}`);
  }

  /** Un prefijo inválido es un rechazo de la promesa (nunca una excepción síncrona), igual que en el adaptador real. */
  private badPrefix(prefix: string): StorageError | null {
    try {
      assertDeletablePrefix(prefix);
      return null;
    } catch (e) {
      return e instanceof StorageError ? e : new StorageError('unavailable', 'Prefijo de borrado inválido');
    }
  }

  delete(key: string): Promise<void> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    this.objects.delete(key);
    return Promise.resolve();
  }

  deleteByPrefix(prefix: string): Promise<number> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    const bad = this.badPrefix(prefix);
    if (bad) return Promise.reject(bad);
    let n = 0;
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) { this.objects.delete(k); n += 1; }
    return Promise.resolve(n);
  }

  countByPrefix(prefix: string, limit = Infinity): Promise<number> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    const bad = this.badPrefix(prefix);
    if (bad) return Promise.reject(bad);
    let n = 0;
    for (const k of this.objects.keys()) if (k.startsWith(prefix) && ++n >= limit) break;
    return Promise.resolve(n);
  }
}
