// M3.5 — Lectura de filas de un CSV y escritura de CSV (ADR-47): código puro, sin base de datos.
import { describe, expect, it } from 'vitest';
import { csvCell, csvFile, csvLine } from '../../src/modules/contacts/csv';
import { cfValue, planRow, toE164 } from '../../src/modules/contacts/import-row';
import type { FieldType } from '../../src/modules/custom-fields/field-types';

const types = new Map<string, FieldType>([['ciudad', 'text'], ['vip', 'boolean'], ['horarios', 'multiselect'], ['edad', 'number']]);
const plan = (cells: string[], mapping: string[], prefix = '+593') => planRow(cells, mapping, prefix, types);

describe('teléfonos', () => {
  it('con «+» se respeta; sin él se antepone el prefijo del país y se quita el 0 de marcación nacional', () => {
    expect(toE164('+593 98 421 7730', '+57')).toBe('+593984217730');
    expect(toE164('098 421 7730', '+593')).toBe('+593984217730');
    expect(toE164('(098) 421-7730', '+593')).toBe('+593984217730');
    expect(toE164('3001234567', '+57')).toBe('+573001234567');
    expect(toE164('+34 612 345 678', '+593')).toBe('+34612345678');
  });
  it('rechaza lo que no tiene la forma de un E.164', () => {
    for (const bad of ['', '   ', 'abc', '123', '+12', '0', '+593', '12345678901234567']) expect(toE164(bad, '+593'), bad).toBeNull();
  });
});

describe('una fila', () => {
  const map = ['name', 'phone', 'email', 'ignore', 'cf:ciudad'];

  it('lee nombre, teléfono, correo y campos personalizados; ignora lo marcado como ignorar', () => {
    const p = plan(['  Ana Torres ', '098 421 7730', 'ANA@Correo.TEST', 'basura', ' Quito '], map);
    expect(p).toEqual({ name: 'Ana Torres', phones: ['+593984217730'], email: 'ana@correo.test', cf: { ciudad: 'Quito' }, errors: [] });
  });

  it('varios teléfonos en una celda (| ; /): el primero es el principal, sin repetidos, hasta 5; los inválidos se descartan si hay alguno bueno', () => {
    expect(plan(['', '098 421 7730 | 0991112233 ; 098 421 7730 / abc', '', '', ''], map).phones).toEqual(['+593984217730', '+593991112233']);
    expect(plan(['', Array.from({ length: 8 }, (_, i) => `09911122${30 + i}`).join('|'), '', '', ''], map).phones).toHaveLength(5);
  });

  it('motivos de rechazo: sin teléfono, teléfono inválido, correo inválido y nombre con caracteres de control', () => {
    expect(plan(['Ana', '', '', '', ''], map).errors).toEqual(['Falta el teléfono']);
    expect(plan(['Ana', '123', '', '', ''], map).errors).toEqual(['Teléfono no válido']);
    expect(plan(['Ana', '0984217730', 'sin-arroba', '', ''], map).errors).toEqual(['Correo no válido']);
    expect(plan(['A\u0000na', '0984217730', '', '', ''], map).errors).toEqual(['Nombre no válido']);
    expect(plan(['x'.repeat(201), '0984217730', '', '', ''], map).errors).toEqual(['Nombre no válido']);
    expect(plan(['', 'abc', 'malo', '', ''], map).errors).toEqual(['Correo no válido', 'Teléfono no válido']);
  });

  it('sin nombre ni correo la fila es válida (solo con teléfono)', () => {
    expect(plan(['', '0984217730', '', '', ''], map)).toMatchObject({ name: null, email: null, errors: [], phones: ['+593984217730'] });
  });

  it('una celda vacía de campo personalizado no cuenta; faltantes al final de la fila tampoco', () => {
    expect(plan(['Ana', '0984217730'], map)).toMatchObject({ cf: {}, errors: [] });
    expect(plan(['Ana', '0984217730', '', '', '   '], map).cf).toEqual({});
  });

  it('quita la comilla simple que la exportación antepone a lo que parecería una fórmula (para poder reimportar un archivo exportado)', () => {
    expect(plan(["Ana", "'+593984217730", '', '', ''], map).phones).toEqual(['+593984217730']);
    expect(plan(["'=Ana", '0984217730', '', '', ''], map).name).toBe('=Ana');
  });
});

describe('valores de campos personalizados', () => {
  it('se convierten según el tipo: Sí/No, listas, decimales con coma; lo que no se entiende pasa tal cual para que la validación lo rechace', () => {
    expect(cfValue('boolean', 'Sí')).toBe(true);
    expect(cfValue('boolean', ' no ')).toBe(false);
    expect(cfValue('boolean', 'tal vez')).toBe('tal vez');
    expect(cfValue('multiselect', 'Mañana | Tarde;Noche, ')).toEqual(['Mañana', 'Tarde', 'Noche, '.trim()]);
    expect(cfValue('number', '1500,5')).toBe('1500.5');
    expect(cfValue('text', '  x ')).toBe('x');
    expect(plan(['Ana', '0984217730', '', '', ''], ['name', 'phone', 'ignore', 'ignore', 'ignore'])).toMatchObject({ cf: {} });
    expect(planRow(['Ana', '0984217730', 'sí', 'Mañana|Tarde', '1,5'], ['name', 'phone', 'cf:vip', 'cf:horarios', 'cf:edad'], '+593', types).cf).toEqual({ vip: true, horarios: ['Mañana', 'Tarde'], edad: '1.5' });
  });
});

describe('escritura de CSV', () => {
  it('escapa comillas, comas y saltos de línea', () => {
    expect(csvCell('hola')).toBe('hola');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell('uno\ndos')).toBe('"uno\ndos"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(true)).toBe('true');
  });

  it('neutraliza la inyección de fórmulas en los TEXTOS que empiezan por = + - @ tabulación o retorno; los números no se tocan', () => {
    for (const s of ['=SUM(A1:A9)', '+593984217730', '-5', '@usuario', '\tx', '\rx']) expect(csvCell(s), JSON.stringify(s)).toMatch(/^"?'/);
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('Ana = Beto')).toBe('Ana = Beto'); // solo importa el primer carácter
    expect(csvCell('x=1')).toBe('x=1');
  });

  it('el archivo lleva BOM UTF-8 y líneas CRLF', () => {
    const f = csvFile([['Nombre', 'Teléfono'], ['Ana', '+593984217730']]);
    expect(f.startsWith('﻿')).toBe(true);
    expect(f).toBe("﻿Nombre,Teléfono\r\nAna,'+593984217730\r\n");
    expect(csvLine(['a', 'b,c'])).toBe('a,"b,c"');
  });
});
