import { describe, expect, it } from 'vitest';
import { parseEvolutionWebhook, phoneFromJid, redactEvolutionPayload, verifyEvolutionToken } from '../../src/modules/channels/evolution-webhook';

/**
 * Los avisos de abajo reproducen la FORMA de los eventos reales que capturó el spike del 2026-10-27 (Evolution v2.3.7, `spikes/whatsapp-qr/INFORME.md`), con teléfonos, nombres,
 * claves y archivos sustituidos por datos de ejemplo. Los campos de protobuf que no se usan (hashes, claves de medios, `messageContextInfo`…) se omiten.
 */
const NOW = new Date('2026-10-27T18:00:00.000Z');
const CHIP = '593990000001';
const CLIENT = '593990000002';
const SECRETS = { destination: 'http://receptor.interno:4000/hook?token=TOKEN-SECRETO-0123456789', apikey: 'APIKEY-SECRETA-0123456789', server_url: 'https://evolution.ejemplo.com', date_time: '2026-10-27T15:00:00.000Z', sender: `${CHIP}@s.whatsapp.net` };
const evt = (event: string, data: unknown, extra: Record<string, unknown> = {}) => ({ event, instance: 'spike-test', data, ...SECRETS, ...extra });
const key = (id: string, over: Record<string, unknown> = {}) => ({ remoteJid: `${CLIENT}@s.whatsapp.net`, remoteJidAlt: `${CLIENT}@s.whatsapp.net`, fromMe: false, id, participant: '', addressingMode: 'lid', ...over });
const upsert = (id: string, message: Record<string, unknown>, over: Record<string, unknown> = {}, keyOver: Record<string, unknown> = {}) =>
  evt('messages.upsert', { key: key(id, keyOver), pushName: 'Cliente Prueba', status: 'DELIVERY_ACK', message, messageType: Object.keys(message)[0], messageTimestamp: 1793143471, instanceId: 'i-1', source: 'android', ...over });

