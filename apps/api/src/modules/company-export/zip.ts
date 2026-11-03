import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { createDeflateRaw, type DeflateRaw } from 'node:zlib';

/**
 * Escritor de archivos ZIP en streaming (F3b, ADR-59 #8). Sin dependencias: cada entrada se comprime con deflate mientras se escribe y sus tamaños y su CRC van en un «descriptor de datos» al final,
 * de modo que nunca hay que conocerlos de antemano ni cargar la entrada entera en memoria. NO implementa ZIP64: por eso los límites de abajo son duros y quien lo usa (`ExportPackager`) parte
 * las entradas y los paquetes antes de llegar a ellos. Los nombres van en UTF-8.
 */
export const ZIP_MAX_ENTRIES = 65_000;
/** Ningún tamaño de entrada ni de archivo puede llegar a 4 GiB sin ZIP64; se deja un margen amplio. */
export const ZIP_MAX_BYTES = 3 * 1024 ** 3;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 incremental: empieza con `0xffffffff` y se cierra con `crc32Final`. */
export function crc32Update(state: number, chunk: Uint8Array): number {
  let c = state;
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}
export const crc32Final = (state: number): number => (state ^ 0xffffffff) >>> 0;
export const CRC32_START = 0xffffffff;

interface Done {
  name: string;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const dosParts = (d: Date): { time: number; date: number } => ({
  time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  date: (Math.max(1980, d.getUTCFullYear()) - 1980) * 512 + (d.getUTCMonth() + 1) * 32 + d.getUTCDate(),
});

/** Una entrada abierta: se escribe con `write` y se cierra con `end` (que devuelve cuántos bytes sin comprimir tuvo). */
export class ZipEntry {
  private crc = CRC32_START;
  private size = 0;
  private compressed = 0;
  private readonly deflate: DeflateRaw = createDeflateRaw({ level: 6 });
  private readonly sink: Writable;
  private failure: Error | null = null;

  constructor(
    private readonly zip: ZipFileWriter,
    private readonly name: string,
    private readonly offset: number,
    private readonly time: number,
    private readonly date: number,
  ) {
    this.sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.compressed += chunk.length;
        zip.account(chunk.length);
        zip.rawWrite(chunk).then(() => cb(), (e: unknown) => cb(e instanceof Error ? e : new Error('escritura fallida')));
      },
    });
    this.deflate.on('error', (e) => (this.failure = e));
    this.sink.on('error', (e) => (this.failure = e));
    this.deflate.pipe(this.sink);
  }

  get uncompressed(): number {
    return this.size;
  }

  async write(data: Buffer | string): Promise<void> {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (this.failure) throw this.failure;
    this.size += chunk.length;
    if (this.size >= ZIP_MAX_BYTES) throw new ZipLimitError('una entrada del ZIP es demasiado grande');
    this.crc = crc32Update(this.crc, chunk);
    if (!this.deflate.write(chunk)) await once(this.deflate, 'drain');
  }

  async end(): Promise<number> {
    this.deflate.end();
    await once(this.sink, 'finish');
    if (this.failure) throw this.failure;
    const done: Done = { name: this.name, crc: crc32Final(this.crc), compressed: this.compressed, size: this.size, offset: this.offset, time: this.time, date: this.date };
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(done.crc, 4);
    dd.writeUInt32LE(done.compressed, 8);
    dd.writeUInt32LE(done.size, 12);
    await this.zip.rawWrite(dd);
    this.zip.account(dd.length);
    this.zip.finishEntry(done);
    return done.size;
  }
}

export class ZipFileWriter {
  private readonly out: WriteStream;
  private offset = 0;
  private readonly entries: Done[] = [];
  private open: ZipEntry | null = null;
  private failure: Error | null = null;
  private closed = false;

  constructor(readonly path: string) {
    this.out = createWriteStream(path);
    this.out.on('error', (e) => (this.failure = e));
  }

  /** Bytes escritos hasta ahora (el archivo final mide eso más el directorio central, pocas decenas de bytes por entrada). */
  get bytes(): number {
    return this.offset;
  }

  get count(): number {
    return this.entries.length;
  }

  /** Uso interno de `ZipEntry`. */
  account(n: number): void {
    this.offset += n;
  }

  async rawWrite(buf: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  finishEntry(done: Done): void {
    this.entries.push(done);
    this.open = null;
  }

  /** Abre una entrada. Solo una a la vez. */
  async begin(name: string, when: Date = new Date()): Promise<ZipEntry> {
    if (this.closed) throw new Error('el ZIP ya está cerrado');
    if (this.open) throw new Error('hay una entrada abierta');
    if (this.entries.length >= ZIP_MAX_ENTRIES) throw new ZipLimitError('el ZIP tiene demasiadas entradas');
    if (this.offset >= ZIP_MAX_BYTES) throw new ZipLimitError('el ZIP es demasiado grande');
    const nameBytes = Buffer.from(name, 'utf8');
    const { time, date } = dosParts(when);
    const h = Buffer.alloc(30 + nameBytes.length);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // bit 3: tamaños y CRC en el descriptor · bit 11: nombre en UTF-8
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(h, 30);
    const offset = this.offset;
    await this.rawWrite(h);
    this.offset += h.length;
    const entry = new ZipEntry(this, name, offset, time, date);
    this.open = entry;
    return entry;
  }

  /** Una entrada pequeña de una sola vez. */
  async addBuffer(name: string, data: Buffer | string, when?: Date): Promise<void> {
    const e = await this.begin(name, when);
    await e.write(data);
    await e.end();
  }

  /** Escribe el directorio central y cierra el archivo. Devuelve el tamaño final. */
  async close(): Promise<number> {
    if (this.closed) throw new Error('el ZIP ya está cerrado');
    if (this.open) throw new Error('hay una entrada abierta');
    this.closed = true;
    const dirStart = this.offset;
    for (const e of this.entries) {
      const nameBytes = Buffer.from(e.name, 'utf8');
      const c = Buffer.alloc(46 + nameBytes.length);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.compressed, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(nameBytes.length, 28);
      c.writeUInt32LE(e.offset, 42);
      nameBytes.copy(c, 46);
      await this.rawWrite(c);
      this.offset += c.length;
    }
    const dirSize = this.offset - dirStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(dirSize, 12);
    eocd.writeUInt32LE(dirStart, 16);
    await this.rawWrite(eocd);
    this.offset += eocd.length;
    await new Promise<void>((resolve, reject) => this.out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (this.failure) throw this.failure;
    return this.offset;
  }

  /** Abandona el archivo a medias (error del proceso): cierra el descriptor sin escribir el directorio. */
  async abort(): Promise<void> {
    this.closed = true;
    await new Promise<void>((resolve) => this.out.end(() => resolve()));
  }
}
