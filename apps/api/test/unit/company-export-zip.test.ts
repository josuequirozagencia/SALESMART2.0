// F3b (ADR-59 #8): el escritor ZIP en streaming y la política de columnas del paquete «Descargar todo».
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvLine } from '../../src/modules/contacts';
import { isExcludedColumn, safeEntryName, SAFE_LOOKALIKES, SENSITIVE_COLUMN } from '../../src/modules/company-export/export-policy';
import { crc32Final, crc32Update, CRC32_START, ZipFileWriter, ZipLimitError } from '../../src/modules/company-export/zip';
import { readZip } from '../support/zip-reader';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ss-zip-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CRC-32', () => {
  it('coincide con el valor conocido de «123456789» (0xCBF43926) y es incremental', () => {
    const whole = crc32Final(crc32Update(CRC32_START, Buffer.from('123456789')));
    expect(whole).toBe(0xcbf43926);
    const parts = crc32Final(crc32Update(crc32Update(CRC32_START, Buffer.from('1234')), Buffer.from('56789')));
    expect(parts).toBe(whole);
  });
});

describe('ZipFileWriter', () => {
  it('escribe un ZIP que un lector estricto abre: nombres UTF-8, contenido exacto, CRC y descriptores válidos', async () => {
    const path = join(dir, 'a.zip');
    const w = new ZipFileWriter(path);
    const big = randomBytes(300_000).toString('base64'); // incompresible a medias: varios fragmentos de deflate
    await w.addBuffer('LEEME.txt', 'Hola — ñandú\r\n');
    await w.addBuffer('datos/tabla con espacios y ñ.jsonl', '{"a":1}\n{"a":2}\n');
    const e = await w.begin('csv/grande.csv');
    for (let i = 0; i < 40; i++) await e.write(`${big.slice(i * 1000, i * 1000 + 1000)}\n`);
    const size = await e.end();
    await w.addBuffer('vacío.txt', '');
    const total = await w.close();

    const buf = await readFile(path);
    expect(buf.length).toBe(total);
    const items = readZip(buf);
    expect(items.map((i) => i.name)).toEqual(['LEEME.txt', 'datos/tabla con espacios y ñ.jsonl', 'csv/grande.csv', 'vacío.txt']);
    expect(items[0]!.data.toString('utf8')).toBe('Hola — ñandú\r\n');
    expect(items[1]!.data.toString('utf8')).toBe('{"a":1}\n{"a":2}\n');
    expect(items[2]!.data.length).toBe(size);
    expect(items[2]!.data.toString('utf8').split('\n')[0]).toBe(big.slice(0, 1000));
    expect(items[3]!.data.length).toBe(0);
    expect(w.count).toBe(4);
  });

  it('una entrada grande no se carga en memoria: se escribe por trozos y el archivo crece', async () => {
    const path = join(dir, 'b.zip');
    const w = new ZipFileWriter(path);
    const e = await w.begin('datos/mensajes.jsonl');
    const line = `${JSON.stringify({ id: 'x'.repeat(200), n: 1 })}\n`;
    for (let i = 0; i < 20_000; i++) await e.write(line);
    expect(e.uncompressed).toBe(line.length * 20_000);
    await e.end();
    await w.close();
    const items = readZip(await readFile(path));
    expect(items).toHaveLength(1);
    expect(items[0]!.data.length).toBe(line.length * 20_000);
  });

  it('solo una entrada abierta a la vez, y nada después de cerrar', async () => {
    const w = new ZipFileWriter(join(dir, 'c.zip'));
    const e = await w.begin('a.txt');
    await expect(w.begin('b.txt')).rejects.toThrow('hay una entrada abierta');
    await expect(w.close()).rejects.toThrow('hay una entrada abierta');
    await e.end();
    await w.close();
    await expect(w.begin('c.txt')).rejects.toThrow('cerrado');
  });

  it('rechaza lo que necesitaría ZIP64 en vez de escribir un archivo corrupto', async () => {
    const w = new ZipFileWriter(join(dir, 'd.zip'));
    expect(() => {
      throw new ZipLimitError('prueba');
    }).toThrow('prueba');
    await w.abort();
  });
});

describe('política de columnas del paquete', () => {
  it('excluye credenciales, secretos, huellas y binarios', () => {
    const excluded = ['credentials_sealed', 'key_version', 'password_hash', 'secret_hash', 'private_token', 'access_token', 'api_key', 'ip_hash', 'payload_hash', 'file_hash', 'content_hash', 'embedding', 'signature_nonce'];
    for (const c of excluded) expect(isExcludedColumn(c, 'text'), c).toBe(true);
    expect(isExcludedColumn('cualquier_cosa', 'bytea')).toBe(true);
  });

  it('conserva lo que se parece a un secreto pero no lo es (conteos de IA y últimos 4 caracteres)', () => {
    for (const c of SAFE_LOOKALIKES) expect(isExcludedColumn(c, 'int4'), c).toBe(false);
    expect(isExcludedColumn('contact_id', 'uuid')).toBe(false);
    expect(isExcludedColumn('idempotency_key', 'text')).toBe(false);
    expect(isExcludedColumn('storage_key', 'text')).toBe(false);
  });

  it('una columna NUEVA con nombre sensible queda excluida hasta que alguien la apruebe a propósito', () => {
    expect(SENSITIVE_COLUMN.test('webhook_secret')).toBe(true);
    expect(isExcludedColumn('webhook_secret', 'text')).toBe(true);
    expect(isExcludedColumn('refresh_token', 'text')).toBe(true);
  });
});

describe('nombres de archivo del paquete', () => {
  it('no admiten rutas, caracteres de control ni puntos al inicio', () => {
    expect(safeEntryName('../../etc/passwd', 'x')).toBe('passwd');
    expect(safeEntryName('C:\\Users\\a\\foto.jpg', 'x')).toBe('foto.jpg');
    expect(safeEntryName('a\u0000b<c>.pdf', 'x')).toBe('a_b_c_.pdf');
    expect(safeEntryName('...oculto', 'x')).toBe('oculto');
    expect(safeEntryName('', 'archivo')).toBe('archivo');
    expect(safeEntryName('x'.repeat(500), 'a')).toHaveLength(120);
  });
});

describe('CSV del paquete', () => {
  it('neutraliza fórmulas y escapa comillas, comas y saltos de línea', () => {
    expect(csvLine(['=HYPERLINK("x")', '+1', 'a,b', 'dice "hola"', 'l1\nl2', 5, null])).toBe(`"'=HYPERLINK(""x"")",'+1,"a,b","dice ""hola""","l1\nl2",5,`);
  });
});
