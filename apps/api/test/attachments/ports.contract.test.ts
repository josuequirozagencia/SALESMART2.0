// Contratos de los puertos de M5.6d (ADR-50): almacenamiento, antivirus y conversor de audio. Cada adaptador real se prueba contra un servidor simulado
// (S3 por HTTP, clamd por TCP) y debe comportarse igual que su fake. NINGUNO se ha probado todavía contra el servicio real.
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createTcp, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClamAvScanner, EICAR, FakeScanner, NoScanner, ScanError, type VirusScanner } from '../../src/modules/attachments/scanner';
import { FakeStorage } from '../../src/modules/attachments/storage.fake';
import { StorageError, type StorageAdapter } from '../../src/modules/attachments/storage.port';
import { S3Storage } from '../../src/modules/attachments/storage.s3';
import { FakeTranscoder, FfmpegTranscoder, NoTranscoder, TranscodeError, type AudioTranscoder } from '../../src/modules/attachments/transcoder';

const SECRET = 'clave-secreta-de-prueba-0123456789abcdef';
const ACCESS = 'AKIAPRUEBA0123456789';
const KEY = 'org/0190a000-0000-7000-8000-000000000001/attachments/0190a000-0000-7000-8000-0000000000aa';

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// Almacenamiento
// ═════════════════════════════════════════════════════════════════════════════
const store = new Map<string, { body: Buffer; type: string }>();
let s3Mode: 'ok' | 'denied' | 'down' = 'ok';
let s3: HttpServer;
let s3Origin = '';

function s3Handler(): HttpServer {
  return createHttp((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const key = decodeURIComponent(url.pathname).replace(/^\/bucket-de-prueba\//, '');
      const xml = (status: number, code: string): void => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      };
      if (s3Mode === 'denied') return xml(403, 'AccessDenied');
      if (s3Mode === 'down') return xml(500, 'InternalError');
      if (req.method === 'PUT') {
        store.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? '') });
        res.writeHead(200, { etag: '"abc"' });
        return void res.end();
      }
      if (req.method === 'GET') {
        const o = store.get(key);
        if (!o) return xml(404, 'NoSuchKey');
        res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length });
        return void res.end(o.body);
      }
      if (req.method === 'DELETE') {
        store.delete(key);
        res.writeHead(204);
        return void res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
}

beforeAll(async () => {
  s3 = s3Handler();
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  s3Origin = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => {
    s3.closeAllConnections();
    s3.close(() => r());
  });
});

function storageContract(name: string, make: () => StorageAdapter, opts: { signedHost: () => string }): void {
  describe(`contrato StorageAdapter · ${name}`, () => {
    it('guarda y lee el mismo contenido', async () => {
      const s = make();
      const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0, 255]);
      await s.put(KEY, body, 'image/jpeg');
      expect((await s.get(KEY)).equals(body)).toBe(true);
    });

    it('leer lo que no existe es not_found', async () => {
      const s = make();
      const e = await errorOf(s.get(`${KEY}-no-existe`));
      expect(e).toBeInstanceOf(StorageError);
      expect((e as StorageError).code).toBe('not_found');
    });

    it('borrar quita el archivo y borrar uno que no existe no es un error', async () => {
      const s = make();
      await s.put(`${KEY}-borrar`, Buffer.from('x'), 'text/plain');
      await s.delete(`${KEY}-borrar`);
      expect(((await errorOf(s.get(`${KEY}-borrar`))) as StorageError).code).toBe('not_found');
      await expect(s.delete(`${KEY}-borrar`)).resolves.toBeUndefined();
    });

    it('la URL firmada apunta a la clave, caduca y dice si se muestra o se descarga; nunca lleva el secreto', async () => {
      const s = make();
      const inline = await s.signedUrl(KEY, { expiresInSeconds: 300, contentType: 'image/jpeg', disposition: 'inline', filename: 'foto.jpg' });
      const download = await s.signedUrl(KEY, { expiresInSeconds: 300, contentType: 'application/pdf', disposition: 'attachment', filename: 'Lista de precios ñandú.pdf' });
      for (const url of [inline, download]) {
        expect(url.startsWith(opts.signedHost())).toBe(true);
        expect(url).toContain(KEY);
        expect(url).not.toContain(SECRET);
      }
      expect(decodeURIComponent(inline)).toContain('inline');
      expect(decodeURIComponent(download)).toContain('attachment');
      expect(download).toMatch(/300|expires/i);
      // dos peticiones distintas dan firmas distintas cuando hay firma real (disposición y tipo forman parte de ella)
      expect(inline).not.toBe(download);
    });
  });
}

