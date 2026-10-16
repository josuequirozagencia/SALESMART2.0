import { expect } from 'vitest';
import { CapiSendError, type CapiEvent, type CapiProvider } from '../../src/modules/attribution';

/**
 * Contract test del puerto `CapiProvider` (CLAUDE.md: cada adaptador tiene fake y contract test). Lo cumplen el fake y, en M6, el adaptador real
 * (que se prueba contra un servidor simulado). `prepare` deja al proveedor listo para fallar la próxima vez (solo el fake puede; el real usa su servidor simulado).
 */
export const sampleEvent = (over: Partial<CapiEvent> = {}): CapiEvent => ({
  eventId: 'purchase:contract-1',
  type: 'Purchase',
  eventTime: new Date('2026-10-16T12:00:00.000Z'),
  payload: { event_name: 'Purchase', custom_data: { value: 100, currency: 'USD' } },
  ...over,
});

export async function capiProviderContract(make: () => { provider: CapiProvider; failNext: (e: CapiSendError) => void }): Promise<void> {
  const { provider, failNext } = make();
  // 1) un envío correcto resuelve sin devolver nada
  await expect(provider.send(sampleEvent())).resolves.toBeUndefined();
  // 2) un fallo reintentable y uno definitivo llegan como CapiSendError con su bandera, sin perder el mensaje
  failNext(new CapiSendError('límite de peticiones', true));
  const retry = await provider.send(sampleEvent({ eventId: 'e2' })).catch((e: unknown) => e);
  expect(retry).toBeInstanceOf(CapiSendError);
  expect((retry as CapiSendError).retryable).toBe(true);
  failNext(new CapiSendError('token rechazado', false));
  const fatal = await provider.send(sampleEvent({ eventId: 'e3' })).catch((e: unknown) => e);
  expect((fatal as CapiSendError).retryable).toBe(false);
  expect((fatal as CapiSendError).message).toBe('token rechazado');
  // 3) tras un fallo el siguiente envío vuelve a funcionar
  await expect(provider.send(sampleEvent({ eventId: 'e4' }))).resolves.toBeUndefined();
}
