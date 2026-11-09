import { describe, expect, it } from 'vitest';
import { explainPushError, keyToBytes } from '../src/lib/push';

describe('lib/push', () => {
  it('la clave pública VAPID (base64url) se convierte a bytes', () => {
    const bytes = keyToBytes('AQID-_8'); // 01 02 03 fb ff
    expect([...bytes]).toEqual([1, 2, 3, 251, 255]);
  });

  it('los errores del navegador al activar el push se explican en español, sin el texto en inglés', () => {
    const e = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(explainPushError(e('AbortError', 'Registration failed - permission denied'))).toMatch(/rechazó la activación/);
    expect(explainPushError(e('NotAllowedError', 'x'))).toMatch(/Windows, macOS o Android/);
    expect(explainPushError(e('AbortError', 'Registration failed - push service error'))).toMatch(/no respondió/);
    expect(explainPushError(e('SecurityError', 'Failed to register a ServiceWorker'))).toMatch(/preparar las notificaciones/);
    expect(explainPushError(e('InvalidAccessError', 'bad key'))).toMatch(/clave del servidor/);
    expect(explainPushError('raro')).toMatch(/No pudimos activar/);
    for (const m of [explainPushError(e('AbortError', 'Registration failed - permission denied')), explainPushError(null)]) expect(m).not.toMatch(/Registration failed/);
  });
});