storageContract('fake', () => new FakeStorage(), { signedHost: () => 'https://fake-storage.test/' });
storageContract('S3 compatible (servidor simulado)', () => new S3Storage({ endpoint: s3Origin, region: 'us-east-1', bucket: 'bucket-de-prueba', accessKeyId: ACCESS, secretAccessKey: SECRET }), { signedHost: () => `${s3Origin}/bucket-de-prueba/` });

describe('S3Storage · errores', () => {
  const adapter = (endpoint = s3Origin): S3Storage => new S3Storage({ endpoint, region: 'us-east-1', bucket: 'bucket-de-prueba', accessKeyId: ACCESS, secretAccessKey: SECRET });

  it('credenciales rechazadas → not_configured (con el mensaje de dónde arreglarlo), sin filtrar las claves', async () => {
    s3Mode = 'denied';
    try {
      const e = (await errorOf(adapter().put(KEY, Buffer.from('x'), 'text/plain'))) as StorageError;
      expect(e).toBeInstanceOf(StorageError);
      expect(e.code).toBe('not_configured');
      expect(e.message).toContain('Proveedores');
      expect(`${e.message} ${e.stack ?? ''}`).not.toContain(SECRET);
      expect(`${e.message} ${e.stack ?? ''}`).not.toContain(ACCESS);
    } finally {
      s3Mode = 'ok';
    }
  });

  it('el servicio caído (500) o sin conexión → unavailable', async () => {
    s3Mode = 'down';
    try {
      expect(((await errorOf(adapter().get(KEY))) as StorageError).code).toBe('unavailable');
    } finally {
      s3Mode = 'ok';
    }
    expect(((await errorOf(adapter('http://127.0.0.1:1').get(KEY))) as StorageError).code).toBe('unavailable');
  });

  it('guarda el tipo de contenido que se le indica', async () => {
    await adapter().put(`${KEY}-tipo`, Buffer.from('%PDF-1.4'), 'application/pdf');
    expect(store.get(`${KEY}-tipo`)?.type).toBe('application/pdf');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Antivirus (ClamAV por TCP)
// ═════════════════════════════════════════════════════════════════════════════
let clam: TcpServer;
let clamPort = 0;
let clamMode: 'ok' | 'error' | 'garbage' = 'ok';
const clamReceived: number[] = [];
const clamCommands: string[] = [];

/** clamd simulado: entiende `zINSTREAM\0`, lee trozos con su largo (4 bytes) hasta el largo 0 y responde. */
function clamHandler(socket: Socket): void {
  let buf = Buffer.alloc(0);
  let started = false;
  let total = 0;
  let content = Buffer.alloc(0);
  socket.on('error', () => undefined);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!started) {
      const nul = buf.indexOf(0);
      if (nul < 0) return;
      clamCommands.push(buf.subarray(0, nul).toString('latin1'));
      buf = buf.subarray(nul + 1);
      started = true;
    }
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len === 0) {
        clamReceived.push(total);
        const reply = clamMode === 'error' ? 'INSTREAM size limit exceeded. ERROR' : clamMode === 'garbage' ? 'lo que sea' : content.includes(Buffer.from(EICAR, 'latin1')) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK';
        socket.end(`${reply}\0`);
        return;
      }
      if (buf.length < 4 + len) return;
      content = Buffer.concat([content, buf.subarray(4, 4 + len)]);
      total += len;
      buf = buf.subarray(4 + len);
    }
  });
}

beforeAll(async () => {
  clam = createTcp(clamHandler);
  await new Promise<void>((r) => clam.listen(0, '127.0.0.1', r));
  clamPort = (clam.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => clam.close(() => r()));
});

