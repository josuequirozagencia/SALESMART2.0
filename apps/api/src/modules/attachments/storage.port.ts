/**
 * Puerto de almacenamiento de archivos (ADR-02, ADR-50). El núcleo guarda y pide archivos por CLAVE; ninguna otra pieza conoce al proveedor (S3, R2, MinIO…). Cada
 * implementación —el S3-compatible real y el fake de memoria— cumple el mismo contract test. Los archivos son privados: se entregan solo con una URL firmada de vida corta.
 */

export interface SignedUrlOptions {
  /** Cuánto vale la URL, en segundos. */
  readonly expiresInSeconds: number;
  /** Tipo con el que el navegador debe tratar el archivo (el almacenamiento lo devuelve tal cual). */
  readonly contentType: string;
  /** `inline` (verlo en la página) o `attachment` (descargarlo). */
  readonly disposition: 'inline' | 'attachment';
  /** Nombre con el que se descarga. */
  readonly filename: string | null;
}

export interface StorageAdapter {
  readonly name: 's3' | 'fake';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Lee el archivo entero. Lanza `StorageError('not_found')` si no existe. */
  get(key: string): Promise<Buffer>;
  /** Una URL temporal para que el navegador lea el archivo directamente del almacenamiento. */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string>;
  /** Borra el archivo; borrar uno que no existe no es un error. */
  delete(key: string): Promise<void>;
}

/** `not_configured` la plataforma no tiene almacenamiento configurado · `unavailable` no respondió (se puede reintentar) · `not_found` el archivo no existe. */
export type StorageErrorCode = 'not_configured' | 'unavailable' | 'not_found';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Token de inyección del almacenamiento. */
export const STORAGE = Symbol('STORAGE');
