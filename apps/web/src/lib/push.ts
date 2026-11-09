import { api } from './api';

/**
 * Notificaciones push del navegador (v6 fase E, ADR-64). Nada se pide al entrar a la aplicación: solo cuando la persona las activa en Configuración › Notificaciones se pide el permiso,
 * se registra el service worker (`/sw.js`, que solo muestra avisos) y se suscribe el navegador. Las direcciones de suscripción viajan al servidor en el cuerpo y no se guardan aquí.
 */
export interface PushConfig {
  enabled: boolean;
  public_key: string | null;
}
export interface PushStatus {
  subscribed: boolean;
  show_text: boolean;
}

export type PushSupport = 'ok' | 'unsupported' | 'insecure';

/** ¿Este navegador puede recibir push? (necesita HTTPS, service worker, PushManager y Notification; en iPhone solo con la aplicación instalada en la pantalla de inicio). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'ok' : 'unsupported';
}

export const notificationPermission = (): NotificationPermission => (typeof Notification === 'undefined' ? 'denied' : Notification.permission);

/** La clave pública VAPID (base64url) como la pide `pushManager.subscribe`. */
export function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const registration = (): Promise<ServiceWorkerRegistration> => navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready);

/** La suscripción de este navegador, si existe (sin registrar nada nuevo si el service worker no estaba). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export const fetchPushConfig = (): Promise<PushConfig> => api<PushConfig>('/push/config');
export const fetchPushStatus = (endpoint: string): Promise<PushStatus> => api<PushStatus>('/push/status', { method: 'POST', body: { endpoint } });

function body(sub: PushSubscription, showText: boolean): { endpoint: string; keys: { p256dh: string; auth: string }; show_text: boolean } {
  const j = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: j.keys?.['p256dh'] ?? '', auth: j.keys?.['auth'] ?? '' }, show_text: showText };
}

/** Activa las notificaciones: permiso, service worker, suscripción y alta en el servidor. Lanza con un mensaje claro si algo falla. */
export async function enablePush(publicKey: string, showText: boolean): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'El navegador bloqueó las notificaciones. Actívalas desde el candado de la barra de direcciones.' : 'No diste permiso para las notificaciones.');
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  return api<PushStatus>('/push/subscribe', { method: 'POST', body: body(sub, showText) });
}

/** Cambia si la notificación lleva el texto del mensaje (misma suscripción). */
export async function updateShowText(showText: boolean): Promise<PushStatus> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Este navegador no está suscrito.');
  return api<PushStatus>('/push/subscribe', { method: 'POST', body: body(sub, showText) });
}

/** Desactiva las notificaciones de este navegador: baja en el servidor y cancela la suscripción. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api<PushStatus>('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
