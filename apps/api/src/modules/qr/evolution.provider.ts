import type { EvolutionConnectionState } from '../channels';
import type { SentMessage } from '../channels';
import { QrSessionError, type QrCodeResult, type QrCredentials, type QrSendMedia, type QrSessionProvider } from './qr-session.port';

const TIMEOUT_MS = 20_000;
/** Los eventos que Evolution debe mandar a nuestro webhook (los que lee `parseEvolutionWebhook`). */
export const EVOLUTION_EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Adaptador de Evolution API v2 (M9.6). Las rutas y los cuerpos salen del spike del 2026-10-27 (Evolution v2.3.7): crear instancia, `connect` (QR), `connectionState`, `logout`, `delete`, `sendText`.
 * **Sin validar contra Evolution real** (ver el informe del spike): `sendMedia` y `sendWhatsAppAudio` —el spike solo envió una imagen por URL—, y el cuerpo de error de cada ruta. Los errores se traducen a
 * códigos nuestros y NUNCA incluyen la clave, el teléfono ni el texto. Un tiempo máximo de 20 s por llamada.
 */
export class EvolutionProvider implements QrSessionProvider {
  readonly name = 'evolution' as const;

  private async call(c: QrCredentials, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${c.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { apikey: c.apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new QrSessionError('unavailable', 'No se pudo conectar con el servidor de WhatsApp por QR');
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.ok) return json;
    const detail = JSON.stringify(json ?? text).toLowerCase();
    if (res.status === 401 || res.status === 403) throw new QrSessionError('not_configured', 'El servidor de WhatsApp por QR rechazó la clave de la plataforma');
    if (res.status === 404 && /instance/.test(detail)) throw new QrSessionError('not_found', 'La instancia de WhatsApp por QR no existe');
    if (res.status === 429) throw new QrSessionError('rate_limited', 'El servidor de WhatsApp por QR limitó las peticiones');
    if (/connection closed|not connected|disconnected|is not open|session/.test(detail)) throw new QrSessionError('session_down', 'La sesión de WhatsApp no está abierta: hay que escanear el QR de nuevo');
    if (/exists.*false|not.*whatsapp|invalid.*number|number.*invalid/.test(detail)) throw new QrSessionError('recipient_invalid', 'El número no puede recibir mensajes de WhatsApp');
    if (res.status >= 500) throw new QrSessionError('unavailable', 'El servidor de WhatsApp por QR falló');
    throw new QrSessionError('rejected', 'El servidor de WhatsApp por QR rechazó la solicitud');
  }

  async createInstance(c: QrCredentials, input: { instance: string; webhookUrl: string }): Promise<void> {
    await this.call(c, 'POST', '/instance/create', {
      instanceName: input.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: false,
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      webhook: { url: input.webhookUrl, byEvents: false, base64: true, events: [...EVOLUTION_EVENTS] },
    });
  }

  async requestQr(c: QrCredentials, instance: string): Promise<QrCodeResult> {
    const j = await this.call(c, 'GET', `/instance/connect/${encodeURIComponent(instance)}`);
    const o = isObj(j) ? j : {};
    const state = str(o['state']) === 'open' || (isObj(o['instance']) && str(o['instance']['state']) === 'open') ? 'open' : 'connecting';
    return { base64: str(o['base64']), state };
  }

  async state(c: QrCredentials, instance: string): Promise<EvolutionConnectionState> {
    const j = await this.call(c, 'GET', `/instance/connectionState/${encodeURIComponent(instance)}`);
    const raw = isObj(j) && isObj(j['instance']) ? str(j['instance']['state']) : null;
    return raw === 'open' ? 'open' : raw === 'connecting' ? 'connecting' : 'closed';
  }

  async logout(c: QrCredentials, instance: string): Promise<void> {
    await this.call(c, 'DELETE', `/instance/logout/${encodeURIComponent(instance)}`);
  }

  async deleteInstance(c: QrCredentials, instance: string): Promise<void> {
    try {
      await this.call(c, 'DELETE', `/instance/delete/${encodeURIComponent(instance)}`);
    } catch (e) {
      if (e instanceof QrSessionError && e.code === 'not_found') return; // ya no existía
      throw e;
    }
  }

  private idOf(j: unknown): SentMessage {
    const key = isObj(j) && isObj(j['key']) ? j['key'] : null;
    const id = key ? str(key['id']) : null;
    if (!id) throw new QrSessionError('rejected', 'El servidor de WhatsApp por QR no devolvió el identificador del mensaje');
    return { externalId: id };
  }

  async sendText(c: QrCredentials, instance: string, input: { to: string; text: string }): Promise<SentMessage> {
    return this.idOf(await this.call(c, 'POST', `/message/sendText/${encodeURIComponent(instance)}`, { number: input.to, text: input.text }));
  }

  async sendMedia(c: QrCredentials, instance: string, input: QrSendMedia): Promise<SentMessage> {
    if (input.kind === 'sticker') throw new QrSessionError('unsupported', 'Por WhatsApp por QR no se pueden enviar stickers');
    const b64 = input.bytes.toString('base64');
    if (input.kind === 'audio') return this.idOf(await this.call(c, 'POST', `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, { number: input.to, audio: b64 }));
    return this.idOf(
      await this.call(c, 'POST', `/message/sendMedia/${encodeURIComponent(instance)}`, {
        number: input.to,
        mediatype: input.kind,
        mimetype: input.mimeType,
        media: b64,
        fileName: input.filename ?? undefined,
        caption: input.caption ?? undefined,
      }),
    );
  }
}
