import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
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
  ) {}

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
    return this.adapter().then((a) => a.put(key, body, contentType));
  }

  get(key: string): Promise<Buffer> {
    return this.adapter().then((a) => a.get(key));
  }

  signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return this.adapter().then((a) => a.signedUrl(key, options));
  }

  delete(key: string): Promise<void> {
    return this.adapter().then((a) => a.delete(key));
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
