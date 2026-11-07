/** Canal de entrada de un contacto, en lenguaje humano (M3.3 §11): de qué red o vía llegó. Se fija al CREAR el contacto y no se cambia después. */
export const CONTACT_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'manual', 'other'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
