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

/**
 * Lo que la persona escribe → E.164. Con «+» al inicio se respeta como número internacional (solo dígitos); sin él se le antepone el prefijo del país elegido
 * (y se quita el 0 de marcación nacional). null si no tiene la forma de un E.164 válido. El servidor vuelve a validar.
 */
export function normalizePhone(input: string, countryCode: string): string | null {
  const t = input.trim();
  if (t === '') return null;
  const e164 = t.startsWith('+') ? `+${t.replace(/\D/g, '').replace(/^0+/, '')}` : toE164(countryCode, t);
  return isE164(e164) ? e164 : null;
}

/** «+593984217730» → «+593 98 421 7730» (con prefijos conocidos); si no, el número tal cual. Solo presentación. */
export function formatPhone(e164: string): string {
  const known = [...COUNTRIES].map((c) => c.code).sort((a, b) => b.length - a.length).find((c) => e164.startsWith(c));
  if (!known) return e164;
  const rest = e164.slice(known.length);
  if (known === '+1' && rest.length === 10) return `+1 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
  return `${known} ${rest.replace(/^(\d{2})(\d{3})(\d+)$/, '$1 $2 $3')}`;
}
