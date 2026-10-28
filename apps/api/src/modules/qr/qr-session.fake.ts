import { randomUUID } from 'node:crypto';
import type { EvolutionConnectionState } from '../channels';
import type { SentMessage } from '../channels';
import { QrSessionError, type QrCodeResult, type QrCredentials, type QrSendMedia, type QrSessionProvider, type QrErrorCode } from './qr-session.port';

/** Clave que acepta el fake: cualquier otra se rechaza como `not_configured` (igual que Evolution con una clave equivocada). */
export const FAKE_QR_KEY = 'fake-qr-key';

export interface FakeInstance {
  state: EvolutionConnectionState;
  webhookUrl: string;
  qrCalls: number;
}
export interface FakeQrSent {
  readonly instance: string;
  readonly to: string;
  readonly text: string | null;
  readonly media: { kind: string; mimeType: string; bytes: number; filename: string | null } | null;
  readonly externalId: string;
}

/**
 * Evolution de mentira (M9.6) para desarrollo y pruebas (`QR_PROVIDER=fake`; se rechaza en producción): guarda las instancias y los envíos en memoria, deja decidir el estado de la sesión
 * (`setState`) y hacer fallar el próximo envío (`failNext`). Cumple el mismo contract test que {@link EvolutionProvider}.
 */
export class FakeQrSession implements QrSessionProvider {
  readonly name = 'fake' as const;
  readonly instances = new Map<string, FakeInstance>();
  readonly sent: FakeQrSent[] = [];
  private failures: QrSessionError[] = [];

  reset(): void {
    this.instances.clear();
    this.sent.length = 0;
    this.failures = [];
  }

  /** El próximo envío falla con este código. */
  failNext(code: QrErrorCode): void {
    this.failures.push(new QrSessionError(code, 'Fallo simulado'));
  }

  setState(instance: string, state: EvolutionConnectionState): void {
    const i = this.instances.get(instance);
    if (i) i.state = state;
  }

  private check(c: QrCredentials): void {
    if (c.apiKey !== FAKE_QR_KEY) throw new QrSessionError('not_configured', 'El servidor de WhatsApp por QR rechazó la clave de la plataforma');
  }
  private get(instance: string): FakeInstance {
    const i = this.instances.get(instance);
    if (!i) throw new QrSessionError('not_found', 'La instancia de WhatsApp por QR no existe');
    return i;
  }

  createInstance(c: QrCredentials, input: { instance: string; webhookUrl: string }): Promise<void> {
    try {
      this.check(c);
      this.instances.set(input.instance, { state: 'connecting', webhookUrl: input.webhookUrl, qrCalls: 0 });
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  requestQr(c: QrCredentials, instance: string): Promise<QrCodeResult> {
    try {
      this.check(c);
      const i = this.get(instance);
      i.qrCalls += 1;
      return Promise.resolve(i.state === 'open' ? { base64: null, state: 'open' } : { base64: `data:image/png;base64,FAKE-QR-${i.qrCalls}`, state: 'connecting' });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  state(c: QrCredentials, instance: string): Promise<EvolutionConnectionState> {
    try {
      this.check(c);
      return Promise.resolve(this.get(instance).state);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  logout(c: QrCredentials, instance: string): Promise<void> {
    try {
      this.check(c);
      this.get(instance).state = 'logged_out';
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  deleteInstance(c: QrCredentials, instance: string): Promise<void> {
    try {
      this.check(c);
      this.instances.delete(instance);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private send(c: QrCredentials, instance: string, to: string, text: string | null, media: FakeQrSent['media']): Promise<SentMessage> {
    try {
      this.check(c);
      const i = this.get(instance);
      const f = this.failures.shift();
      if (f) throw f;
      if (i.state !== 'open') throw new QrSessionError('session_down', 'La sesión de WhatsApp no está abierta: hay que escanear el QR de nuevo');
      const externalId = `FAKE${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`;
      this.sent.push({ instance, to, text, media, externalId });
      return Promise.resolve({ externalId });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  sendText(c: QrCredentials, instance: string, input: { to: string; text: string }): Promise<SentMessage> {
    return this.send(c, instance, input.to, input.text, null);
  }

  sendMedia(c: QrCredentials, instance: string, input: QrSendMedia): Promise<SentMessage> {
    if (input.kind === 'sticker') return Promise.reject(new QrSessionError('unsupported', 'Por WhatsApp por QR no se pueden enviar stickers'));
    return this.send(c, instance, input.to, input.caption, { kind: input.kind, mimeType: input.mimeType, bytes: input.bytes.length, filename: input.filename });
  }
}
