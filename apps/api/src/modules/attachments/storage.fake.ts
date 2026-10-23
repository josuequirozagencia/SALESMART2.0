import { StorageError, type SignedUrlOptions, type StorageAdapter } from './storage.port';

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

  delete(key: string): Promise<void> {
    if (this.down) return Promise.reject(new StorageError('unavailable', 'El almacenamiento no responde'));
    this.objects.delete(key);
    return Promise.resolve();
  }
}