function scannerContract(name: string, make: () => VirusScanner): void {
  describe(`contrato VirusScanner · ${name}`, () => {
    it('un archivo limpio sale limpio', async () => {
      expect(await make().scan(Buffer.from('%PDF-1.4 contenido normal'))).toEqual({ status: 'clean' });
    });
    it('la cadena de prueba EICAR se detecta, con el nombre de la firma', async () => {
      const r = await make().scan(Buffer.from(EICAR, 'latin1'));
      expect(r.status).toBe('infected');
      if (r.status === 'infected') expect(r.signature.length).toBeGreaterThan(0);
    });
    it('EICAR escondida dentro de un archivo más grande también se detecta', async () => {
      const big = Buffer.concat([Buffer.alloc(200_000, 0x41), Buffer.from(EICAR, 'latin1'), Buffer.alloc(100_000, 0x42)]);
      expect((await make().scan(big)).status).toBe('infected');
    });
  });
}
scannerContract('fake', () => new FakeScanner());
scannerContract('ClamAV (clamd simulado)', () => new ClamAvScanner('127.0.0.1', clamPort));

describe('ClamAvScanner · protocolo y errores', () => {
  it('manda zINSTREAM y el archivo completo en trozos con su largo (un archivo de 200 KB llega entero)', async () => {
    clamMode = 'ok';
    clamReceived.length = 0;
    clamCommands.length = 0;
    await new ClamAvScanner('127.0.0.1', clamPort).scan(Buffer.alloc(200_000, 7));
    expect(clamCommands).toEqual(['zINSTREAM']);
    expect(clamReceived).toEqual([200_000]);
  });

  it('un error de clamd, una respuesta rara o ningún servidor son ScanError (el archivo NO se da por limpio)', async () => {
    clamMode = 'error';
    expect(await errorOf(new ClamAvScanner('127.0.0.1', clamPort).scan(Buffer.from('x')))).toBeInstanceOf(ScanError);
    clamMode = 'garbage';
    expect(await errorOf(new ClamAvScanner('127.0.0.1', clamPort).scan(Buffer.from('x')))).toBeInstanceOf(ScanError);
    clamMode = 'ok';
    expect(await errorOf(new ClamAvScanner('127.0.0.1', 1).scan(Buffer.from('x')))).toBeInstanceOf(ScanError);
  });

  it('el fake caído también lanza ScanError y «sin antivirus» deja el archivo sin revisar (skipped), nunca limpio', async () => {
    const f = new FakeScanner();
    f.down = true;
    expect(await errorOf(f.scan(Buffer.from('x')))).toBeInstanceOf(ScanError);
    expect(await new NoScanner().scan()).toEqual({ status: 'skipped' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Conversor de audio
// ═════════════════════════════════════════════════════════════════════════════
describe('AudioTranscoder', () => {
  const code = async (t: AudioTranscoder, input = Buffer.from('audio')): Promise<string> => {
    const e = await errorOf(t.toOggOpus(input));
    return e instanceof TranscodeError ? e.code : 'ok';
  };

  it('el fake devuelve un OGG (empieza por OggS) y el audio roto o sin conversor se distinguen', async () => {
    const f = new FakeTranscoder();
    const out = await f.toOggOpus(Buffer.from('audio'));
    expect(out.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(await code(f, Buffer.from('FAKE-BROKEN-AUDIO'))).toBe('failed');
    f.down = true;
    expect(await code(f)).toBe('unavailable');
  });

  it('sin conversor configurado: unavailable', async () => {
    expect(await code(new NoTranscoder())).toBe('unavailable');
  });

  it('ffmpeg que no existe en el servidor: unavailable; un programa que falla: failed (nunca se cuelga ni lanza otra cosa)', async () => {
    expect(await code(new FfmpegTranscoder('/ruta/que/no/existe/ffmpeg'))).toBe('unavailable');
    // node recibe los argumentos de ffmpeg, no los entiende y sale con error
    expect(await code(new FfmpegTranscoder(process.execPath))).toBe('failed');
  });
});
