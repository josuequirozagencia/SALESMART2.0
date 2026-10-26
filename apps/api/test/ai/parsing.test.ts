// M8.2 — Fragmentado y lectura de documentos (ADR-53). Funciones puras y lectores de PDF y Word sobre archivos hechos a mano.
import { describe, expect, it } from 'vitest';
import { chunkTable, chunkText, cleanText, MAX_CHUNK_CHARS, MAX_DOCUMENT_BYTES, MAX_TEXT_CHARS, TARGET_CHARS, decodeText, detectKind, normalize, parseCsv, parseDocument, ParseError } from '../../src/modules/ai';
import { makeDocx, makePdf } from './fixtures';

const para = (n: number, word = 'palabra'): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

describe('limpiar y fragmentar texto', () => {
  it('cleanText unifica saltos de línea, quita caracteres de control y colapsa espacios y líneas en blanco', () => {
    expect(cleanText('Hola\r\nmundo\u0000\u0007  con   espacios\t\ty\n\n\n\n\nfin  ')).toBe('Hola\nmundo con espacios y\n\nfin');
    expect(cleanText('   \n\n  ')).toBe('');
  });

  it('un texto corto es un solo fragmento; uno vacío, ninguno', () => {
    expect(chunkText('Abrimos de lunes a viernes de 9 a 18.')).toEqual(['Abrimos de lunes a viernes de 9 a 18.']);
    expect(chunkText('  \n ')).toEqual([]);
  });

  it('ningún fragmento pasa del máximo y los párrafos se agrupan hacia el tamaño objetivo', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Párrafo ${i}: ${para(30, `p${i}x`)}`).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c.length).toBeGreaterThan(0);
    }
    // todo el contenido está en algún fragmento
    for (let i = 0; i < 40; i++) expect(chunks.some((c) => c.includes(`Párrafo ${i}:`))).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.length >= TARGET_CHARS * 0.5)).toBe(true);
  });

  it('un párrafo larguísimo sin saltos se parte en pedazos dentro del máximo, sin perder palabras', () => {
    const long = para(1500, 'larga'); // ≈ 15 000 caracteres de una sola línea
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    const joined = chunks.join(' ');
    for (const i of [0, 700, 1499]) expect(joined).toContain(`larga${i}`);
  });

  it('una palabra sin espacios más larga que el máximo se corta a la fuerza', () => {
    const chunks = chunkText('x'.repeat(5000));
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('los fragmentos consecutivos de un texto seguido se solapan un poco', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sección ${i}. ${para(40, `s${i}w`)}`).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const lastWord = chunks[i - 1]!.split(/s+/).pop()!;
      expect(chunks[i]!.includes(lastWord), `el fragmento ${i} repite el final del anterior`).toBe(true);
    }
  });
});

describe('fragmentar una tabla', () => {
  const rows = [['Producto', 'Precio', 'Ciudad'], ['Corte', '10', 'Guayaquil'], ['Tinte', '35', ''], ['', '', ''], ['Peinado', '20', 'Quito']];

  it('cada fila se entiende sola: «Campo: valor» con el encabezado; las filas vacías y los valores vacíos se omiten', () => {
    expect(chunkTable(rows)).toEqual(['Producto: Corte; Precio: 10; Ciudad: Guayaquil\nProducto: Tinte; Precio: 35\nProducto: Peinado; Precio: 20; Ciudad: Quito']);
  });

  it('una tabla grande se reparte en varios fragmentos y no pierde filas', () => {
    const big = [['Nombre', 'Nota'], ...Array.from({ length: 300 }, (_, i) => [`Persona ${i}`, `Nota número ${i} con algo de texto`])];
    const chunks = chunkTable(big);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.join('\n').split('\n')).toHaveLength(300);
  });

  it('sin filas de datos no hay fragmentos; una columna sin nombre se llama «Columna N»', () => {
    expect(chunkTable([['A', 'B']])).toEqual([]);
    expect(chunkTable([])).toEqual([]);
    expect(chunkTable([['', 'B'], ['x', 'y']])).toEqual(['Columna 1: x; B: y']);
  });
});

