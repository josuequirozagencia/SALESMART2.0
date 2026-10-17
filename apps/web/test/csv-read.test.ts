import { describe, expect, it } from 'vitest';
import { BATCH_ROWS, batchesOf, decodeBytes, detectDelimiter, guessTarget, readCsv, sha256Hex, splitCsv } from '../src/lib/csv-read';

const ok = (text: string) => {
  const r = readCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r.csv;
};
const err = (text: string): string => {
  const r = readCsv(text);
  if (r.ok) throw new Error('se esperaba un error');
  return r.error;
};

describe('lectura de CSV', () => {
  it('lee encabezados y filas; quita el BOM; acepta CRLF, LF y CR; ignora líneas en blanco y el salto final', () => {
    const csv = ok('\uFEFFNombre,Celular\r\nAna,0984217730\n\nBeto,0991112233\r\n');
    expect(csv.headers).toEqual(['Nombre', 'Celular']);
    expect(csv.rows).toEqual([['Ana', '0984217730'], ['Beto', '0991112233']]);
    expect(ok('a,b\r1,2\r3,4').rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('comillas: comas y saltos de línea dentro de comillas, «""» como comilla; una celda vacía entre comas cuenta', () => {
    expect(splitCsv('a,"b,c","d ""e"" f","g\nh",,i', ',')).toEqual([['a', 'b,c', 'd "e" f', 'g\nh', '', 'i']]);
    expect(splitCsv('"x"\n"y"', ',')).toEqual([['x'], ['y']]);
  });

  it('detecta el separador: punto y coma (Excel en español), tabulación o coma; ignora separadores entre comillas', () => {
    expect(detectDelimiter('Nombre;Celular;Correo\nAna;1;a@b.c')).toBe(';');
    expect(detectDelimiter('Nombre\tCelular\nAna\t1')).toBe('\t');
    expect(detectDelimiter('Nombre,Celular')).toBe(',');
    expect(detectDelimiter('"a;b;c",d')).toBe(',');
    expect(ok('Nombre;Celular\nAna;098 421 7730').rows).toEqual([['Ana', '098 421 7730']]);
  });

  it('completa las filas cortas, admite columnas vacías de más y rechaza celdas con datos de más', () => {
    expect(ok('a,b,c\n1\n2,3,4,,').rows).toEqual([['1', '', ''], ['2', '3', '4']]);
    expect(err('a,b\n1,2,3')).toMatch(/fila 2.*más celdas/i);
  });

  it('encabezados vacíos reciben un nombre; las columnas vacías al final se descartan', () => {
    expect(ok('Nombre,,Celular,,\nAna,x,1,,').headers).toEqual(['Nombre', 'Columna 2', 'Celular']);
  });

  it('valida los topes: vacío, sin filas, demasiadas filas o columnas, celdas largas', () => {
    expect(err('')).toMatch(/vacío/);
    expect(err('a,b')).toMatch(/solo tiene la fila de encabezados/);
    expect(err(`a\n${Array.from({ length: 5001 }, () => 'x').join('\n')}`)).toMatch(/5001 filas.*5000/);
    expect(err(`${Array.from({ length: 61 }, (_, i) => `c${i}`).join(',')}\n1`)).toMatch(/61 columnas/);
    expect(err(`a\n${'x'.repeat(1001)}`)).toMatch(/fila 2.*1000/);
    expect(readCsv(`a\n${Array.from({ length: 5000 }, () => 'x').join('\n')}`).ok).toBe(true);
  });

  it('decodifica UTF-8 y, si no lo es, Windows-1252 (Excel «ANSI»)', () => {
    expect(decodeBytes(new TextEncoder().encode('Mañana').buffer as ArrayBuffer)).toBe('Mañana');
    expect(decodeBytes(Uint8Array.from([0x4d, 0x61, 0xf1, 0x61, 0x6e, 0x61]).buffer)).toBe('Mañana');
  });

  it('la huella es el SHA-256 en hexadecimal del contenido', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('lotes', () => {
  it('parte en lotes de hasta 200 filas, numerados desde 1 y sin huecos', () => {
    const rows = Array.from({ length: 450 }, (_, i) => [`n${i}`]);
    const b = batchesOf(rows);
    expect(b.map((x) => [x.from, x.rows.length])).toEqual([[1, BATCH_ROWS], [201, BATCH_ROWS], [401, 50]]);
    expect(b.flatMap((x) => x.rows)).toEqual(rows);
  });

  it('también corta por tamaño (cuerpo máximo ~80 KB) aunque no se llegue a 200 filas', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ['x'.repeat(900), `${i}`]);
    const b = batchesOf(rows);
    expect(b.length).toBeGreaterThan(1);
    for (const x of b) expect(new TextEncoder().encode(JSON.stringify({ from: x.from, rows: x.rows })).length).toBeLessThan(90_000);
    expect(b.flatMap((x) => x.rows)).toEqual(rows);
    expect(b.map((x) => x.from)).toEqual(b.map((_, i) => 1 + b.slice(0, i).reduce((n, y) => n + y.rows.length, 0)));
  });
});

describe('destino sugerido', () => {
  const fields = [{ key: 'ciudad', name: 'Ciudad' }, { key: 'interes', name: 'Interés' }];
  it('reconoce nombre, teléfono y correo por el encabezado (sin tildes ni mayúsculas) y campos por su nombre', () => {
    const taken = new Set<string>();
    const g = (h: string) => { const t = guessTarget(h, fields, taken); if (t !== 'ignore') taken.add(t); return t; };
    expect(['Nombre', 'Celular', 'Correo electrónico', 'CIUDAD', 'interes', 'Notas'].map(g)).toEqual(['name', 'phone', 'email', 'cf:ciudad', 'cf:interes', 'ignore']);
  });
  it('no repite un destino ya tomado', () => {
    const taken = new Set<string>(['phone']);
    expect(guessTarget('Teléfono', fields, taken)).toBe('ignore');
  });
});
