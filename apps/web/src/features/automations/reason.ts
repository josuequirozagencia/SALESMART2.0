import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';

/** El motivo de un rechazo: si el servidor detalla qué falta (en español, pensado para la persona), eso; si no, el mensaje habitual. */
export function reason(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.details.length > 0) return e.details.map((d) => d.message).join(' ');
  return friendlyError(e, fallback);
}
