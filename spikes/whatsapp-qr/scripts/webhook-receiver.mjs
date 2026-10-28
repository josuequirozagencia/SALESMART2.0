// Receptor mínimo de webhooks para el spike. Sin dependencias.
// Valida un token por query (?token=...) y guarda cada evento en events.jsonl.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.WEBHOOK_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 4000);
if (TOKEN.length < 16) { console.error('WEBHOOK_TOKEN debe tener >= 16 caracteres'); process.exit(1); }

const ok = (a) => { const x = Buffer.from(a ?? ''), y = Buffer.from(TOKEN); return x.length === y.length && timingSafeEqual(x, y); };

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'POST' || !url.pathname.startsWith('/hook')) { res.writeHead(404).end(); return; }
  if (!ok(url.searchParams.get('token'))) { res.writeHead(401).end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 25e6) req.destroy(); });
  req.on('end', () => {
    let evt; try { evt = JSON.parse(body); } catch { evt = { raw: body.slice(0, 500) }; }
    const { apikey: _a, destination: _d, ...safe } = evt;
    const line = JSON.stringify({ at: new Date().toISOString(), path: url.pathname, event: evt.event ?? null, data: safe });
    appendFileSync('events.jsonl', line + '\n');
    console.log(new Date().toISOString(), evt.event ?? '(sin evento)');
    // Railway no conserva archivos entre despliegues: el evento completo (con los base64 acortados) va también a los logs
    // Evolution manda en CADA evento la apikey de la instancia y la dirección del webhook con su token: nunca van a un log
    const SECRET_KEYS = new Set(['apikey', 'destination', 'token', 'jwt', 'secret']);
    console.log('EVT ' + JSON.stringify(evt, (key, v) => (SECRET_KEYS.has(key.toLowerCase()) ? '[oculto]' : typeof v === 'string' && v.length > 300 ? v.slice(0, 120) + '…[' + v.length + ' caracteres]' : v)));
    res.writeHead(200).end('ok');
  });
}).listen(PORT, () => console.log('receptor en :' + PORT));
