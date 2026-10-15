/**
 * Países ISO 3166-1 alfa-2 (los 249 asignados) para el alta de empresas. Es la MISMA lista que valida la API
 * (`packages/shared/src/countries.ts`); una prueba comprueba que no se desfasen. Los nombres salen de `Intl.DisplayNames` en español.
 */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM ' +
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

export const DEFAULT_COUNTRY = 'EC';
/** Se muestran primero (mercado inicial); el resto va por orden alfabético. */
const PREFERRED = ['EC', 'CO', 'PE', 'MX', 'AR', 'CL', 'ES', 'US'];

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface CountryOption { code: string; name: string }
export function countryOptions(): CountryOption[] {
  const all = COUNTRY_CODES.map((code) => ({ code, name: countryName(code) }));
  const first = PREFERRED.map((c) => all.find((o) => o.code === c)!).filter(Boolean);
  const rest = all.filter((o) => !PREFERRED.includes(o.code)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return [...first, ...rest];
}

/** Zona horaria sugerida al elegir país (solo donde hay una zona dominante). Editable. */
const COUNTRY_TZ: Record<string, string> = {
  EC: 'America/Guayaquil',
  CO: 'America/Bogota',
  PE: 'America/Lima',
  MX: 'America/Mexico_City',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  ES: 'Europe/Madrid',
  US: 'America/New_York',
};
export const suggestedTimezone = (country: string): string | undefined => COUNTRY_TZ[country];

const FALLBACK_TZ = ['America/Guayaquil', 'America/Bogota', 'America/Lima', 'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'America/Santiago', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'UTC'];
/** Todas las zonas IANA del navegador (si no las expone, una lista corta). */
export function timezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list.includes('UTC') ? list : [...list, 'UTC'];
  } catch {
    /* navegador sin soporte */
  }
  return FALLBACK_TZ;
}
