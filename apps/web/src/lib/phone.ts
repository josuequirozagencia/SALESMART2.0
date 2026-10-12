/** Prefijos de país del registro (los del prototipo). El servidor guarda el número en E.164 (+593987654321). */
export const COUNTRIES = [
  { code: '+593', label: 'EC +593' },
  { code: '+57', label: 'CO +57' },
  { code: '+51', label: 'PE +51' },
  { code: '+52', label: 'MX +52' },
  { code: '+34', label: 'ES +34' },
  { code: '+1', label: 'US +1' },
] as const;

/** Une prefijo y número nacional: quita espacios, guiones y paréntesis y el «0» inicial de marcación nacional (098… → 98…). */
export function toE164(countryCode: string, national: string): string {
  return `${countryCode}${national.replace(/\D/g, '').replace(/^0+/, '')}`;
}

/** Dígitos del número nacional (sin prefijo ni el 0 de marcación). Un WhatsApp real tiene al menos 7. */
export const nationalDigits = (national: string): number => national.replace(/\D/g, '').replace(/^0+/, '').length;
export const MIN_NATIONAL_DIGITS = 7;

/** Mismo formato que valida el servidor: «+», un primer dígito 1-9 y de 8 a 15 dígitos en total. */
export const isE164 = (v: string): boolean => /^\+[1-9]\d{7,14}$/.test(v);
