// CLI del spike contra Evolution API v2. Node 22, sin dependencias.
// Uso: node --env-file=.env scripts/evo.mjs <comando> [args]
//   create | qr | state | send-text <texto> | send-media <url> [caption] | restart | logout | fetch-instances
// Los endpoints siguen la doc de Evolution v2.1.x; si una versión cambia, el error se muestra completo.
import { writeFileSync } from 'node:fs';

const { EVO_URL, EVOLUTION_API_KEY, EVO_INSTANCE = 'spike-test', WEBHOOK_URL, WEBHOOK_TOKEN, TEST_NUMBER } = process.env;
if (!EVO_URL || !EVOLUTION_API_KEY) { console.error('Faltan EVO_URL / EVOLUTION_API_KEY'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(EVO_URL + path, { method, headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) { console.error(`HTTP ${r.status} ${method} ${path}\n`, JSON.stringify(json, null, 2)); process.exit(2); }
  return json;
}
const [cmd, ...args] = process.argv.slice(2);
const need = (v, n) => { if (!v) { console.error('Falta ' + n); process.exit(1); } return v; };

switch (cmd) {
  case 'create': {
    const hook = `${need(WEBHOOK_URL, 'WEBHOOK_URL')}?token=${need(WEBHOOK_TOKEN, 'WEBHOOK_TOKEN')}`;
    console.log(JSON.stringify(await call('POST', '/instance/create', {
      instanceName: EVO_INSTANCE, integration: 'WHATSAPP-BAILEYS', qrcode: true,
      rejectCall: false, groupsIgnore: false, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false,
      webhook: { url: hook, byEvents: false, base64: true, events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE', 'GROUPS_UPSERT', 'GROUP_PARTICIPANTS_UPDATE'] },
    }), null, 2));
    break;
  }
  case 'qr': {
    const j = await call('GET', `/instance/connect/${EVO_INSTANCE}`);
    if (j.base64) { writeFileSync('qr.png', Buffer.from(j.base64.replace(/^data:image\/png;base64,/, ''), 'base64')); console.log('QR guardado en qr.png — ábrelo y escanéalo (WhatsApp > Dispositivos vinculados). Caduca en ~30-60 s; repite si expira.'); }
    else console.log(JSON.stringify(j, null, 2));
    break;
  }
  case 'state': console.log(JSON.stringify(await call('GET', `/instance/connectionState/${EVO_INSTANCE}`), null, 2)); break;
  case 'fetch-instances': console.log(JSON.stringify(await call('GET', '/instance/fetchInstances'), null, 2)); break;
  case 'restart': console.log(JSON.stringify(await call('POST', `/instance/restart/${EVO_INSTANCE}`), null, 2)); break;
  case 'logout': console.log(JSON.stringify(await call('DELETE', `/instance/logout/${EVO_INSTANCE}`), null, 2)); break;
  case 'send-text': {
    const text = need(args.join(' '), 'texto');
    console.log(JSON.stringify(await call('POST', `/message/sendText/${EVO_INSTANCE}`, { number: need(TEST_NUMBER, 'TEST_NUMBER'), text }), null, 2)); break;
  }
  case 'send-media': {
    const [media, ...cap] = args;
    console.log(JSON.stringify(await call('POST', `/message/sendMedia/${EVO_INSTANCE}`, { number: need(TEST_NUMBER, 'TEST_NUMBER'), mediatype: 'image', media: need(media, 'URL de la imagen'), caption: cap.join(' ') }), null, 2)); break;
  }
  default: console.error('Comandos: create | qr | state | fetch-instances | restart | logout | send-text <texto> | send-media <url> [caption]'); process.exit(1);
}
