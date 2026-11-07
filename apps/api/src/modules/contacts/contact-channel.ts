/** Canal de entrada de un contacto, en lenguaje humano (M3.3 §11). */
export type ContactChannel = 'facebook' | 'instagram' | 'whatsapp' | 'manual' | 'other';
export const CONTACT_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'manual', 'other'] as const satisfies readonly ContactChannel[];

/**
 * Deriva el canal a partir del origen técnico (`source`) y, si el aviso lo trae, la red donde se vio el anuncio (`placement`):
 *  - `meta_ctwa` + placement `instagram` → instagram; `meta_ctwa` con placement `facebook` o sin placement → facebook
 *  - un contacto creado por un mensaje de WhatsApp sin anuncio → whatsapp
 *  - creado a mano desde la pantalla → manual
 *  - cualquier otro origen (formulario, GoHighLevel, importación…) → other
 */
export function channelOf(source: string, placement?: 'facebook' | 'instagram' | null): ContactChannel {
  if (source === 'meta_ctwa') return placement === 'instagram' ? 'instagram' : 'facebook';
  if (source === 'whatsapp') return 'whatsapp';
  if (source === 'manual') return 'manual';
  return 'other';
}
