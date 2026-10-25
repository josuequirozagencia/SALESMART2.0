// M7.2 — Contrato de los avisos del Workflow de GoHighLevel (normalizador puro): qué se lee, qué se ignora y qué se rechaza.
import { describe, expect, it } from 'vitest';
import { DEDUPE_WINDOW_MS, MAX_TAGS, dedupeKeyOf, normalizeGhlPayload, type GhlEventPayload } from '../../src/modules/ghl/ghl-event';

const ok = (body: unknown): GhlEventPayload => {
  const r = normalizeGhlPayload(body);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { ok: true; event: GhlEventPayload }).event;
};
const bad = (body: unknown) => {
  const r = normalizeGhlPayload(body);
  expect(r.ok).toBe(false);
  return (r as { ok: false; issues: Array<{ path: string; code: string; message: string }> }).issues;
};

describe('normalizeGhlPayload · lo que entiende', () => {
  it('un cuerpo mínimo: solo el contacto; el tipo por omisión es «contact» y no inventa datos', () => {
    expect(ok({ contact_id: 'abc123' })).toEqual({ type: 'contact', ghlContactId: 'abc123', name: null, phone: null, phoneInvalid: false, email: null, tags: null, locationId: null, eventId: null });
  });

  it('nivel superior: nombre, teléfono, correo, etiquetas, Location y event_id', () => {
    const e = ok({ event: 'contact', event_id: 'wf-1', contact_id: 'C1', full_name: '  Ana Torres ', phone: '+593 98 421-7730', email: 'ANA@Correo.TEST', tags: 'vip, nuevo ,VIP', location: { id: 'LOC123456' } });
    expect(e).toMatchObject({ eventId: 'wf-1', ghlContactId: 'C1', name: 'Ana Torres', phone: '+593984217730', phoneInvalid: false, email: 'ana@correo.test', tags: ['vip', 'nuevo'], locationId: 'LOC123456' });
  });

  it('lee de customData y de contact cuando el nivel superior no lo trae; el nivel superior manda', () => {
    const e = ok({ customData: { contact_id: 'C9', full_name: 'Desde custom', email: 'c@x.test' }, contact: { phone: '+593984217730', name: 'Del contacto' }, full_name: 'Del nivel superior' });
    expect(e).toMatchObject({ ghlContactId: 'C9', name: 'Del nivel superior', phone: '+593984217730', email: 'c@x.test' });
  });

  it('acepta los nombres que usa GHL por omisión: contactId, first_name + last_name, location_id y etiquetas en lista', () => {
    expect(ok({ contactId: 'C2', first_name: 'Ana', last_name: 'Torres', location_id: 'LOC123456', tags: ['a', 'b'] })).toMatchObject({ ghlContactId: 'C2', name: 'Ana Torres', locationId: 'LOC123456', tags: ['a', 'b'] });
    expect(ok({ contact: { id: 'C3', firstName: 'Beto', lastName: 'Luna' } })).toMatchObject({ ghlContactId: 'C3', name: 'Beto Luna' });
  });

  it('el identificador numérico se toma como texto', () => {
    expect(ok({ contact_id: 12345 }).ghlContactId).toBe('12345');
  });

  it('ignora todo campo desconocido: no entra en el resultado', () => {
    const e = ok({ contact_id: 'C1', secret_note: 'no guardar', address1: 'Calle 1', attributionSource: { x: 1 }, workflow: { id: 'w' } });
    expect(JSON.stringify(e)).not.toContain('no guardar');
    expect(JSON.stringify(e)).not.toContain('Calle 1');
  });

  it('el mensaje entrante es un tipo reconocido (se procesará en M7.4)', () => {
    expect(ok({ event: 'message_in', contact_id: 'C1' }).type).toBe('message_in');
  });
});

