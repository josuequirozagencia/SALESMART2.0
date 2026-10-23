import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageError, type SignedUrlOptions, type StorageAdapter } from './storage.port';

export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Tope de espera a una operación de red, en milisegundos. */
const TIMEOUT_MS = 30_000;

/** Un nombre de descarga seguro para la cabecera `Content-Disposition` (ASCII, sin comillas ni saltos de línea). */
const asciiName = (name: string): string => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

/**
 * Almacenamiento S3-compatible (AWS S3, Cloudflare R2, MinIO…), ADR-02/50. Direccionamiento por ruta (`forcePathStyle`), que funciona igual en todos. Los errores
 * se traducen a `StorageError` con mensajes propios: nunca salen la clave de acceso, el secreto ni la URL firmada. **Probado solo contra un servidor simulado** hasta
 * que haya un bucket real.
 */
export class S3Storage implements StorageAdapter {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3StorageConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      maxAttempts: 2,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw this.fail(e);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!out.Body) throw new StorageError('not_found', 'El archivo no existe');
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      throw this.fail(e);
    }
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    try {
      const disposition = options.disposition === 'attachment' ? `attachment; filename="${asciiName(options.filename ?? 'archivo')}"` : 'inline';
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: options.contentType, ResponseContentDisposition: disposition }), { expiresIn: options.expiresInSeconds });
    } catch (e) {
      throw this.fail(e);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw this.fail(e);
    }
  }

  private fail(e: unknown): StorageError {
    if (e instanceof StorageError) return e;
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return new StorageError('not_found', 'El archivo no existe');
    if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch' || err.name === 'AccessDenied' || err.$metadata?.httpStatusCode === 403) return new StorageError('not_configured', 'El almacenamiento rechazó las credenciales: revisa Proveedores › Almacenamiento');
    return new StorageError('unavailable', 'El almacenamiento no respondió');
  }
}