describe('mensajes entrantes (messages.upsert)', () => {
  it('un texto: id, teléfono E.164, nombre del perfil y hora del mensaje', () => {
    const p = parseEvolutionWebhook(upsert('3A5DDA30C62991A6C847', { conversation: 'Hola' }), NOW);
    expect(p.instance).toBe('spike-test');
    expect(p.ignored).toBe(0);
    expect(p.events).toHaveLength(1);
    const m = p.events[0]!.event;
    expect(m.phoneNumberId).toBe('spike-test');
    expect(m.messages).toEqual([{ externalId: '3A5DDA30C62991A6C847', from: `+${CLIENT}`, fromRaw: `${CLIENT}@s.whatsapp.net`, profileName: 'Cliente Prueba', kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date(1793143471 * 1000) }]);
  });

  it('un texto largo o con cita llega como extendedTextMessage', () => {
    const p = parseEvolutionWebhook(upsert('ID-EXT-0000000001', { extendedTextMessage: { text: 'Te respondo esto', contextInfo: { stanzaId: 'ORIGINAL-1', quotedMessage: { conversation: 'texto citado' } } } }), NOW);
    expect(p.events[0]!.event.messages[0]).toMatchObject({ kind: 'text', text: 'Te respondo esto' });
  });

  it('una imagen: tipo, pie, mimetype y el archivo SEPARADO del evento (no se guarda dentro del aviso)', () => {
    const b64 = 'A'.repeat(5000);
    const p = parseEvolutionWebhook(upsert('IMG-0000000000000001', { imageMessage: { url: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg', caption: 'mira esto', fileLength: { low: 3750 } }, base64: b64 }), NOW);
    const msg = p.events[0]!.event.messages[0]!;
    expect(msg).toMatchObject({ kind: 'image', text: 'mira esto', media: { id: 'IMG-0000000000000001', mimeType: 'image/jpeg', filename: null } });
    expect(p.inlineMedia.get('IMG-0000000000000001')).toBe(b64);
    expect(JSON.stringify(p.events[0]!.raw)).not.toContain(b64);
    expect(JSON.stringify(p.events[0]!.raw)).toContain('[archivo: 5000 caracteres]');
  });

  it('una nota de voz: audio con segundos y marca de nota de voz', () => {
    const p = parseEvolutionWebhook(upsert('AUD-0000000000000001', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 3, ptt: true, fileLength: { low: 7637 } }, base64: 'T2dn' }), NOW);
    expect(p.events[0]!.event.messages[0]).toMatchObject({ kind: 'audio', text: null, media: { mimeType: 'audio/ogg; codecs=opus' }, extra: { seconds: 3, voice_note: true } });
    expect(p.inlineMedia.has('AUD-0000000000000001')).toBe(true);
  });

  it('un documento: nombre del archivo, páginas y mimetype', () => {
    const p = parseEvolutionWebhook(upsert('DOC-0000000000000001', { documentMessage: { mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', title: 'Propuesta', fileName: 'Propuesta.docx', pageCount: 1 }, base64: 'UEsD' }), NOW);
    expect(p.events[0]!.event.messages[0]).toMatchObject({ kind: 'document', media: { filename: 'Propuesta.docx' }, extra: { pages: 1 } });
  });

  it('un sticker animado y un video', () => {
    const s = parseEvolutionWebhook(upsert('STK-0000000000000001', { stickerMessage: { mimetype: 'image/webp', isAnimated: true }, base64: 'UklG' }), NOW);
    expect(s.events[0]!.event.messages[0]).toMatchObject({ kind: 'sticker', extra: { animated: true } });
    const v = parseEvolutionWebhook(upsert('VID-0000000000000001', { videoMessage: { mimetype: 'video/mp4', caption: 'video', seconds: 12 }, base64: 'AAAA' }), NOW);
    expect(v.events[0]!.event.messages[0]).toMatchObject({ kind: 'video', text: 'video', extra: { seconds: 12 } });
  });

  it('ubicación, contactos y respuestas a botones; lo demás llega como «unsupported»', () => {
    const loc = parseEvolutionWebhook(upsert('LOC-0000000000000001', { locationMessage: { degreesLatitude: -2.17, degreesLongitude: -79.92, name: 'Oficina' } }), NOW);
    expect(loc.events[0]!.event.messages[0]).toMatchObject({ kind: 'location', extra: { location: { latitude: -2.17, longitude: -79.92, name: 'Oficina', address: null } } });
    expect(parseEvolutionWebhook(upsert('CON-0000000000000001', { contactsArrayMessage: { contacts: [{}, {}] } }), NOW).events[0]!.event.messages[0]).toMatchObject({ kind: 'contacts', extra: { contacts_count: 2 } });
    expect(parseEvolutionWebhook(upsert('BTN-0000000000000001', { buttonsResponseMessage: { selectedDisplayText: 'Sí' } }), NOW).events[0]!.event.messages[0]).toMatchObject({ kind: 'interactive', text: 'Sí' });
    expect(parseEvolutionWebhook(upsert('UNK-0000000000000001', { pollCreationMessage: { name: '¿?' } }), NOW).events[0]!.event.messages[0]).toMatchObject({ kind: 'unsupported', text: null });
  });

  it('una reacción NO es un mensaje: trae el id del mensaje reaccionado y el emoji; quitarla deja el emoji vacío', () => {
    const p = parseEvolutionWebhook(upsert('REA-0000000000000001', { reactionMessage: { key: { remoteJid: '154640482095149@lid', fromMe: false, id: 'DOC-0000000000000001' }, text: '👍' } }), NOW);
    expect(p.events[0]!.event.messages).toEqual([]);
    expect(p.events[0]!.event.reactions).toEqual([{ targetExternalId: 'DOC-0000000000000001', emoji: '👍', at: new Date(1793143471 * 1000) }]);
    const off = parseEvolutionWebhook(upsert('REA-0000000000000002', { reactionMessage: { key: { id: 'DOC-0000000000000001' }, text: '' } }), NOW);
    expect(off.events[0]!.event.reactions[0]!.emoji).toBeNull();
    expect(parseEvolutionWebhook(upsert('REA-0000000000000003', { reactionMessage: { text: '👍' } }), NOW).ignored).toBe(1);
  });

  it('el identificador con sufijo de dispositivo o solo @lid: se usa remoteJidAlt; sin teléfono resoluble se descarta', () => {
    const dev = parseEvolutionWebhook(upsert('DEV-0000000000000001', { conversation: 'hola' }, {}, { remoteJid: `${CLIENT}:50@s.whatsapp.net` }), NOW);
    expect(dev.events[0]!.event.messages[0]!.from).toBe(`+${CLIENT}`);
    const lid = parseEvolutionWebhook(upsert('LID-0000000000000001', { conversation: 'hola' }, {}, { remoteJid: '257720267587711@lid' }), NOW);
    expect(lid.events[0]!.event.messages[0]!.from).toBe(`+${CLIENT}`); // por remoteJidAlt
    const lost = parseEvolutionWebhook(upsert('LID-0000000000000002', { conversation: 'hola' }, {}, { remoteJid: '257720267587711@lid', remoteJidAlt: '257720267587711@lid' }), NOW);
    expect(lost).toMatchObject({ events: [], ignored: 1 });
  });

  it('grupos, estados de WhatsApp y lo que escribe el propio chip se ignoran (y se cuentan)', () => {
    for (const k of [{ remoteJid: '120363424375113025@g.us', participant: `${CLIENT}@s.whatsapp.net` }, { remoteJid: 'status@broadcast' }, { fromMe: true }]) {
      const p = parseEvolutionWebhook(upsert('IGN-0000000000000001', { conversation: 'no' }, {}, k), NOW);
      expect(p, JSON.stringify(k)).toMatchObject({ events: [], ignored: 1 });
    }
  });

  it('sin hora válida del mensaje usa la hora de recepción; los textos no llevan NUL', () => {
    const p = parseEvolutionWebhook(upsert('NUL-0000000000000001', { conversation: 'ho\u0000la' }, { messageTimestamp: 'basura' }), NOW);
    expect(p.events[0]!.event.messages[0]).toMatchObject({ text: 'hola', sentAt: NOW });
  });
});

describe('estados de lo que enviamos (messages.update)', () => {
  const upd = (status: string, over: Record<string, unknown> = {}) => evt('messages.update', { keyId: '3EB0C056932DCAEAB1168D', remoteJid: '257720267587711@lid', fromMe: true, status, instanceId: 'i-1', messageId: 'cmv-1', ...over });

  it('SERVER_ACK → enviado, DELIVERY_ACK → entregado, READ y PLAYED → leído; con el id del mensaje y la hora de recepción', () => {
    for (const [from, to] of [['SERVER_ACK', 'sent'], ['DELIVERY_ACK', 'delivered'], ['READ', 'read'], ['PLAYED', 'read']] as const) {
      const p = parseEvolutionWebhook(upd(from), NOW);
      expect(p.events[0]!.event.statuses, from).toEqual([{ externalId: '3EB0C056932DCAEAB1168D', state: to, at: NOW, error: null }]);
    }
  });

  it('un fallo conserva un error genérico (sin datos del cliente); PENDING no es un estado de entrega', () => {
    expect(parseEvolutionWebhook(upd('ERROR'), NOW).events[0]!.event.statuses[0]).toMatchObject({ state: 'failed', error: { code: 'unknown' } });
    expect(parseEvolutionWebhook(upd('PENDING'), NOW)).toMatchObject({ events: [], ignored: 0 });
    expect(parseEvolutionWebhook(upd('ALGO_NUEVO'), NOW)).toMatchObject({ events: [], ignored: 1 });
  });

  it('el «leído» de los mensajes DEL CLIENTE (fromMe: false) no es un estado de entrega', () => {
    expect(parseEvolutionWebhook(upd('READ', { fromMe: false }), NOW)).toMatchObject({ events: [], ignored: 1 });
  });

  it('los estados llegan fuera de orden: el lector no los reordena ni los descarta (el consumidor no los deja retroceder)', () => {
    const order = ['DELIVERY_ACK', 'SERVER_ACK'].map((s) => parseEvolutionWebhook(upd(s), NOW).events[0]!.event.statuses[0]!.state);
    expect(order).toEqual(['delivered', 'sent']);
  });
});

describe('sesión y QR (connection.update, qrcode.updated)', () => {
  it('open trae el teléfono y el perfil de la sesión; connecting no es una caída', () => {
    const open = parseEvolutionWebhook(evt('connection.update', { instance: 'spike-test', wuid: `${CHIP}@s.whatsapp.net`, profileName: 'Negocio', state: 'open', statusReason: 200 }), NOW);
    expect(open.connection).toEqual({ state: 'open', reason: 200, phone: `+${CHIP}`, profileName: 'Negocio' });
    expect(parseEvolutionWebhook(evt('connection.update', { instance: 'spike-test', state: 'connecting', statusReason: 200 }), NOW).connection).toMatchObject({ state: 'connecting', phone: null });
  });

  it('cerrar la sesión desde el teléfono (close + 401) es «logged_out»; otro cierre o un QR agotado es «closed»', () => {
    expect(parseEvolutionWebhook(evt('connection.update', { state: 'close', statusReason: 401 }), NOW).connection).toMatchObject({ state: 'logged_out', reason: 401 });
    expect(parseEvolutionWebhook(evt('connection.update', { state: 'close', statusReason: 408 }), NOW).connection).toMatchObject({ state: 'closed' });
    expect(parseEvolutionWebhook(evt('connection.update', { state: 'refused', statusReason: 428 }), NOW).connection).toMatchObject({ state: 'closed', reason: 428 });
  });

  it('un QR nuevo se avisa SIN conservar su contenido; el límite de QR se detecta', () => {
    const q = parseEvolutionWebhook(evt('qrcode.updated', { qrcode: { instance: 'spike-test', code: '2@secreto-del-qr', base64: 'data:image/png;base64,AAAA', pairingCode: null } }), NOW);
    expect(q.qr).toEqual({ updated: true, limitReached: false });
    expect(JSON.stringify(q)).not.toContain('secreto-del-qr');
    expect(parseEvolutionWebhook(evt('qrcode.updated', { message: 'QR code limit reached, please login again', statusCode: 500 }), NOW).qr).toEqual({ updated: false, limitReached: true });
  });
});

describe('lo que no se usa, lo mal formado y los secretos', () => {
  it('send.message, grupos y contactos se ignoran sin error', () => {
    for (const e of ['send.message', 'groups.upsert', 'group-participants.update', 'contacts.update', 'chats.upsert']) {
      expect(parseEvolutionWebhook(evt(e, { key: key('X-00000000000001') }), NOW), e).toMatchObject({ events: [], connection: null, qr: null, ignored: 0 });
    }
  });

  it('el nombre del evento acepta MAYÚSCULAS con guion bajo (MESSAGES_UPSERT) y minúsculas con punto', () => {
    expect(parseEvolutionWebhook({ ...upsert('UP-00000000000001', { conversation: 'a' }), event: 'MESSAGES_UPSERT' }, NOW).events).toHaveLength(1);
  });

  it('un cuerpo roto nunca lanza: se descarta y se cuenta', () => {
    for (const b of [null, undefined, 'texto', 42, [], {}, { event: 'messages.upsert' }, { instance: 'x', event: 'messages.upsert', data: 'no' }, { instance: 'x', event: 'messages.upsert', data: { key: {}, message: {} } }]) {
      const p = parseEvolutionWebhook(b, NOW);
      expect(p.events, JSON.stringify(b)).toEqual([]);
      expect(p.ignored).toBeGreaterThanOrEqual(0);
    }
  });

  it('el aviso que se guarda NO lleva la apikey ni la dirección del webhook con su token', () => {
    const p = parseEvolutionWebhook(upsert('SEC-0000000000000001', { conversation: 'hola' }), NOW);
    const stored = JSON.stringify(p);
    expect(stored).not.toMatch(/APIKEY-SECRETA|TOKEN-SECRETO|receptor\.interno/);
    const red = redactEvolutionPayload(upsert('SEC-0000000000000001', { conversation: 'hola', base64: 'B'.repeat(100) }));
    expect(JSON.stringify(red)).not.toMatch(/APIKEY-SECRETA|TOKEN-SECRETO|apikey|destination|BBBB/);
    expect(JSON.stringify(red)).toContain('[archivo: 100 caracteres]');
  });

  it('el token del webhook se compara en tiempo constante y uno vacío nunca autentica', () => {
    expect(verifyEvolutionToken('a'.repeat(48), 'a'.repeat(48))).toBe(true);
    expect(verifyEvolutionToken('a'.repeat(47) + 'b', 'a'.repeat(48))).toBe(false);
    expect(verifyEvolutionToken('corto', 'a'.repeat(48))).toBe(false);
    expect(verifyEvolutionToken('', '')).toBe(false);
    expect(verifyEvolutionToken(null, 'x')).toBe(false);
    expect(verifyEvolutionToken(undefined, '')).toBe(false);
  });

  it('phoneFromJid: solo identificadores de teléfono', () => {
    expect(phoneFromJid(`${CLIENT}@s.whatsapp.net`)).toBe(`+${CLIENT}`);
    expect(phoneFromJid(`${CLIENT}:12@s.whatsapp.net`)).toBe(`+${CLIENT}`);
    for (const j of ['257720267587711@lid', '120363424375113025@g.us', 'status@broadcast', '', null, 5, '123@s.whatsapp.net', 'abc@s.whatsapp.net']) expect(phoneFromJid(j), String(j)).toBeNull();
  });
});
