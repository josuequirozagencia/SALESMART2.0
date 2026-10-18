import { WhatsAppProviderError, type NumberInfo, type WhatsAppCredentials, type WhatsAppProvider } from './whatsapp.port';

/** Token que el fake da por válido (solo desarrollo y pruebas; la configuración prohíbe el fake en producción). */
export const FAKE_WHATSAPP_TOKEN = 'fake-valid-token';
/** Un número cuyo id empieza por esto «no existe» en el fake. */
export const FAKE_UNKNOWN_PREFIX = '00000';
/** Con este id el fake simula que Meta no responde. */
export const FAKE_UNAVAILABLE_ID = '99999999';

/**
 * WhatsApp de mentira (ADR-50 #9): determinista y sin red. Acepta `FAKE_WHATSAPP_TOKEN`; un número que empieza por `FAKE_UNKNOWN_PREFIX` no existe y
 * `FAKE_UNAVAILABLE_ID` simula una caída del proveedor. Cumple el mismo contract test que el adaptador de Meta.
 */
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake' as const;
  readonly calls: Array<{ phoneNumberId: string }> = [];

  describeNumber(credentials: WhatsAppCredentials, phoneNumberId: string): Promise<NumberInfo> {
    this.calls.push({ phoneNumberId });
    if (phoneNumberId === FAKE_UNAVAILABLE_ID) return Promise.reject(new WhatsAppProviderError('unavailable', 'El proveedor no responde'));
    if (credentials.accessToken !== FAKE_WHATSAPP_TOKEN) return Promise.reject(new WhatsAppProviderError('invalid_token', 'El proveedor rechazó el token'));
    if (phoneNumberId.startsWith(FAKE_UNKNOWN_PREFIX)) return Promise.reject(new WhatsAppProviderError('number_not_found', 'El proveedor no encontró ese número'));
    return Promise.resolve({ displayPhone: `+1 555 ${phoneNumberId.slice(-4).padStart(4, '0')}`, verifiedName: 'Negocio de prueba' });
  }
}
