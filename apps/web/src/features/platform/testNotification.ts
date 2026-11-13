import type { Brand } from '../../lib/platformBrand';

export type TestNotificationResult = 'ok' | 'unsupported' | 'denied' | 'error';

/**
 * «Probar notificación» (Plataforma › Marca): muestra en ESTE navegador una notificación del sistema con el icono y el badge vigentes, usando el mismo service worker y las mismas opciones que las
 * notificaciones reales. Pide el permiso del navegador solo aquí, al pulsar el botón. No pasa por el servidor: sirve para ver cómo queda el icono, no para probar el envío de push (eso es
 * Configuración › Notificaciones › «Enviar notificación de prueba»).
 */
export async function showTestNotification(b: Brand): Promise<TestNotificationResult> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
  try {
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    await reg.showNotification(b.name, {
      body: 'Así se ve una notificación de tu plataforma.',
      icon: b.icon192 ?? '/v1/branding/icon-192.png',
      badge: b.badge96 ?? '/v1/branding/badge-96.png',
      tag: 'brand-test',
      data: { url: '/platform/branding' },
    });
    return 'ok';
  } catch {
    return 'error';
  }
}
