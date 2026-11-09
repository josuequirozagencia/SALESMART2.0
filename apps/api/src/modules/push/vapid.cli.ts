import webpush from 'web-push';

/**
 * Genera un par de claves VAPID (ADR-64) para `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`. Se corre UNA vez por entorno (`pnpm --filter @sales-smart/api push:vapid`); la privada es un secreto: no se
 * guarda en el repositorio ni se pega en chats. Cambiarlas obliga a todas las personas a volver a activar las notificaciones.
 */
const keys = webpush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
