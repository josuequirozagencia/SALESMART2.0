/**
 * Monto escrito por la persona → texto «1500.00» listo para la API; null si no es un monto válido (0 a 999 999 999 999,99 con hasta 2 decimales; admite coma).
 * Vacío = 0. El servidor vuelve a validar.
 */
export function parseAmount(input: string): string | null {
  const t = input.trim().replace(',', '.');
  if (t === '') return '0.00';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t)) return null;
  return Number(t).toFixed(2);
}
