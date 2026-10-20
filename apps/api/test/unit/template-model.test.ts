// M5.6a — Lo que se sabe de una plantilla sin hablar con Meta: variables, si se puede enviar, valores válidos y cómo se arman el texto y los datos de envío.
import { describe, expect, it } from 'vitest';
import { FAKE_TEMPLATES } from '../../src/modules/channels';
import type { NormalizedTemplate } from '../../src/modules/channels';
import { analyze, checkValue, componentsOf, fromRow, keysIn, prepare, renderedText, variablesOf } from '../../src/modules/templates/template-model';

const t = (name: string, language = 'es'): NormalizedTemplate => FAKE_TEMPLATES.find((x) => x.name === name && x.language === language)!;

describe('variables', () => {
  it('keysIn: distintas, en orden de aparición, con espacios dentro de las llaves y sin repetir', () => {
    expect(keysIn('Hola {{1}}, {{ 2 }} y otra vez {{1}} {{nombre}}')).toEqual(['1', '2', 'nombre']);
    expect(keysIn(null)).toEqual([]);
    expect(keysIn('sin variables {} {{}} { {1} }')).toEqual([]);
  });

  it('variablesOf: encabezado, cuerpo y botones de URL, con su id, su ejemplo y la posición del botón', () => {
    expect(variablesOf(t('bienvenida'))).toEqual([]);
    expect(variablesOf(t('recordatorio_cita')).map((v) => [v.id, v.part, v.example])).toEqual([['body:1', 'body', 'Ana'], ['body:2', 'body', 'viernes 24'], ['body:3', 'body', '10:00']]);
    expect(variablesOf(t('promo_corte'))).toEqual([
      { id: 'header:1', part: 'header', key: '1', buttonIndex: null, example: 'Ana' },
      { id: 'body:1', part: 'body', key: '1', buttonIndex: null, example: 'CORTE20' },
      { id: 'button:0:1', part: 'button', key: '1', buttonIndex: 0, example: null },
    ]);
    expect(variablesOf(t('seguimiento_nombrado')).map((v) => [v.id, v.example])).toEqual([['body:nombre', 'Ana'], ['body:servicio', 'corte y barba']]);
  });

  it('las posicionales salen de menor a mayor número aunque el texto las use en otro orden', () => {
    const x: NormalizedTemplate = { ...t('bienvenida'), body: { text: '{{3}} y {{1}} y {{2}}', examples: {} } };
    expect(variablesOf(x).map((v) => v.key)).toEqual(['1', '2', '3']);
  });
});

describe('analyze: qué se puede enviar y por qué no', () => {
  const why = (name: string) => analyze(t(name)).unsupportedReason;

  it('una aprobada de texto, con o sin variables y botones de respuesta, teléfono o URL, se puede enviar', () => {
    for (const n of ['bienvenida', 'recordatorio_cita', 'promo_corte', 'seguimiento_nombrado']) expect(analyze(t(n)), n).toMatchObject({ sendable: true, unsupportedReason: null });
    expect(analyze(t('recordatorio_cita')).bodyText).toBe('Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}.');
  });

  it('las que no están aprobadas dicen el estado en Meta (y el motivo del rechazo)', () => {
    expect(why('en_revision')).toBe('Meta todavía la está revisando');
    expect(why('rechazada_ejemplo')).toBe('Meta la rechazó: Contenido promocional en una plantilla que no es de marketing');
    expect(why('pausada_calidad')).toBe('Meta la pausó (suele ser por baja calidad)');
    expect(analyze({ ...t('bienvenida'), status: 'disabled' }).unsupportedReason).toBe('Meta la deshabilitó');
    expect(analyze({ ...t('bienvenida'), status: 'other' }).unsupportedReason).toBe('No está aprobada en Meta');
  });

  it('una aprobada con algo que no se envía desde aquí se lista con el motivo: encabezado con medio, autenticación, componentes extra, botones raros', () => {
    expect(why('catalogo_imagen')).toBe('Lleva una imagen en el encabezado: se podrá usar cuando estén los adjuntos');
    expect(why('codigo_acceso')).toBe('Es de autenticación (código de un solo uso): no se envía desde el Inbox');
    expect(analyze({ ...t('bienvenida'), unsupported: ['carousel'] }).unsupportedReason).toBe('Tiene partes que aún no se pueden enviar desde aquí (carousel)');
    expect(analyze({ ...t('bienvenida'), header: { format: 'other', text: null, examples: {} } }).unsupportedReason).toBe('Tiene un encabezado que aún no se puede enviar desde aquí');
    expect(analyze({ ...t('bienvenida'), header: { format: 'video', text: null, examples: {} } }).unsupportedReason).toContain('un video');
    expect(analyze({ ...t('bienvenida'), buttons: [{ type: 'other', text: 'Copiar', url: null, phone: null }] }).unsupportedReason).toBe('Tiene un botón que no se puede enviar desde aquí');
    expect(analyze({ ...t('bienvenida'), body: null }).unsupportedReason).toBe('No tiene cuerpo de mensaje');
    expect(analyze({ ...t('bienvenida'), header: { format: 'text', text: '{{1}} y {{2}}', examples: {} } }).unsupportedReason).toBe('El encabezado tiene más de una variable');
    expect(analyze({ ...t('bienvenida'), buttons: [{ type: 'url', text: 'Ver', url: 'https://x.example/{{1}}/{{2}}', phone: null }] }).unsupportedReason).toBe('Un botón de enlace tiene más de una variable');
  });
});

