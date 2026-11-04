import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import type { AppLogger } from '../../logger';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { PlatformCredentialsReader } from '../platform';
import { FakeStorage } from './storage.fake';
import { StorageError, type SignedUrlOptions, type StorageAdapter } from './storage.port';
import { S3Storage } from './storage.s3';

/**
 * El almacenamiento que usa el servidor (M5.6d, ADR-50). Cumple el mismo puerto que cualquier adaptador, pero resuelve CUÁL usar en cada llamada: el S3-compatible que el
 * Súper Admin configuró en «Proveedores › Almacenamiento» (las credenciales salen de la bóveda de la plataforma, con caché corta) o, en desarrollo y pruebas, el de memoria.
 * Sin almacenamiento configurado, lanza `StorageError('not_configured')`: la interfaz lo explica y el resto del Inbox sigue funcionando.
 */
@Injectable()
export class StorageGateway implements StorageAdapter {
  /** El de memoria (solo con `STORAGE_PROVIDER=fake`): las pruebas lo miran. */
  readonly fake = new FakeStorage();
  private cached: { fingerprint: string; adapter: S3Storage } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PlatformCredentialsReader) private readonly credentials: PlatformCredentialsReader,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Ejecuta una operación y, si falla, deja en el registro del servidor QUÉ respondió el almacenamiento (la persona solo ve un mensaje general). Sin claves ni URL firmadas. */
  private async run<T>(op: string, fn: (adapter: StorageAdapter) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.adapter());
    } catch (e) {
      if (e instanceof StorageError) this.log.warn({ op, code: e.code, detail: e.detail ?? e.message }, 'el almacenamiento falló');
      throw e;
    }
  }

  get name(): 's3' | 'fake' {
    return this.cfg.attachments.storageProvider === 'fake' ? 'fake' : 's3';
  }

  /**
   * El origen (esquema + servidor + puerto) desde donde el navegador leerá los archivos por URL firmada, para permitirlo en la política de contenido de la web.
   * Con el almacenamiento sin configurar o ilegible: ninguno. Nunca devuelve la ruta ni nada secreto.
   */
  async mediaOrigins(): Promise<string[]> {
    if (this.cfg.attachments.storageProvider === 'fake') return ['https://fake-storage.test'];
    try {
      const endpoint = (await this.credentials.active('storage'))?.values['endpoint'];
      return endpoint ? [new URL(endpoint).origin] : [];
    } catch {
      return [];
    }
  }

  /** ¿Hay dónde guardar archivos? */
  async available(): Promise<boolean> {
    try {
      await this.adapter();
      return true;
    } catch {
      return false;
    }
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.run('put', (a) => a.put(key, body, contentType));
  }

  putFile(key: string, path: string, contentType: string): Promise<void> {
    return this.run('putFile', (a) => a.putFile(key, path, contentType));
  }

  deleteByPrefix(prefix: string): Promise<number> {
    return this.run('deleteByPrefix', (a) => a.deleteByPrefix(prefix));
  }

  countByPrefix(prefix: string, limit?: number): Promise<number> {
    return this.run('countByPrefix', (a) => a.countByPrefix(prefix, limit));
  }

  get(key: string): Promise<Buffer> {
    return this.run('get', (a) => a.get(key));
  }

  signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return this.run('signedUrl', (a) => a.signedUrl(key, options));
  }

  delete(key: string): Promise<void> {
    return this.run('delete', (a) => a.delete(key));
  }

  private async adapter(): Promise<StorageAdapter> {
    if (this.cfg.attachments.storageProvider === 'fake') return this.fake;
    const c = await this.credentials.active('storage');
    const v = c?.values;
    if (!c || c.provider !== 's3_compatible' || !v?.['endpoint'] || !v['region'] || !v['bucket'] || !v['access_key_id'] || !v['secret_access_key']) {
      throw new StorageError('not_configured', 'El almacenamiento de archivos aún no está configurado: el Súper Admin debe guardarlo en Proveedores › Almacenamiento');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([v['endpoint'], v['region'], v['bucket'], v['access_key_id'], v['secret_access_key']])).digest('hex');
    if (this.cached?.fingerprint === fingerprint) return this.cached.adapter;
    const adapter = new S3Storage({ endpoint: v['endpoint'], region: v['region'], bucket: v['bucket'], accessKeyId: v['access_key_id'], secretAccessKey: v['secret_access_key'] });
    this.cached = { fingerprint, adapter };
    return adapter;
  }
}
