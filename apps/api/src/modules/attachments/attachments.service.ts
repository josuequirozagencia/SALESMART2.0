import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { baseMime, checkUpload, inlineAllowed, safeFilename, SENDABLE_AUDIO, storageKey, type AttachmentKind } from './attachment-rules';
import { VIRUS_SCANNER, ScanError, type VirusScanner } from './scanner';
import { StorageError } from './storage.port';
import { StorageGateway } from './storage.gateway';
import { AUDIO_TRANSCODER, TranscodeError, type AudioTranscoder } from './transcoder';

/** Un archivo ya revisado y listo para guardarse. */
export interface PreparedFile {
  readonly bytes: Buffer;
  readonly mime: string;
  readonly kind: AttachmentKind;
  /** Nombre para mostrar, ya limpio. */
  readonly filename: string;
  readonly checksum: string;
}

/** Cuánto vale la URL firmada con la que el navegador lee un archivo. */
export const URL_TTL_SECONDS = 300;

/**
 * Lo común de los archivos adjuntos (M5.6d, ADR-50): revisar lo que una persona sube (tipo declarado, tamaño y contenido real), convertir el audio grabado, pasarlo por el
 * antivirus, guardarlo en el almacenamiento bajo `org/<organización>/…` y entregarlo con una URL firmada de vida corta. No toca la base de datos: quien lo llama anota el
 * adjunto. Los errores son `AppError` con mensajes para la persona, sin rutas ni datos del almacenamiento.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    @Inject(AUDIO_TRANSCODER) private readonly transcoder: AudioTranscoder,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** ¿Hay dónde guardar archivos? La interfaz lo usa para ofrecer o no el botón de adjuntar. */
  available(): Promise<boolean> {
    return this.storage.available();
  }

  /** Valida lo que una persona sube y, si es una grabación que WhatsApp no admite (WebM de los navegadores), la convierte a OGG/Opus. */
  async prepareUpload(bytes: Buffer, declaredContentType: string | undefined, filename: string | null): Promise<PreparedFile> {
    let mime = baseMime(declaredContentType);
    let body = bytes;
    let check = checkUpload(mime, body);
    if (check.ok && check.kind === 'audio' && !SENDABLE_AUDIO.has(mime)) {
      try {
        body = await this.transcoder.toOggOpus(body);
      } catch (e) {
        if (e instanceof TranscodeError && e.code === 'unavailable') throw new AppError(503, 'AUDIO_CONVERSION_UNAVAILABLE', 'Este servidor aún no puede convertir grabaciones de audio. Adjunta un audio ya grabado (MP3, M4A u OGG)');
        throw new AppError(422, 'AUDIO_CONVERSION_FAILED', 'No pudimos leer la grabación de audio. Inténtalo de nuevo');
      }
      mime = 'audio/ogg';
      check = checkUpload(mime, body);
    }
    if (!check.ok) {
      const status = check.code === 'too_large' ? 413 : check.code === 'unsupported_type' ? 415 : check.code === 'empty' ? 400 : 422;
      throw new AppError(status, `ATTACHMENT_${check.code.toUpperCase()}`, check.message);
    }
    return { bytes: body, mime: check.mime, kind: check.kind, filename: safeFilename(filename, defaultName(check.kind, check.mime)), checksum: createHash('sha256').update(body).digest('hex') };
  }

  /**
   * Pasa el archivo por el antivirus y lo guarda. Infectado → 422 y NO se guarda; si el antivirus no responde → 503 (no se entrega nada sin revisar). Devuelve la clave del
   * almacenamiento y cómo quedó la revisión: `clean` o `skipped` (no hay antivirus configurado).
   */
  async scanAndStore(organizationId: string, attachmentId: string, file: Pick<PreparedFile, 'bytes' | 'mime'>): Promise<{ key: string; scanStatus: 'clean' | 'skipped' }> {
    const scan = await this.scan(file.bytes);
    if (scan === 'infected') throw new AppError(422, 'ATTACHMENT_INFECTED', 'El antivirus detectó un virus en el archivo: no se puede usar');
    const key = storageKey(organizationId, attachmentId);
    try {
      await this.storage.put(key, file.bytes, file.mime);
    } catch (e) {
      throw this.storageFailure(e);
    }
    return { key, scanStatus: scan };
  }

  /** Revisa un archivo: `clean`, `skipped` (sin antivirus) o `infected`. Lanza 503 si el antivirus no respondió. */
  async scan(bytes: Buffer): Promise<'clean' | 'skipped' | 'infected'> {
    try {
      const r = await this.scanner.scan(bytes);
      if (r.status === 'infected') this.log.warn({ signature: r.signature.slice(0, 80) }, 'el antivirus detectó un archivo infectado');
      return r.status;
    } catch (e) {
      if (e instanceof ScanError) throw new AppError(503, 'ATTACHMENT_SCAN_UNAVAILABLE', 'No pudimos revisar el archivo con el antivirus. Inténtalo en unos minutos');
      throw e;
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await this.storage.get(key);
    } catch (e) {
      throw this.storageFailure(e);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo borrar un archivo del almacenamiento');
    }
  }

  /** Una URL firmada para ver o descargar el archivo: vale pocos minutos. Imágenes, audio y video se muestran en la página; todo lo demás se descarga. */
  async signedUrl(key: string, kind: AttachmentKind, mime: string, filename: string | null): Promise<{ url: string; expiresAt: Date }> {
    try {
      const url = await this.storage.signedUrl(key, { expiresInSeconds: URL_TTL_SECONDS, contentType: mime, disposition: inlineAllowed(kind, mime) ? 'inline' : 'attachment', filename });
      return { url, expiresAt: new Date(Date.now() + URL_TTL_SECONDS * 1000) };
    } catch (e) {
      throw this.storageFailure(e);
    }
  }

  private storageFailure(e: unknown): AppError {
    if (e instanceof StorageError) {
      if (e.code === 'not_configured') return new AppError(503, 'STORAGE_NOT_CONFIGURED', e.message);
      if (e.code === 'not_found') return new AppError(404, 'NOT_FOUND', 'Recurso no encontrado');
    }
    return new AppError(503, 'STORAGE_UNAVAILABLE', 'No pudimos acceder al almacenamiento de archivos. Inténtalo en unos minutos');
  }
}

/** Nombre por omisión de un archivo sin nombre (p. ej. una grabación): «audio.ogg», «imagen.jpg»… */
function defaultName(kind: AttachmentKind, mime: string): string {
  const ext = extensionOf(mime);
  const base = kind === 'image' ? 'imagen' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : kind === 'sticker' ? 'sticker' : 'documento';
  return ext ? `${base}.${ext}` : base;
}

const EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};
export const extensionOf = (mime: string): string | null => EXT[mime] ?? null;
