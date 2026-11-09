/**
 * Puerto de las notificaciones push del navegador (v6 fase E, ADR-64). El núcleo solo ve esto: ningún módulo importa la librería de Web Push. Cada adaptador tiene su fake y un contract test.
 *  - `sent`: el servicio de push aceptó el aviso.
 *  - `gone`: el navegador ya no existe (404/410): hay que dar de baja la suscripción.
 *  - `failed`: error transitorio o rechazo: no se reintenta (el mensaje ya está en la bandeja y el sonido/campana lo avisan).
 */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}
export type PushResult = 'sent' | 'gone' | 'failed';

export interface PushSender {
  readonly name: 'webpush' | 'fake';
  send(target: PushTarget, payload: string): Promise<PushResult>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');
