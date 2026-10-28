import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { Database, qrRoutes } from '../../db';
import { TenantContext } from '../../tenant';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
/** Hash de relleno: una ruta desconocida cuesta lo mismo que un token equivocado (no se distingue por tiempo). */
const DUMMY_HASH = sha256('sin-ruta-qr');
const TOUCH_EVERY_MS = 60_000;

export interface QrRoute {
  readonly organizationId: string;
  readonly channelAccountId: string;
}

/**
 * Punto de entrada del webhook de cada conexión de WhatsApp por QR (M9.6, ADR-54). Tabla de IDENTIDAD: Evolution avisa sin sesión y hay que saber de qué empresa y conexión es antes de que exista
 * contexto. El token solo se guarda como hash SHA-256 y se entrega UNA vez (para armar la dirección que Evolution llamará). La empresa de `issue`/`revoke` sale siempre de `TenantContext`.
 */
@Injectable()
export class QrRoutesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Empresas con alguna conexión QR (el latido solo recorre estas, no todas las empresas). */
  async organizationIds(): Promise<string[]> {
    const rows = await this.db.withIdentity((tx) => tx.selectDistinct({ id: qrRoutes.organizationId }).from(qrRoutes));
    return rows.map((r) => r.id);
  }

  /** Crea la ruta de la conexión o ROTA su token (el anterior deja de servir al instante). Devuelve el identificador y el token en claro esta única vez. */
  async issue(channelAccountId: string): Promise<{ id: string; token: string }> {
    const organizationId = TenantContext.current().organizationId;
    const token = `qrw_${randomBytes(32).toString('base64url')}`;
    const hash = sha256(token);
    const id = await this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ id: qrRoutes.id }).from(qrRoutes).where(and(eq(qrRoutes.organizationId, organizationId), eq(qrRoutes.channelAccountId, channelAccountId))).limit(1);
      if (cur) {
        await tx.update(qrRoutes).set({ tokenHash: hash, rotatedAt: new Date() }).where(eq(qrRoutes.id, cur.id));
        return cur.id;
      }
      const fresh = randomUUID(); // v4: no secuencial ni derivado de la empresa
      await tx.insert(qrRoutes).values({ id: fresh, organizationId, channelAccountId, tokenHash: hash });
      return fresh;
    });
    return { id, token };
  }

  /** La ruta deja de servir (al borrar la conexión): el token pasa a un valor que nadie conoce. La fila queda (la tabla no se borra). */
  async revoke(channelAccountId: string): Promise<void> {
    const organizationId = TenantContext.current().organizationId;
    await this.db.withIdentity((tx) => tx.update(qrRoutes).set({ tokenHash: sha256(randomBytes(32).toString('hex')), rotatedAt: new Date() }).where(and(eq(qrRoutes.organizationId, organizationId), eq(qrRoutes.channelAccountId, channelAccountId))));
  }

  /** Empresa y conexión dueñas de la ruta si el token es el vigente; null en cualquier otro caso (sin distinguir la causa). */
  async resolve(id: string, token: string, now = new Date()): Promise<QrRoute | null> {
    const [row] = await this.db.withIdentity((tx) => tx.select({ organizationId: qrRoutes.organizationId, channelAccountId: qrRoutes.channelAccountId, tokenHash: qrRoutes.tokenHash }).from(qrRoutes).where(eq(qrRoutes.id, id)).limit(1));
    const expected = Buffer.from(row?.tokenHash ?? DUMMY_HASH, 'hex');
    const given = Buffer.from(sha256(token), 'hex');
    if (!row || !timingSafeEqual(expected, given)) return null;
    await this.db.withIdentity((tx) =>
      tx
        .update(qrRoutes)
        .set({ lastUsedAt: now })
        .where(and(eq(qrRoutes.id, id), or(isNull(qrRoutes.lastUsedAt), lt(qrRoutes.lastUsedAt, new Date(now.getTime() - TOUCH_EVERY_MS))))),
    );
    return { organizationId: row.organizationId, channelAccountId: row.channelAccountId };
  }
}
