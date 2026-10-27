import { describe, expect, it } from 'vitest';
import { hostAllowed, isPublicAddress, normalizeAllowedHost, parseDestination } from '../../src/modules/automations/address-guard';
import { HTTP_VARIABLES, httpVariablesUsed, isJsonContainer, renderHttpBody, unknownHttpVariables } from '../../src/modules/automations/automation-model';

describe('direcciones IP: solo lo público pasa (regla de seguridad 10)', () => {
  it('IPv4 pública sí', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '198.17.255.255', '198.20.0.1']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('IPv4 privada, loopback, de enlace local, de metadatos, reservada o de multidifusión no', () => {
    for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.168.1.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('IPv6 pública sí', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('IPv6 no pública no: ::, ::1, único-local, enlace local, multidifusión, documentación, 6to4, Teredo y descarte', () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::abcd%eth0', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:c000:0204::1', '2001::1', '100::1', '::2']) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('una IPv4 escondida dentro de IPv6 se juzga como IPv4 (mapeada, NAT64)', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicAddress('::ffff:10.1.2.3')).toBe(false);
    expect(isPublicAddress('::ffff:7f00:1')).toBe(false); // 127.0.0.1 en hexadecimal
    expect(isPublicAddress('64:ff9b::8.8.8.8')).toBe(true);
    expect(isPublicAddress('64:ff9b::a00:1')).toBe(false); // 10.0.0.1
  });

  it('lo que no es una dirección o no se puede interpretar se rechaza', () => {
    for (const ip of ['', 'localhost', 'example.com', '999.1.1.1', '1.2.3', '1.2.3.4.5', '0x7f.0.0.1', '2130706433', '127.1', '::g', '1:2:3:4:5:6:7:8:9', ':::']) expect(isPublicAddress(ip), ip).toBe(false);
  });
});

describe('dominios de la lista de permitidos', () => {
  it('normaliza y acepta nombres de dominio (y comodín de subdominios)', () => {
    expect(normalizeAllowedHost(' Mi-Sistema.COM ')).toBe('mi-sistema.com');
    expect(normalizeAllowedHost('hooks.zapier.com.')).toBe('hooks.zapier.com');
    expect(normalizeAllowedHost('*.n8n.cloud')).toBe('*.n8n.cloud');
  });

  it('rechaza IP, localhost, esquemas, puertos, rutas, comodines mal puestos y nombres inválidos', () => {
    for (const h of ['', '8.8.8.8', '127.0.0.1', '[::1]', '::1', '1.2.3', 'localhost', 'https://mi-sistema.com', 'mi-sistema.com:8080', 'mi-sistema.com/ruta', '*', '*.com', 'a*.mi-sistema.com', 'mi-sistema.*', '.mi-sistema.com', 'mi sistema.com', 'mi-sistema', 'mi_sistema.com', '-mi.com', '*.*.mi.com', '*.8.8.8.8']) {
      expect(normalizeAllowedHost(h), JSON.stringify(h)).toBeNull();
    }
  });

  it('exacto o subdominio con comodín; el comodín nunca cubre el dominio base ni dominios parecidos', () => {
    const list = ['api.mi-sistema.com', '*.n8n.cloud'];
    expect(hostAllowed('api.mi-sistema.com', list)).toBe(true);
    expect(hostAllowed('API.Mi-Sistema.com', list)).toBe(true);
    expect(hostAllowed('mi-sistema.com', list)).toBe(false);
    expect(hostAllowed('otra.mi-sistema.com', list)).toBe(false);
    expect(hostAllowed('evil-api.mi-sistema.com', list)).toBe(false);
    expect(hostAllowed('api.mi-sistema.com.evil.com', list)).toBe(false);
    expect(hostAllowed('acme.n8n.cloud', list)).toBe(true);
    expect(hostAllowed('a.b.n8n.cloud', list)).toBe(true);
    expect(hostAllowed('n8n.cloud', list)).toBe(false);
    expect(hostAllowed('xn8n.cloud', list)).toBe(false);
    expect(hostAllowed('acme.n8n.cloud.evil.com', list)).toBe(false);
    expect(hostAllowed('acme.n8n.cloud', [])).toBe(false);
  });
});

