import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertDeletablePrefix, StorageError, type SignedUrlOptions, type StorageAdapter } from './storage.port';

export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Tope de espera a una operación de red, en milisegundos. */
const TIMEOUT_MS = 30_000;
/** Subir un paquete grande desde el disco tarda más que una operación común. */
const UPLOAD_FILE_TIMEOUT_MS = 30 * 60_000;

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

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const body = createReadStream(path);
    try {
      const { size } = await stat(path);
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: size }), { abortSignal: AbortSignal.timeout(UPLOAD_FILE_TIMEOUT_MS) });
    } catch (e) {
      throw this.fail(e);
    } finally {
      body.destroy();
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

  async deleteByPrefix(prefix: string): Promise<number> {
    assertDeletablePrefix(prefix);
    let deleted = 0;
    try {
      // Se lista y se borra por páginas de hasta 1000 (el máximo de S3/R2 por petición). Sin cursor guardado: tras borrar una página, la siguiente lista ya no la trae.
      for (let guard = 0; guard < 100_000; guard++) {
        const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000 }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) return deleted;
        const out = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        if ((out.Errors ?? []).length > 0) throw new StorageError('unavailable', 'El almacenamiento no pudo borrar algunos archivos');
        deleted += keys.length;
      }
      throw new StorageError('unavailable', 'Demasiadas páginas al borrar un prefijo');
    } catch (e) {
      throw this.fail(e);
    }
  }

  async countByPrefix(prefix: string, limit = 1_000_000): Promise<number> {
    assertDeletablePrefix(prefix);
    try {
      let n = 0;
      let token: string | undefined;
      do {
        const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        n += (page.Contents ?? []).length;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token && n < limit);
      return n;
    } catch (e) {
      throw this.fail(e);
    }
  }

  private fail(e: unknown): StorageError {
    if (e instanceof StorageError) return e;
    const err = e as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const status = err.$metadata?.httpStatusCode;
    // Lo que se ve en el registro del servidor para diagnosticar (nunca al cliente): tipo de error, código HTTP y el mensaje sin firmas ni credenciales
    const detail = `${err.name ?? 'Error'} http=${status ?? '-'} code=${err.Code ?? err.code ?? '-'} ${String(err.message ?? '').replace(/(signature|credential|authorization|x-amz-[a-z-]+)=[^&\s"']+/gi, '$1=***').slice(0, 200)}`;
    // El bucket no existe, o la llave no llega a él: es un problema de configuración, no de un archivo que falte
    if (err.name === 'NoSuchBucket') return new StorageError('not_configured', 'El bucket no existe o la llave no tiene acceso a él: revisa el nombre del bucket y los permisos de la llave en Proveedores › Almacenamiento', detail);
    if (err.name === 'NoSuchKey' || err.name === 'NotFound' || status === 404) return new StorageError('not_found', 'El archivo no existe', detail);
    // R2 responde 401 («Unauthorized») además de 403 cuando la llave no vale
    if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch' || err.name === 'AccessDenied' || err.name === 'Unauthorized' || status === 401 || status === 403) {
      return new StorageError('not_configured', 'El almacenamiento rechazó las credenciales: revisa Proveedores › Almacenamiento', detail);
    }
    return new StorageError('unavailable', 'El almacenamiento no respondió', detail);
  }
}
