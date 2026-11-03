import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, users } from '../../../db';
import { AppError, TooManyAttemptsError, UnauthorizedError } from '../../../errors';
import type { PasswordHasher } from '../../../security';
import { PASSWORD_HASHER } from '../auth.tokens';
import { ThrottleService } from '../throttle.service';

/**
 * Confirmar la contraseña de una persona antes de una acción destructiva o de un dato sensible (F3a eliminar/recuperar una empresa, F3b pedir o bajar la copia de sus datos). Se compara con su hash y
 * comparte el contador de intentos del inicio de sesión de esa persona (5 fallos ⇒ 429, también con la contraseña buena): una sesión robada o un enlace filtrado no pueden adivinarla sin límite.
 * Un fallo cuenta y NO cierra la sesión ni toca nada.
 */
@Injectable()
export class PasswordConfirmationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
  ) {}

  async confirm(userId: string, password: string): Promise<void> {
    const [u] = await this.db.withIdentity((tx) => tx.select({ email: users.email, hash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1));
    if (!u) throw new UnauthorizedError();
    const key = this.throttle.keyFor('e', u.email);
    const wait = await this.throttle.waitSeconds([key]);
    if (wait > 0) throw new TooManyAttemptsError(wait);
    if (!(await this.hasher.verify(u.hash, password))) {
      await this.throttle.recordFailure(key);
      throw new AppError(403, 'PASSWORD_INVALID', 'La contraseña no es correcta');
    }
    await this.throttle.reset(key);
  }
}
