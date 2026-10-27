// M9.1 — Modelo puro de formularios (ADR-09/54): estructura válida, validación de un envío y dominios autorizados. Sin base de datos.
import { describe, expect, it } from 'vitest';
import { cleanUrl, cleanUtm, hostOfOrigin, keyFromLabel, normalizeDomain, normalizeDomains, originAllowed, validateStructure, validateSubmission, type FieldSpec } from '../../src/modules/forms';

const f = (over: Partial<FieldSpec> & Pick<FieldSpec, 'key' | 'kind' | 'mapsTo'>): FieldSpec => ({ label: over.key.toUpperCase(), required: false, options: null, placeholder: null, ...over });
const BASE: FieldSpec[] = [f({ key: 'nombre', kind: 'text', mapsTo: 'name', required: true }), f({ key: 'whatsapp', kind: 'phone', mapsTo: 'phone', required: true }), f({ key: 'correo', kind: 'email', mapsTo: 'email' })];
const codes = (fields: FieldSpec[]): string[] => validateStructure(fields).map((i) => i.code);

describe('estructura del formulario', () => {
  it('la base (nombre, WhatsApp y correo opcional) es válida', () => {
    expect(validateStructure(BASE)).toEqual([]);
  });

  it('exige exactamente un nombre y un teléfono, ambos obligatorios', () => {
    expect(codes(BASE.filter((x) => x.mapsTo !== 'phone'))).toContain('needs_phone');
    expect(codes(BASE.filter((x) => x.mapsTo !== 'name'))).toContain('needs_name');
    expect(codes([...BASE, f({ key: 'otro_tel', kind: 'phone', mapsTo: 'phone', required: true })])).toContain('needs_phone');
    expect(codes(BASE.map((x) => (x.mapsTo === 'phone' ? { ...x, required: false } : x)))).toContain('required_field');
    expect(codes(BASE.map((x) => (x.mapsTo === 'name' ? { ...x, required: false } : x)))).toContain('required_field');
  });

  it('el tipo debe ser coherente con el destino', () => {
    expect(codes(BASE.map((x) => (x.mapsTo === 'phone' ? { ...x, kind: 'text' as const } : x)))).toContain('kind_mismatch');
    expect(codes(BASE.map((x) => (x.mapsTo === 'email' ? { ...x, kind: 'text' as const } : x)))).toContain('kind_mismatch');
    expect(codes([...BASE, f({ key: 'extra_tel', kind: 'phone', mapsTo: 'note' })])).toContain('kind_mismatch');
  });

  it('claves únicas, opciones solo en selección, un solo correo y un campo personalizado no se llena dos veces', () => {
    expect(codes([...BASE, f({ key: 'nombre', kind: 'text', mapsTo: 'note' })])).toContain('duplicate');
    expect(codes([...BASE, f({ key: 'sel', kind: 'select', mapsTo: 'note' })])).toContain('invalid_options');
    expect(codes([...BASE, f({ key: 'sel', kind: 'select', mapsTo: 'note', options: ['A', 'a'] })])).toContain('duplicate');
    expect(codes([...BASE, f({ key: 'txt', kind: 'text', mapsTo: 'note', options: ['A'] })])).toContain('invalid_options');
    expect(codes([...BASE, f({ key: 'mail2', kind: 'email', mapsTo: 'email' })])).toContain('duplicate_email');
    expect(codes([...BASE, f({ key: 'c1', kind: 'text', mapsTo: 'custom:ciudad' }), f({ key: 'c2', kind: 'text', mapsTo: 'custom:ciudad' })])).toContain('duplicate_target');
    expect(validateStructure([...BASE, f({ key: 'sel', kind: 'select', mapsTo: 'note', options: ['A', 'B'] })])).toEqual([]);
  });

  it('entre 1 y 30 campos', () => {
    expect(codes([])).toContain('invalid_count');
    const many = Array.from({ length: 31 }, (_, i) => f({ key: `c${i}`, kind: 'text', mapsTo: 'note' }));
    expect(codes([...BASE, ...many])).toContain('invalid_count');
  });

  it('keyFromLabel arma una clave estable, sin acentos y única', () => {
    expect(keyFromLabel('Correo electrónico', new Set())).toBe('correo_electronico');
    expect(keyFromLabel('¿Cuál es tu ciudad?', new Set())).toBe('cual_es_tu_ciudad');
    expect(keyFromLabel('123', new Set())).toBe('campo');
    expect(keyFromLabel('Nombre', new Set(['nombre']))).toBe('nombre_2');
    expect(keyFromLabel('Nombre', new Set(['nombre', 'nombre_2']))).toBe('nombre_3');
  });
});

