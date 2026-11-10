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

/**
 * Traduce el error del navegador al activar el push a una explicación en español con lo que se puede revisar. El más común en Edge y Chrome es «Registration failed - permission denied»: el navegador
 * dio el permiso pero SU servicio de notificaciones rechazó la suscripción (notificaciones del sistema apagadas, sitio bloqueado, red o VPN que no llega a ese servicio).
 */
export function explainPushError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const text = e instanceof Error ? e.message.toLowerCase() : '';
  if (text.includes('permission denied') || name === 'NotAllowedError') {
    return 'El servicio de notificaciones de tu navegador rechazó la activación. Revisa que las notificaciones de tu navegador estén activadas en Windows, macOS o Android (y que no esté el modo «No molestar»), que este sitio esté en «Permitir» en la configuración del navegador y que ninguna VPN o bloqueador de red lo impida. Si sigue igual, prueba en otro navegador.';
  }
  if (name === 'AbortError' || text.includes('push service')) {
    return 'El servicio de notificaciones de tu navegador no respondió. Revisa tu conexión (o desactiva la VPN) e inténtalo de nuevo en unos minutos.';
  }
  if (name === 'SecurityError' || text.includes('failed to register') || text.includes('serviceworker')) {
    return 'No pudimos preparar las notificaciones en este navegador. Recarga la página e inténtalo de nuevo; si usas una ventana privada o bloqueas datos del sitio, prueba en una ventana normal.';
  }
  if (name === 'InvalidAccessError' || name === 'InvalidStateError' || name === 'NotSupportedError') {
    return 'Este navegador no pudo activar las notificaciones con la clave del servidor. Recarga la página e inténtalo de nuevo; si persiste, avisa al administrador.';
  }
  return 'No pudimos activar las notificaciones en este navegador. Inténtalo de nuevo o prueba en otro navegador.';
}

/** Activa las notificaciones: permiso, service worker, suscripción y alta en el servidor. Lanza con un mensaje claro si algo falla. */
export async function enablePush(publicKey: string, showText: boolean): Promise<PushStatus> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'El navegador bloqueó las notificaciones. Actívalas desde el candado de la barra de direcciones.' : 'No diste permiso para las notificaciones.');
  let sub: PushSubscription;
  try {
    const reg = await registration();
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  } catch (e) {
    throw new Error(explainPushError(e), { cause: e });
  }
  return api<PushStatus>('/push/subscribe', { method: 'POST', body: body(sub, showText) });
}

/** Cambia si la notificación lleva el texto del mensaje (misma suscripción). */
export async function updateShowText(showText: boolean): Promise<PushStatus> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Este navegador no está suscrito.');
  return api<PushStatus>('/push/subscribe', { method: 'POST', body: body(sub, showText) });
}

export interface PushTestResult {
  sent: number;
  gone: number;
  failed: number;
}
/** Manda una notificación de prueba a los navegadores suscritos de esta persona. */
export const sendPushTest = (): Promise<PushTestResult> => api<PushTestResult>('/push/test', { method: 'POST' });

/** Desactiva las notificaciones de este navegador: baja en el servidor y cancela la suscripción. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api<PushStatus>('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
