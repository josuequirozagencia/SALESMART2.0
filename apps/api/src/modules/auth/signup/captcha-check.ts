import { AppError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import type { CaptchaVerifier } from './ports';

/** Verifica el CAPTCHA fallando cerrado (error del proveedor = inválido). Compartido por registro y olvido de contraseña. */
export async function requireCaptcha(captcha: CaptchaVerifier, log: AppLogger, token: string, ip?: string): Promise<void> {
  let ok = false;
  try {
    ok = await captcha.verify({ token, ...(ip ? { ip } : {}) });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'CaptchaVerifier falló (se trata como inválido)');
  }
  if (!ok) throw new AppError(400, 'CAPTCHA_FAILED', 'No se pudo verificar que eres una persona. Inténtalo de nuevo');
}