describe('checkValue: las reglas de Meta para un parámetro de texto', () => {
  it('acepta un texto normal (con acentos, números y emojis) y lo mide recortado', () => {
    for (const v of ['Ana', '  Ana  ', 'viernes 24 de octubre', 'Mañana 10:30 ☀️', 'a  b', 'tres   espacios']) expect(checkValue('body', v), v).toBeNull();
  });

  it('rechaza lo vacío, los saltos de línea y tabulaciones, los caracteres de control y 4 espacios seguidos', () => {
    expect(checkValue('body', '')).toBe('Escribe un valor');
    expect(checkValue('body', '   ')).toBe('Escribe un valor');
    expect(checkValue('body', 'a\nb')).toBe('No puede tener saltos de línea ni tabulaciones');
    expect(checkValue('body', 'a\tb')).toBe('No puede tener saltos de línea ni tabulaciones');
    expect(checkValue('body', 'a\u0007b')).toBe('Tiene caracteres no permitidos');
    expect(checkValue('body', 'a    b')).toBe('No puede tener más de 3 espacios seguidos');
  });

  it('el largo depende de dónde va: encabezado 60, cuerpo 1024, botón 500', () => {
    expect(checkValue('header', 'x'.repeat(60))).toBeNull();
    expect(checkValue('header', 'x'.repeat(61))).toBe('Usa como máximo 60 caracteres');
    expect(checkValue('body', 'x'.repeat(1024))).toBeNull();
    expect(checkValue('body', 'x'.repeat(1025))).toBe('Usa como máximo 1024 caracteres');
    expect(checkValue('button', 'x'.repeat(501))).toBe('Usa como máximo 500 caracteres');
  });
});

describe('prepare: texto armado y datos de envío', () => {
  const run = (name: string, params: Record<string, string>) => {
    const tpl = t(name);
    return prepare(tpl, variablesOf(tpl), params);
  };

  it('una sin variables va sin componentes', () => {
    const r = run('bienvenida', {});
    expect(r).toMatchObject({ ok: true, value: { send: [] } });
    if (r.ok) expect(renderedText(r.value.rendered)).toBe('Hola, gracias por escribirnos. Aquí estamos para ayudarte.\n\nBarbería Norte');
  });

  it('posicional: reemplaza cada variable, recorta los valores y manda los datos del cuerpo en orden', () => {
    const r = run('recordatorio_cita', { 'body:3': ' 10:00 ', 'body:1': 'Ana', 'body:2': 'viernes 24' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rendered.body).toBe('Hola Ana, te recordamos tu cita el viernes 24 a las 10:00.');
    expect(r.value.send).toEqual([{ type: 'body', subType: null, index: null, parameters: [{ name: null, text: 'Ana' }, { name: null, text: 'viernes 24' }, { name: null, text: '10:00' }] }]);
    expect(r.value.rendered.buttons.map((b) => b.text)).toEqual(['Confirmar', 'Reprogramar']);
  });

  it('encabezado de texto, cuerpo y botón de URL con variable: tres componentes y la URL ya resuelta', () => {
    const r = run('promo_corte', { 'header:1': 'Ana', 'body:1': 'CORTE20', 'button:0:1': 'ana-24' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rendered.header).toBe('Promo para Ana');
    expect(r.value.rendered.body).toBe('Este mes tu corte tiene 20% de descuento. Reserva con el código CORTE20.');
    expect(r.value.rendered.buttons).toEqual([{ type: 'url', text: 'Reservar', url: 'https://barberia.example/reservar/ana-24', phone: null }, { type: 'phone', text: 'Llamar', url: null, phone: '+593984217730' }]);
    expect(r.value.send).toEqual([
      { type: 'header', subType: null, index: null, parameters: [{ name: null, text: 'Ana' }] },
      { type: 'body', subType: null, index: null, parameters: [{ name: null, text: 'CORTE20' }] },
      { type: 'button', subType: 'url', index: 0, parameters: [{ name: null, text: 'ana-24' }] },
    ]);
  });

  it('con nombre: los datos del cuerpo llevan el nombre de su variable', () => {
    const r = run('seguimiento_nombrado', { 'body:nombre': 'Ana', 'body:servicio': 'el corte' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rendered.body).toBe('Hola Ana, ¿pudiste revisar la propuesta de el corte?');
    expect(r.value.send[0]!.parameters).toEqual([{ name: 'nombre', text: 'Ana' }, { name: 'servicio', text: 'el corte' }]);
  });

  it('exige justo las variables que pide: faltan, sobran o no valen, cada una con su campo', () => {
    const r = run('recordatorio_cita', { 'body:1': 'Ana', 'body:2': '', 'body:9': 'x', 'body:3': 'a\nb' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { path: 'params.body:9', message: 'La plantilla no tiene esta variable' },
      { path: 'params.body:2', message: 'Escribe un valor' },
      { path: 'params.body:3', message: 'No puede tener saltos de línea ni tabulaciones' },
    ]);
    const missing = run('recordatorio_cita', {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.map((e) => e.message)).toEqual(['Falta este dato', 'Falta este dato', 'Falta este dato']);
  });
});

describe('fila ⇄ plantilla', () => {
  it('lo que se guarda en `components` vuelve a ser la misma plantilla', () => {
    for (const x of FAKE_TEMPLATES) {
      const back = fromRow({ externalId: x.externalId, name: x.name, language: x.language, category: x.category, status: x.status, parameterFormat: x.parameterFormat, components: JSON.parse(JSON.stringify(componentsOf(x))) as Record<string, unknown>, rejectedReason: x.rejectedReason });
      expect(back, x.name).toEqual(x);
    }
  });
});