describe('normalizeGhlPayload · datos sucios', () => {
  it('un teléfono sin formato internacional no se acepta pero se avisa (phoneInvalid)', () => {
    for (const phone of ['0984217730', '984217730', '+0123456789', '+59', 'llámame', '+593984217730999999']) {
      expect(ok({ contact_id: 'C1', phone }), phone).toMatchObject({ phone: null, phoneInvalid: true });
    }
    expect(ok({ contact_id: 'C1', phone: '(+593) 98-421.7730' }).phone).toBe('+593984217730');
  });

  it('un correo inválido o larguísimo se descarta sin romper el aviso', () => {
    for (const email of ['no-es-correo', 'a@b', 'con espacio@x.test', `${'a'.repeat(250)}@x.test`]) expect(ok({ contact_id: 'C1', email }).email, email).toBeNull();
  });

  it('quita caracteres de control y acota el nombre a 200', () => {
    expect(ok({ contact_id: 'C1', full_name: 'Ana\u0000\u0007\nTorres' }).name).toBe('Ana   Torres');
    expect(ok({ contact_id: 'C1', full_name: 'x'.repeat(500) }).name).toHaveLength(200);
  });

  it('etiquetas: sin repetidas (sin distinguir mayúsculas), acotadas a 100 caracteres y a un máximo', () => {
    expect(ok({ contact_id: 'C1', tags: Array.from({ length: 120 }, (_, i) => `t${i}`) }).tags).toHaveLength(MAX_TAGS);
    expect(ok({ contact_id: 'C1', tags: ['x'.repeat(300)] }).tags?.[0]).toHaveLength(100);
    expect(ok({ contact_id: 'C1', tags: [{ a: 1 }, null, 5, 'ok'] }).tags).toEqual(['5', 'ok']);
  });

  it('valores de tipo equivocado (objetos, listas, booleanos) no cuentan como texto', () => {
    expect(ok({ contact_id: 'C1', full_name: { x: 1 }, phone: ['+593984217730'], email: true })).toMatchObject({ name: null, phone: null, email: null, phoneInvalid: false });
  });
});

describe('normalizeGhlPayload · lo que rechaza (con el detalle para armar el Workflow)', () => {
  it('no es un objeto', () => {
    for (const body of [null, undefined, 'texto', 42, [], [{ contact_id: 'C1' }]]) expect(bad(body)[0]).toMatchObject({ path: 'body', code: 'invalid_type' });
  });

  it('sin identificador del contacto', () => {
    for (const body of [{}, { contact_id: '' }, { contact_id: '   ' }, { contact_id: { x: 1 } }, { name: 'Ana' }]) expect(bad(body), JSON.stringify(body)).toEqual([{ path: 'contact_id', code: 'required', message: expect.stringContaining('contact_id') }]);
  });

  it('identificador, event_id o tipo fuera de contrato', () => {
    expect(bad({ contact_id: 'x'.repeat(101) })[0]).toMatchObject({ path: 'contact_id', code: 'too_long' });
    expect(bad({ contact_id: 'C1', event_id: 'x'.repeat(101) })[0]).toMatchObject({ path: 'event_id', code: 'too_long' });
    expect(bad({ contact_id: 'C1', event: 'tag_added' })[0]).toMatchObject({ path: 'event', code: 'invalid_enum' });
  });

  it('los problemas nunca repiten datos personales del aviso', () => {
    const issues = bad({ event: 'otro', phone: '+593984217730', email: 'ana@x.test', full_name: 'Ana Torres' });
    expect(JSON.stringify(issues)).not.toMatch(/593984217730|ana@x\.test|Ana Torres/);
  });
});

describe('dedupeKeyOf', () => {
  const base = ok({ contact_id: 'C1', full_name: 'Ana', phone: '+593984217730' });
  const t0 = new Date('2026-10-24T12:00:00.000Z');

  it('con event_id usa ese: el mismo aviso en cualquier momento es el mismo', () => {
    const a = ok({ contact_id: 'C1', event_id: 'wf-9' });
    expect(dedupeKeyOf(a, t0)).toBe('id:wf-9');
    expect(dedupeKeyOf(a, new Date(t0.getTime() + 5 * DEDUPE_WINDOW_MS))).toBe('id:wf-9');
  });

  it('sin event_id, el mismo contenido en la misma ventana de 10 minutos es el mismo aviso; en otra ventana, otro', () => {
    const w = Math.floor(t0.getTime() / DEDUPE_WINDOW_MS) * DEDUPE_WINDOW_MS;
    expect(dedupeKeyOf(base, new Date(w + 1_000))).toBe(dedupeKeyOf(base, new Date(w + DEDUPE_WINDOW_MS - 1_000)));
    expect(dedupeKeyOf(base, new Date(w + 1_000))).not.toBe(dedupeKeyOf(base, new Date(w + DEDUPE_WINDOW_MS + 1_000)));
  });

  it('contenido distinto, clave distinta; el orden de las etiquetas no importa', () => {
    expect(dedupeKeyOf(base, t0)).not.toBe(dedupeKeyOf({ ...base, name: 'Otra' }, t0));
    expect(dedupeKeyOf({ ...base, tags: ['a', 'b'] }, t0)).toBe(dedupeKeyOf({ ...base, tags: ['b', 'a'] }, t0));
  });

  it('la clave nunca lleva datos personales en claro', () => {
    expect(dedupeKeyOf(base, t0)).toMatch(/^h:[0-9a-f]{64}$/);
  });
});
