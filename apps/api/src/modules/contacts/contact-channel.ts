import { CONTACT_CHANNELS, type ContactChannel } from '@sales-smart/shared';
import { z } from 'zod';

export { CONTACT_CHANNELS, type ContactChannel };

/** Valida en el servidor que el canal sea uno de los permitidos. */
export const contactChannelSchema = z.enum(CONTACT_CHANNELS);

/**
 * Deriva el canal a partir del origen técnico (`source`) y, si el aviso lo trae, la red donde se vio el anuncio (`placement`):
 *  - `meta_ctwa` + placement `instagram` → instagram; `meta_ctwa` con placement `facebook` o sin placement → facebook
 *  - un contacto creado por un mensaje de WhatsApp sin anuncio → whatsapp
 *  - creado a mano desde la pantalla → manual
 *  - cualquier otro origen (GoHighLevel, importación…) → other
 * El formulario público se deriva aparte con `channelOfForm` (mira el `utm_source`).
 */
export function channelOf(source: string, placement?: 'facebook' | 'instagram' | null): ContactChannel {
  if (source === 'meta_ctwa') return placement === 'instagram' ? 'instagram' : 'facebook';
  if (source === 'whatsapp') return 'whatsapp';
  if (source === 'manual') return 'manual';
  return 'other';
}

const FACEBOOK = new Set(['facebook', 'fb', 'meta']);
const INSTAGRAM = new Set(['instagram', 'ig']);

/** Canal de un contacto que llega por un formulario público: según el `utm_source` del envío (facebook/fb/meta, instagram/ig); sin nada reconocible, `other`. */
export function channelOfForm(utm: Record<string, string> | undefined): ContactChannel {
  const v = (utm?.['utm_source'] ?? '').trim().toLowerCase();
  if (INSTAGRAM.has(v)) return 'instagram';
  if (FACEBOOK.has(v)) return 'facebook';
  return 'other';
}
