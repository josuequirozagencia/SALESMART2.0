/**
 * Cuántos créditos se cobran por un costo real (M8.1, ADR-19/53): `⌈costo USD × (1 + margen%) ÷ USD por crédito⌉`. Función pura. Un costo mayor que cero cobra al menos 1 crédito; un costo de cero, ninguno.
 * El margen y el valor del crédito son SOLO del servidor: esta función nunca se llama desde una respuesta de cliente.
 */
export function creditsFor(costUsd: number, marginPct: number, usdPerCredit: number): number {
  if (!(costUsd > 0)) return 0;
  if (!(usdPerCredit > 0)) throw new Error('el valor del crédito debe ser mayor que cero');
  // El épsilon absorbe el error de coma flotante (0,07 ÷ 0,01 = 7,000000000000001) para no cobrar un crédito de más
  const exact = (costUsd * (1 + marginPct / 100)) / usdPerCredit;
  return Math.max(1, Math.ceil(exact - 1e-9));
}
