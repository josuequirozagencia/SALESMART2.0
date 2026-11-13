import { describe, expect, it } from 'vitest';
import { parseEvolutionWebhook } from '../../src/modules/channels/evolution-webhook';
import { parseMetaWebhook, wrapMetaValue } from '../../src/modules/channels/meta-webhook';

// v13 S3.3 — Un mensaje entrante que CITA a otro lleva el identificador del citado (`replyToExternalId`), igual por Meta Cloud y por Evolution.
const NOW = new Date('2026-11-13T12:00:00.000Z');

const meta = (message: Record<string, unknown>) => parseMetaWebhook(wrapMetaValue({
  metadata: { phone_number_id: '1090123456789' },
  contacts: [{ profile: { name: 'Ana' }, wa_id: '593984217730' }],
  messages: [{ from: '593984217730', id: 'wamid.R1', timestamp: '1793143471', type: 'text', text: { body: 'Sí' }, ...message }],
}), NOW).events[0]!.event.messages[0]!;

const evolution = (message: Record<string, unknown>) => parseEvolutionWebhook({
  event: 'messages.upsert', instance: 'inst', data: { key: { remoteJid: '593990000002@s.whatsapp.net', fromMe: false, id: 'EV-R1' }, pushName: 'Ana', message, messageType: Object.keys(message)[0], messageTimestamp: 1793143471 },
}, NOW).events[0]!.event.messages[0]!;

describe('Meta Cloud: context.id', () => {
  it('un texto que responde a un mensaje trae el id del citado; sin contexto, nada', () => {
    expect(meta({ context: { from: '15550006789', id: 'wamid.CITADO' } }).replyToExternalId).toBe('wamid.CITADO');
    expect(meta({}).replyToExternalId).toBeUndefined();
    expect('replyToExternalId' in meta({})).toBe(false); // no aparece como clave vacía: los mensajes sin cita no cambian de forma
  });

  it('un contexto sin id (reenviado, producto) no es una cita', () => {
    expect(meta({ context: { forwarded: true } }).replyToExternalId).toBeUndefined();
    expect(meta({ context: { id: '' } }).replyToExternalId).toBeUndefined();
    expect(meta({ context: 'raro' }).replyToExternalId).toBeUndefined();
  });
});

describe('Evolution: contextInfo.stanzaId', () => {
  it('un texto extendido, una imagen y un audio que citan traen el id del citado', () => {
    expect(evolution({ extendedTextMessage: { text: 'Sí', contextInfo: { stanzaId: 'WAID-1', participant: '593990000001@s.whatsapp.net' } } }).replyToExternalId).toBe('WAID-1');
    expect(evolution({ imageMessage: { mimetype: 'image/jpeg', caption: 'mira', contextInfo: { stanzaId: 'WAID-2' } } }).replyToExternalId).toBe('WAID-2');
    expect(evolution({ audioMessage: { mimetype: 'audio/ogg', contextInfo: { stanzaId: 'WAID-3' } } }).replyToExternalId).toBe('WAID-3');
  });

  it('sin contextInfo o sin stanzaId no hay cita', () => {
    expect('replyToExternalId' in evolution({ conversation: 'Hola' })).toBe(false);
    expect('replyToExternalId' in evolution({ extendedTextMessage: { text: 'Hola', contextInfo: {} } })).toBe(false);
    expect('replyToExternalId' in evolution({ extendedTextMessage: { text: 'Hola', contextInfo: { stanzaId: '' } } })).toBe(false);
  });
});
