import webpush from 'web-push';
import type { PushResult, PushSender, PushTarget } from './push.port';

/**
 * Web Push real (librería `web-push`, claves VAPID del servidor). El cuerpo viaja cifrado de extremo a extremo con las claves de la suscripción: el servicio de push (Google, Mozilla, Apple) no lo lee.
 * Nunca se registra el contenido ni la dirección de la suscripción. **Probado solo con el fake** hasta que se valide con navegadores reales.
 */
export class WebPushSender implements PushSender {
  readonly name = 'webpush' as const;
  private readonly options: webpush.RequestOptions;

  constructor(subject: string, publicKey: string, privateKey: string) {
    this.options = { vapidDetails: { subject, publicKey, privateKey }, TTL: 3600, urgency: 'high', timeout: 10_000 };
  }

  async send(target: PushTarget, payload: string): Promise<PushResult> {
    try {
      await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, this.options);
      return 'sent';
    } catch (e) {
      const status = (e as { statusCode?: unknown } | null)?.statusCode;
      return status === 404 || status === 410 ? 'gone' : 'failed';
    }
  }
}