describe('destinos: https, puerto 443, sin credenciales y con nombre de dominio', () => {
  it('acepta una dirección https con dominio', () => {
    const d = parseDestination('https://Hooks.Zapier.com/hooks/catch/123/abc?x=1');
    expect(d).toMatchObject({ ok: true, host: 'hooks.zapier.com' });
    expect(parseDestination('https://acme.n8n.cloud:443/webhook/x')).toMatchObject({ ok: true, host: 'acme.n8n.cloud' });
  });

  it('rechaza http, otros puertos, usuario o contraseña, IP (decimal, octal, hexadecimal, IPv6), localhost y dominios internos', () => {
    const bad = [
      'http://mi-sistema.com/x',
      'ftp://mi-sistema.com/x',
      'javascript:alert(1)',
      'https://mi-sistema.com:8443/x',
      'https://user:pass@mi-sistema.com/x',
      'https://user@mi-sistema.com/x',
      'https://127.0.0.1/x',
      'https://8.8.8.8/x',
      'https://2130706433/x',
      'https://0x7f.0.0.1/x',
      'https://0177.0.0.1/x',
      'https://127.1/x',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://localhost/x',
      'https://foo.localhost/x',
      'https://servidor/x',
      'https://mi.intranet.local/x',
      'https://metadata.google.internal/x',
      'no es una dirección',
      '',
      'https://' + 'a'.repeat(300) + '.com/x',
      'https://mi-sistema.com/' + 'a'.repeat(2000),
    ];
    for (const u of bad) expect(parseDestination(u).ok, u.slice(0, 60)).toBe(false);
  });
});

describe('cuerpo de la llamada: variables, escapado y JSON', () => {
  const vars = { nombre: 'Ana "la" Pérez', primer_nombre: 'Ana', correo: 'ana@ejemplo.com', telefono: '+593999999999', id: 'c-1' };

  it('cada variable se reemplaza por su valor escapado como JSON: un nombre con comillas o saltos no rompe ni inyecta nada', () => {
    const out = renderHttpBody('{"nombre": "{{nombre}}", "correo": "{{ correo }}", "tel": "{{TELEFONO}}", "id": "{{id}}"}', vars);
    expect(JSON.parse(out)).toEqual({ nombre: 'Ana "la" Pérez', correo: 'ana@ejemplo.com', tel: '+593999999999', id: 'c-1' });
    const evil = renderHttpBody('{"nombre": "{{nombre}}"}', { ...vars, nombre: 'x", "admin": true, "y": "\n\\' });
    expect(JSON.parse(evil)).toEqual({ nombre: 'x", "admin": true, "y": "\n\\' });
  });

  it('detecta variables desconocidas y las usadas', () => {
    expect(unknownHttpVariables('{"a": "{{nombre}}", "b": "{{password}}", "c": "{{ otra }}"}')).toEqual(['password', 'otra']);
    expect(httpVariablesUsed('{"a": "{{nombre}}", "b": "{{NOMBRE}}", "c": "{{id}}"}').sort()).toEqual(['id', 'nombre']);
    expect(HTTP_VARIABLES).toEqual(['nombre', 'primer_nombre', 'correo', 'telefono', 'id']);
  });

  it('un cuerpo solo vale si es un objeto o una lista JSON', () => {
    expect(isJsonContainer('{"a":1}')).toBe(true);
    expect(isJsonContainer('[1,2]')).toBe(true);
    for (const t of ['', 'texto', '123', '"x"', 'null', '{a:1}', '{"a":}']) expect(isJsonContainer(t), t).toBe(false);
  });
});
