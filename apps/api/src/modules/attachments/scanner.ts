import { connect, type Socket } from 'node:net';

/**
 * Antivirus (M5.6d, ADR-50). Puerto + adaptadores: ClamAV por su protocolo `INSTREAM` (clamd en un servicio aparte), uno de mentira para pruebas y «ninguno». Un archivo
 * solo se entrega si el antivirus lo dio por limpio, o si no hay antivirus configurado (queda marcado `skipped`: «sin revisar»).
 */
export type ScanResult = { readonly status: 'clean' } | { readonly status: 'infected'; readonly signature: string } | { readonly status: 'skipped' };

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

export interface VirusScanner {
  readonly name: 'clamav' | 'fake' | 'none';
  /** Revisa el archivo. Lanza `ScanError` si no se pudo revisar (el antivirus no respondió): el archivo NO se entrega. */
  scan(body: Buffer): Promise<ScanResult>;
}

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

/** La cadena de prueba estándar de la industria (EICAR): inofensiva, pero todo antivirus la detecta. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Sin antivirus: nada se revisa. */
export class NoScanner implements VirusScanner {
  readonly name = 'none' as const;
  scan(): Promise<ScanResult> {
    return Promise.resolve({ status: 'skipped' });
  }
}

/** Antivirus de mentira: detecta EICAR y la marca `FAKE-VIRUS`; `down` simula que no responde. Solo desarrollo y pruebas. */
export class FakeScanner implements VirusScanner {
  readonly name = 'fake' as const;
  down = false;
  readonly scanned: number[] = [];
  scan(body: Buffer): Promise<ScanResult> {
    if (this.down) return Promise.reject(new ScanError('El antivirus no responde'));
    this.scanned.push(body.length);
    const text = body.toString('latin1');
    if (text.includes(EICAR)) return Promise.resolve({ status: 'infected', signature: 'Eicar-Test-Signature' });
    if (text.includes('FAKE-VIRUS')) return Promise.resolve({ status: 'infected', signature: 'Fake.Virus' });
    return Promise.resolve({ status: 'clean' });
  }
}

const CHUNK = 64 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * ClamAV (clamd) por TCP con el comando `zINSTREAM`: se envía el archivo en trozos con su largo y se lee la respuesta (`stream: OK`, `stream: <firma> FOUND` o `… ERROR`).
 * clamd rechaza lo que supera su `StreamMaxLength`: debe configurarse en 30 MB o más. **Probado solo contra un clamd simulado** hasta que haya un servicio real.
 */
export class ClamAvScanner implements VirusScanner {
  readonly name = 'clamav' as const;
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      const socket: Socket = connect({ host: this.host, port: this.port });
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };
      socket.setTimeout(TIMEOUT_MS, () => done(() => reject(new ScanError('El antivirus tardó demasiado'))));
      socket.on('error', () => done(() => reject(new ScanError('No pudimos conectar con el antivirus'))));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        done(() => {
          if (/^stream:\s*OK$/.test(reply)) return resolve({ status: 'clean' });
          const found = /^stream:\s*(.{1,200}?)\s+FOUND$/.exec(reply);
          if (found) return resolve({ status: 'infected', signature: found[1]! });
          reject(new ScanError('El antivirus respondió algo inesperado'));
        });
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < body.length; off += CHUNK) {
          const part = body.subarray(off, Math.min(off + CHUNK, body.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // largo 0 = fin del archivo
      });
    });
  }
}
