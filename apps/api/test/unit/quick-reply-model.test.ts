import { describe, expect, it } from 'vitest';
import { customKeysIn, formatCustom, resolve, unknownVariables, variablesIn, type ResolveContext } from '../../src/modules/quick-replies/quick-reply-model';

const ctx = (o: Partial<ResolveContext> = {}): ResolveContext => ({ contactName: 'Marcela Paredes Vera', contactPhone: '+593987001234', agentName: 'Carolina Vera', orgName: 'Barbería Norte', custom: {}, ...o });

describe('variablesIn', () => {
  it('lista las variables sin repetir, en orden, en minúsculas y tolerando espacios', () => {
    expect(variablesIn('Hola {{primer_nombre}} {{ Mi_Nombre }} {{primer_nombre}} {{contact.ciudad}}')).toEqual(['primer_nombre', 'mi_nombre', 'contact.ciudad']);
  });
  it('ignora lo que no es una variable', () => {
    expect(variablesIn('Sin variables, {solo llaves} y {{}} y {{ con espacio }} y {{a-b}}')).toEqual([]);
  });
});

describe('unknownVariables', () => {
  const active = new Set(['ciudad', 'plan']);
  it('acepta las de la casa y los campos personalizados vigentes', () => {
    expect(unknownVariables('{{primer_nombre}} {{nombre}} {{telefono}} {{mi_nombre}} {{empresa}} {{contact.ciudad}} {{contact.plan}}', active)).toEqual([]);
  });
  it('rechaza las desconocidas, los campos archivados y los que se escriben sin su prefijo', () => {
    expect(unknownVariables('{{foo}} {{contact.zona}} {{ciudad}} {{contact.Ciudad}} {{contact.}}', active)).toEqual(['foo', 'contact.zona', 'ciudad', 'contact.']);
  });
});

describe('resolve', () => {
  it('resuelve las variables de la casa', () => {
    const r = resolve('Hola {{primer_nombre}} ({{nombre}}), soy {{mi_nombre}} de {{empresa}}. Tu número: {{telefono}}', ctx());
    expect(r).toEqual({ text: 'Hola Marcela (Marcela Paredes Vera), soy Carolina Vera de Barbería Norte. Tu número: +593987001234', missing: [] });
  });
  it('resuelve campos personalizados con su formato (fecha, Sí/No, lista, número)', () => {
    const r = resolve('{{contact.ciudad}}|{{contact.nacimiento}}|{{contact.activo}}|{{contact.servicios}}|{{contact.edad}}', ctx({ custom: { ciudad: 'Quito', nacimiento: '1990-05-17', activo: false, servicios: ['Corte', 'Barba'], edad: 34 } }));
    expect(r.text).toBe('Quito|17/05/1990|No|Corte, Barba|34');
    expect(r.missing).toEqual([]);
  });
  it('lo que no se puede resolver queda tal cual y se avisa una sola vez', () => {
    const r = resolve('{{contact.ciudad}} {{contact.ciudad}} {{telefono}} {{foo}} {{primer_nombre}}', ctx({ contactPhone: null, contactName: '   ', custom: {} }));
    expect(r.text).toBe('{{contact.ciudad}} {{contact.ciudad}} {{telefono}} {{foo}} {{primer_nombre}}');
    expect(r.missing).toEqual(['contact.ciudad', 'telefono', 'foo', 'primer_nombre']);
  });
  it('un valor vacío o de puros espacios cuenta como faltante', () => {
    const r = resolve('{{contact.ciudad}}', ctx({ custom: { ciudad: '   ' } }));
    expect(r).toEqual({ text: '{{contact.ciudad}}', missing: ['contact.ciudad'] });
  });
  it('resuelve en una sola pasada: lo que contiene un valor no se vuelve a interpretar', () => {
    const r = resolve('Hola {{nombre}}', ctx({ contactName: '{{mi_nombre}}' }));
    expect(r.text).toBe('Hola {{mi_nombre}}');
  });
  it('respeta saltos de línea y el resto del texto, y no cambia mayúsculas del nombre', () => {
    const r = resolve('Línea 1\n{{ Primer_Nombre }}!\r\n$& $1 {{nombre}}', ctx({ contactName: 'Ana $& María' }));
    expect(r.text).toBe('Línea 1\nAna!\r\n$& $1 Ana $& María');
  });
  it('un texto sin variables queda igual', () => {
    expect(resolve('Gracias por escribirnos', ctx())).toEqual({ text: 'Gracias por escribirnos', missing: [] });
  });
});

describe('formatCustom y customKeysIn', () => {
  it('formatea cada tipo de valor', () => {
    expect(formatCustom(true)).toBe('Sí');
    expect(formatCustom(false)).toBe('No');
    expect(formatCustom(['a', 'b'])).toBe('a, b');
    expect(formatCustom(12.5)).toBe('12.5');
    expect(formatCustom('2026-10-05')).toBe('05/10/2026');
    expect(formatCustom('2026-10-05T10:00:00Z')).toBe('2026-10-05T10:00:00Z');
    expect(formatCustom('texto')).toBe('texto');
  });
  it('extrae solo las claves de campos personalizados', () => {
    expect(customKeysIn('{{nombre}} {{contact.ciudad}} {{contact.plan}} {{contact.ciudad}}')).toEqual(['ciudad', 'plan']);
  });
});
