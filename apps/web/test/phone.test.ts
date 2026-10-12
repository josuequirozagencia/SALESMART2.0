import { describe, expect, it } from 'vitest';
import { isE164, MIN_NATIONAL_DIGITS, nationalDigits, toE164 } from '../src/lib/phone';

describe('WhatsApp en E.164', () => {
  it.each([
    ['+593', '098 421 7730', '+593984217730'],
    ['+593', '(98) 421-7730', '+593984217730'],
    ['+57', '300 123 4567', '+573001234567'],
    ['+1', '(305) 555-0100', '+13055550100'],
    ['+34', '600 11 22 33', '+34600112233'],
  ])('%s + «%s» → %s', (cc, national, expected) => {
    expect(toE164(cc, national)).toBe(expected);
    expect(isE164(expected)).toBe(true);
  });

  it('cuenta solo los dígitos del número nacional (sin prefijo ni el 0 inicial)', () => {
    expect(nationalDigits('098 421 7730')).toBe(9);
    expect(nationalDigits('12345')).toBeLessThan(MIN_NATIONAL_DIGITS);
    expect(nationalDigits('000')).toBe(0);
  });

  it.each(['', '593984217730', '+593', '+59398', '+0984217730', '+593 98 421 7730', '+5939842177301234', '+59398abc7730'])('«%s» no es E.164', (v) => {
    expect(isE164(v)).toBe(false);
  });
});
