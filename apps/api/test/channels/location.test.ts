import { describe, expect, it } from 'vitest';
import { parseEvolutionWebhook } from '../../src/modules/channels/evolution-webhook';
import { readLocation } from '../../src/modules/channels/location';
import { parseMetaWebhook, wrapMetaValue } from '../../src/modules/channels/meta-webhook';

// v13 S3.2 — Ubicación entrante normalizada y validada, igual por Meta Cloud y por Evolution.
const NOW = new Date('2026-11-13T12:00:00.000Z');

describe('readLocation', () => {
  it('acepta coordenadas en rango y limpia nombre y dirección', () => {
    expect(readLocation(-2.17, -79.92, '  Oficina \n Centro ', 'Av. 9 de Octubre')).toEqual({ latitude: -2.17, longitude: -79.92, name: 'Oficina Centro', address: 'Av. 9 de Octubre' });
    expect(readLocation(0, 0, null, undefined)).toEqual({ latitude: 0, longitude: 0, name: null, address: null });
    expect(readLocation(90, 180, '', '   ')).toEqual({ latitude: 90, longitude: 180, name: null, address: null });
    expect(readLocation(-90, -180, 'x', 'y')).toMatchObject({ latitude: -90, longitude: -180 });
  });

  it('rechaza lo que no es una coordenada válida: fuera de rango, no numérico o no finito', () => {
    for (const [lat, lng] of [[91, 0], [-90.0001, 0], [0, 180.5], [0, -181], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY], ['-2.1', '-79.9'], [null, 3], [undefined, undefined]] as const) {
      expect(readLocation(lat, lng, 'n', 'a'), `${String(lat)},${String(lng)}`).toBeNull();
    }
  });

  it('acota el largo del nombre (200) y de la dirección (300)', () => {
    const l = readLocation(1, 1, 'n'.repeat(500), 'a'.repeat(500))!;
    expect(l.name).toHaveLength(200);
    expect(l.address).toHaveLength(300);
  });
});

describe('lectores de proveedores', () => {
  const meta = (location: Record<string, unknown>) => parseMetaWebhook(wrapMetaValue({
    metadata: { phone_number_id: '1090123456789' },
    contacts: [{ profile: { name: 'Ana' }, wa_id: '593984217730' }],
    messages: [{ from: '593984217730', id: 'wamid.LOC1', timestamp: '1793143471', type: 'location', location }],
  }), NOW).events[0]!.event.messages[0]!;
  const evolution = (locationMessage: Record<string, unknown>) => parseEvolutionWebhook({
    event: 'messages.upsert', instance: 'inst', data: { key: { remoteJid: '593990000002@s.whatsapp.net', fromMe: false, id: 'LOC-1' }, pushName: 'Ana', message: { locationMessage }, messageType: 'locationMessage', messageTimestamp: 1793143471 },
  }, NOW).events[0]!.event.messages[0]!;

  it('Meta Cloud: una ubicación válida llega como kind «location» con sus datos', () => {
    expect(meta({ latitude: -2.17, longitude: -79.92, name: 'Local', address: 'Av. 9 de Octubre' })).toMatchObject({ kind: 'location', extra: { location: { latitude: -2.17, longitude: -79.92, name: 'Local', address: 'Av. 9 de Octubre' } } });
  });

  it('Meta Cloud: coordenadas fuera de rango o ausentes → sigue siendo «location» pero sin datos de ubicación', () => {
    expect(meta({ latitude: 200, longitude: 10 })).toMatchObject({ kind: 'location', extra: {} });
    expect(meta({ name: 'Sin coordenadas' })).toMatchObject({ kind: 'location', extra: {} });
  });

  it('Evolution: una ubicación válida y una fuera de rango', () => {
    expect(evolution({ degreesLatitude: -2.17, degreesLongitude: -79.92, name: 'Oficina', address: 'Centro' })).toMatchObject({ kind: 'location', extra: { location: { latitude: -2.17, longitude: -79.92, name: 'Oficina', address: 'Centro' } } });
    expect(evolution({ degreesLatitude: -2.17, degreesLongitude: -279.92 })).toMatchObject({ kind: 'location', extra: {} });
  });
});
