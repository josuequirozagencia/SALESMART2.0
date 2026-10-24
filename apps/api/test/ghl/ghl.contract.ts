import { expect } from 'vitest';
import { GhlError, type GhlCredentials, type GhlProvider } from '../../src/modules/ghl';

/** Credenciales de prueba de una empresa (el adaptador no guarda ninguna: las recibe en cada llamada). */
export const CREDS: GhlCredentials = { locationId: 've9EPM428h8vShlRW1KT', accessToken: 'pit-5b1c1c1c-3a3a-4b4b-8c8c-0123456789ab' };

/**
 * Contract test del puerto `GhlProvider` (CLAUDE.md: cada adaptador tiene fake y contract test). Lo cumplen el fake y el adaptador real (que se prueba contra un servidor simulado).
 * `failNext` deja al proveedor listo para fallar la próxima vez (solo el fake puede; el real usa su servidor simulado).
 */
export async function ghlProviderContract(make: () => { provider: GhlProvider; failNext: (e: GhlError) => void }): Promise<void> {
  const { provider, failNext } = make();
  // 1) una comprobación correcta devuelve el nombre (o null si GHL no lo informa)
  const ok = await provider.verify(CREDS);
  expect(ok).toHaveProperty('name');
  expect(ok.name === null || typeof ok.name === 'string').toBe(true);
  // 2) un fallo de credenciales y uno pasajero llegan como GhlError con sus banderas, sin perder el mensaje
  failNext(new GhlError('token rechazado', false, true));
  const bad = await provider.verify(CREDS).catch((e: unknown) => e);
  expect(bad).toBeInstanceOf(GhlError);
  expect(bad).toMatchObject({ retryable: false, credentials: true });
  expect((bad as GhlError).message).toContain('token rechazado'); // el adaptador real lo envuelve con su propio texto, sin perder el motivo
  failNext(new GhlError('límite de uso', true));
  const slow = await provider.verify(CREDS).catch((e: unknown) => e);
  expect(slow).toMatchObject({ retryable: true, credentials: false });
  // 3) tras un fallo la siguiente comprobación vuelve a funcionar
  await expect(provider.verify(CREDS)).resolves.toHaveProperty('name');
}
