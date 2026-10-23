import { spawn } from 'node:child_process';

/**
 * Conversión de audio a OGG/Opus (M5.6d, ADR-50): los navegadores graban en WebM/Opus (o MP4/AAC en Safari) y WhatsApp pide OGG/Opus para las notas de voz. Puerto +
 * ffmpeg + uno de mentira + «ninguno». Sin conversor, las grabaciones que no vengan ya en un formato de WhatsApp se rechazan con una explicación.
 */
export class TranscodeError extends Error {
  constructor(
    readonly code: 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'TranscodeError';
  }
}

export interface AudioTranscoder {
  readonly name: 'ffmpeg' | 'fake' | 'none';
  /** Convierte el audio a OGG/Opus mono. Lanza `TranscodeError`: `unavailable` si no hay conversor, `failed` si el audio no se pudo leer. */
  toOggOpus(input: Buffer): Promise<Buffer>;
}

export const AUDIO_TRANSCODER = Symbol('AUDIO_TRANSCODER');

export class NoTranscoder implements AudioTranscoder {
  readonly name = 'none' as const;
  toOggOpus(): Promise<Buffer> {
    return Promise.reject(new TranscodeError('unavailable', 'La conversión de audio no está disponible en este servidor'));
  }
}

/** Conversor de mentira: el resultado empieza por «OggS» y conserva el audio original; `down` simula que no hay conversor. */
export class FakeTranscoder implements AudioTranscoder {
  readonly name = 'fake' as const;
  down = false;
  readonly converted: number[] = [];
  toOggOpus(input: Buffer): Promise<Buffer> {
    if (this.down) return Promise.reject(new TranscodeError('unavailable', 'La conversión de audio no está disponible'));
    if (input.toString('latin1').includes('FAKE-BROKEN-AUDIO')) return Promise.reject(new TranscodeError('failed', 'No se pudo leer el audio'));
    this.converted.push(input.length);
    return Promise.resolve(Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0]), input]));
  }
}

const MAX_OUTPUT = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/**
 * ffmpeg como proceso hijo: el audio entra por la entrada estándar y el OGG/Opus sale por la salida estándar (nada toca el disco). Parámetros fijos, nunca construidos
 * con datos de la persona. Con tiempo máximo y tope de salida. **Probado solo con un ejecutable simulado** hasta que ffmpeg esté instalado en el servidor.
 */
export class FfmpegTranscoder implements AudioTranscoder {
  readonly name = 'ffmpeg' as const;
  constructor(private readonly path: string) {}

  toOggOpus(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'];
      let settled = false;
      const out: Buffer[] = [];
      let size = 0;
      const child = spawn(this.path, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new TranscodeError('failed', 'La conversión del audio tardó demasiado'))), TIMEOUT_MS);
      child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new TranscodeError(e.code === 'ENOENT' ? 'unavailable' : 'failed', e.code === 'ENOENT' ? 'La conversión de audio no está disponible en este servidor' : 'No se pudo convertir el audio'))));
      child.stdout.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_OUTPUT) return finish(() => reject(new TranscodeError('failed', 'El audio convertido es demasiado grande')));
        out.push(d);
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code === 0 && size > 0) return finish(() => resolve(Buffer.concat(out)));
        finish(() => reject(new TranscodeError('failed', 'No se pudo convertir el audio')));
      });
      child.stdin.on('error', () => undefined); // si ffmpeg cierra antes de leerlo todo, lo dice el código de salida
      child.stdin.end(input);
    });
  }
}