describe('validación de un envío', () => {
  const fields: FieldSpec[] = [
    ...BASE,
    f({ key: 'interes', kind: 'select', mapsTo: 'custom:interes', options: ['Curso de Uñas', 'Curso de Pestañas'], required: true }),
    f({ key: 'edad', kind: 'number', mapsTo: 'custom:edad' }),
    f({ key: 'mensaje', kind: 'long_text', mapsTo: 'note' }),
  ];
  const ok = { nombre: ' Lucía  Paredes ', whatsapp: '0984217730', correo: 'LUCIA@Example.com', interes: 'curso de uñas', edad: '29', mensaje: 'Hola\n\nquiero info' };

  it('normaliza: nombre en una línea, teléfono E.164 con el prefijo del formulario, correo en minúsculas, opción con su mayúscula y número', () => {
    const r = validateSubmission(fields, ok, '+593');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.submission).toMatchObject({ name: 'Lucía Paredes', phone: '+593984217730', email: 'lucia@example.com', custom: { interes: 'Curso de Uñas', edad: 29 } });
    expect(r.submission.clean['mensaje']).toBe('Hola\n\nquiero info');
  });

  it('un teléfono con código de país no usa el prefijo; otro prefijo cambia el resultado', () => {
    const a = validateSubmission(fields, { ...ok, whatsapp: '+57 300 123 4567' }, '+593');
    const b = validateSubmission(fields, { ...ok, whatsapp: '300 123 4567' }, '+57');
    expect(a.ok && a.submission.phone).toBe('+573001234567');
    expect(b.ok && b.submission.phone).toBe('+573001234567');
  });

  it('los obligatorios deben venir; los opcionales vacíos se omiten; lo desconocido se ignora', () => {
    const r = validateSubmission(fields, { nombre: '', whatsapp: ' ', interes: '', extra: 'x' }, '+593');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path).sort()).toEqual(['values.interes', 'values.nombre', 'values.whatsapp']);
    const fine = validateSubmission(fields, { nombre: 'Ana', whatsapp: '0984217730', interes: 'Curso de Pestañas', correo: '', edad: '', extra: 'x' }, '+593');
    expect(fine.ok).toBe(true);
    if (fine.ok) expect(Object.keys(fine.submission.clean).sort()).toEqual(['interes', 'nombre', 'whatsapp']);
  });

  it('rechaza correo, teléfono, número y opción inválidos con su campo', () => {
    const r = validateSubmission(fields, { ...ok, correo: 'no-es-correo', whatsapp: '12', edad: 'abc', interes: 'Otro' }, '+593');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code).sort()).toEqual(['invalid_email', 'invalid_number', 'invalid_option', 'invalid_phone']);
  });

  it('los valores que no son texto ni número se rechazan y los caracteres de control no pasan', () => {
    const bad = validateSubmission(fields, { ...ok, nombre: { x: 1 } as unknown as string }, '+593');
    expect(bad.ok).toBe(false);
    const ctrl = validateSubmission(fields, { ...ok, nombre: 'Ana\u0000\u0007 Díaz\n' }, '+593');
    expect(ctrl.ok && ctrl.submission.name).toBe('Ana Díaz');
  });
});

describe('dominios autorizados', () => {
  it('normaliza lo que escribe la persona y descarta lo que no es un dominio', () => {
    expect(normalizeDomain('https://www.Mi-Sitio.com/pagina?x=1')).toBe('www.mi-sitio.com');
    expect(normalizeDomain('  *.Promo.test ')).toBe('*.promo.test');
    expect(normalizeDomain('localhost:5173')).toBe('localhost');
    expect(normalizeDomain('mi-sitio.com.')).toBe('mi-sitio.com');
    for (const bad of ['', 'sin punto', 'a..com', '-x.com', 'https://', '*.', '*', 'javascript:alert(1)', 'x.c']) expect(normalizeDomain(bad), bad).toBeNull();
    expect(normalizeDomains(['A.com', 'a.com', 'https://a.com/x', 'roto roto'])).toEqual({ ok: ['a.com'], bad: ['roto roto'] });
  });

  it('el origen debe coincidir con el dominio exacto; con «*.» también sus subdominios, no el dominio base; sin dominios no entra nadie', () => {
    const allowed = ['landing.test', '*.promo.test'];
    expect(originAllowed('https://landing.test', allowed)).toBe(true);
    expect(originAllowed('https://landing.test:8443', allowed)).toBe(true); // el puerto no cuenta
    expect(originAllowed('http://landing.test', allowed)).toBe(true);
    expect(originAllowed('https://a.promo.test', allowed)).toBe(true);
    expect(originAllowed('https://a.b.promo.test', allowed)).toBe(true);
    expect(originAllowed('https://promo.test', allowed)).toBe(false);
    expect(originAllowed('https://evil-landing.test', allowed)).toBe(false);
    expect(originAllowed('https://landing.test.evil.com', allowed)).toBe(false);
    expect(originAllowed('https://xpromo.test', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
    expect(originAllowed('file:///x', allowed)).toBe(false);
    expect(originAllowed('https://landing.test', [])).toBe(false);
    expect(hostOfOrigin('https://Landing.TEST/')).toBe('landing.test');
    expect(hostOfOrigin('basura')).toBeNull();
  });
});

describe('datos de seguimiento', () => {
  it('solo se guardan utm_*, fbclid y gclid, acotados y en una línea', () => {
    expect(cleanUtm({ utm_source: 'fb', UTM_Campaign: 'a\nb', fbclid: 'abc', gclid: 'g', password: 'x', utm_: 'no', ['utm_' + 'x'.repeat(40)]: 'no' })).toEqual({ utm_source: 'fb', utm_campaign: 'a b', fbclid: 'abc', gclid: 'g' });
    expect(Object.keys(cleanUtm(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`utm_k${i}`, 'v'])))).length).toBe(10);
    expect(cleanUtm(undefined)).toEqual({});
  });
  it('la página de origen debe ser http(s)', () => {
    expect(cleanUrl('https://landing.test/oferta?x=1')).toBe('https://landing.test/oferta?x=1');
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(cleanUrl('no es url')).toBeNull();
    expect(cleanUrl(undefined)).toBeNull();
  });
});
