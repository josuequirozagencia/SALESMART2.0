import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { FakeCalendarProvider } from '../../src/modules/calendar';
import { calendarProviderContract } from './calendar.contract';

describe('FakeCalendarProvider · contrato del puerto', () => {
  it('cumple el mismo contrato que el adaptador de Google', async () => {
    await calendarProviderContract(async () => {
      const provider = new FakeCalendarProvider();
      // el fake valida PKCE contra la última dirección generada: «aprobar» devuelve un código válido
      return { provider, approve: async () => provider.issueCode() };
    });
  });

  it('el desafío PKCE se calcula con S256', () => {
    const v = 'v'.repeat(43);
    const challenge = createHash('sha256').update(v).digest('base64url');
    if (challenge.length !== 43) throw new Error('S256 debe dar 43 caracteres');
  });
});