describe('leer CSV', () => {
  it('comas, punto y coma y tabulador se deducen de la primera línea', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\tc\n1\t2\t3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('comillas: separadores y saltos de línea dentro de un campo, y comillas dobles escapadas', () => {
    expect(parseCsv('n,t\n"Pérez, Ana","dijo ""hola""\ny se fue"\nLuis,ok')).toEqual([['n', 't'], ['Pérez, Ana', 'dijo "hola"\ny se fue'], ['Luis', 'ok']]);
  });

  it('acepta \\r\\n, ignora líneas en blanco y la última línea sin salto', () => {
    expect(parseCsv('a,b\r\n1,2\r\n\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('demasiadas filas se rechazan', () => {
    const csv = `a\n${Array.from({ length: 50_010 }, (_, i) => String(i)).join('\n')}`;
    expect(() => parseCsv(csv)).toThrow(ParseError);
  });
});

describe('decodificar texto', () => {
  it('UTF-8 con y sin BOM; si no es UTF-8, Windows-1252 (Excel y Bloc de notas)', () => {
    expect(decodeText(Buffer.from('Atención: niño', 'utf8'))).toBe('Atención: niño');
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hola', 'utf8')]))).toBe('Hola');
    expect(decodeText(Buffer.from('Atención: niño', 'latin1'))).toBe('Atención: niño');
  });
});

describe('qué tipo de archivo es (por su contenido)', () => {
  it('PDF por su firma, DOCX por su ZIP y extensión, texto y CSV por extensión y sin bytes nulos', () => {
    expect(detectKind(makePdf('hola'), 'carta.pdf')).toBe('pdf');
    expect(detectKind(makePdf('hola'), null)).toBe('pdf');
    expect(detectKind(makeDocx('hola'), 'carta.docx')).toBe('docx');
    expect(detectKind(Buffer.from('hola'), 'notas.txt')).toBe('txt');
    expect(detectKind(Buffer.from('hola'), 'notas.md')).toBe('txt');
    expect(detectKind(Buffer.from('a,b\n1,2'), 'tabla.csv')).toBe('csv');
    expect(detectKind(Buffer.from('hola'), null)).toBe('txt');
  });

  it('lo que no corresponde se rechaza: extensión que no coincide con el contenido, ejecutables, binarios y archivos vacíos', () => {
    expect(detectKind(makePdf('hola'), 'carta.docx')).toBeNull(); // un PDF disfrazado
    expect(detectKind(makeDocx('hola'), 'carta.pdf')).toBeNull();
    expect(detectKind(makeDocx('hola'), 'carta.zip')).toBeNull();
    expect(detectKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'virus.txt')).toBeNull(); // «MZ…» con un nulo
    expect(detectKind(Buffer.from('texto'), 'foto.png')).toBeNull();
    expect(detectKind(Buffer.from('texto'), 'script.exe')).toBeNull();
    expect(detectKind(Buffer.alloc(0), 'vacio.txt')).toBeNull();
    expect(MAX_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('leer documentos completos', () => {
  it('TXT: fragmentos y caracteres', async () => {
    const r = await parseDocument('txt', Buffer.from('Abrimos de lunes a viernes.\n\nLos sábados hasta el mediodía.'));
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]).toContain('sábados');
    expect(r.chars).toBeGreaterThan(40);
  });

  it('CSV: una fila por línea con su encabezado', async () => {
    const r = await parseDocument('csv', Buffer.from('Producto;Precio\nCorte;10\nTinte;35', 'latin1'));
    expect(r.chunks).toEqual(['Producto: Corte; Precio: 10\nProducto: Tinte; Precio: 35']);
  });

  it('CSV sin filas de datos: error «empty»', async () => {
    await expect(parseDocument('csv', Buffer.from('Producto;Precio\n'))).rejects.toMatchObject({ code: 'empty' });
  });

  it('PDF con texto: lo extrae de todas las páginas', async () => {
    const r = await parseDocument('pdf', makePdf('Horario de atencion de lunes a viernes', 'Precios del corte y del tinte'));
    const all = r.chunks.join(' ');
    expect(all).toContain('Horario de atencion');
    expect(all).toContain('Precios del corte');
  });

  it('PDF sin texto (escaneado) o dañado: errores claros', async () => {
    await expect(parseDocument('pdf', makePdf(''))).rejects.toMatchObject({ code: 'empty', message: expect.stringContaining('escaneada') });
    await expect(parseDocument('pdf', Buffer.from('%PDF-1.4\nesto no es un pdf de verdad'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('DOCX: extrae los párrafos', async () => {
    const r = await parseDocument('docx', makeDocx('Política de devoluciones', 'Se aceptan hasta 30 días después de la compra'));
    const all = r.chunks.join(' ');
    expect(all).toContain('Política de devoluciones');
    expect(all).toContain('30 días');
  });

  it('DOCX dañado o sin texto: errores claros', async () => {
    await expect(parseDocument('docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('basura')]))).rejects.toMatchObject({ code: 'corrupt' });
    await expect(parseDocument('docx', makeDocx(''))).rejects.toMatchObject({ code: 'empty' });
  });

  it('un texto con más caracteres que el tope se rechaza', async () => {
    await expect(parseDocument('txt', Buffer.from(`${'palabra '.repeat(MAX_TEXT_CHARS / 8 + 100)}`))).rejects.toMatchObject({ code: 'too_long' });
  });
});

describe('normalizar vectores', () => {
  it('largo 1; un vector de ceros se deja igual', () => {
    const v = normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
