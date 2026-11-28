import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, memberHistory, users } from '../../../db';
import { NotFoundError } from '../../../errors';

export interface MyIdentity {
  email: string;
  full_name: string | null;
  phone: string | null;
}
export type MyProfileField = 'full_name' | 'phone';

/** Dónde dejar la historia del cambio, además de aplicarlo (en la misma transacción de identidad). `when`: solo si cambió el nombre, o con cualquier cambio. */
export interface ProfileHistory {
  organizationId: string;
  when: 'name' | 'any';
}

/**
 * Los datos propios de una persona en la identidad (V25, ADR-76): nombre y teléfono valen para todas sus empresas. Solo opera sobre el `userId` VERIFICADO que recibe de la sesión. El teléfono
 * nunca se registra: ni en la historia ni en la auditoría.
 */
@Injectable()
export class MyProfileStore {
  constructor(@Inject(Database) private readonly db: Database) {}

  async read(userId: string): Promise<MyIdentity> {
    const [u] = await this.db.withIdentity((tx) => tx.select({ email: users.email, full_name: users.fullName, phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1));
    if (!u) throw new NotFoundError();
    return u;
  }

  async update(userId: string, patch: { full_name?: string; phone?: string }, history: ProfileHistory | null): Promise<MyProfileField[]> {
    return this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ name: users.fullName, phone: users.phone }).from(users).where(eq(users.id, userId)).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      const changed: MyProfileField[] = [];
      if (patch.full_name !== undefined && patch.full_name !== cur.name) changed.push('full_name');
      if (patch.phone !== undefined && patch.phone !== cur.phone) changed.push('phone');
      if (changed.length === 0) return changed;
      await tx
        .update(users)
        .set({ ...(changed.includes('full_name') ? { fullName: patch.full_name! } : {}), ...(changed.includes('phone') ? { phone: patch.phone! } : {}), updatedAt: new Date() })
        .where(eq(users.id, userId));
      const name = changed.includes('full_name');
      if (history && (history.when === 'any' || name)) {
        await tx.insert(memberHistory).values({
          organizationId: history.organizationId,
          userId,
          changedBy: userId,
          kind: 'profile_updated',
          before: name ? { name: cur.name } : null,
          after: { fields: changed, ...(name ? { name: patch.full_name } : {}) },
        });
      }
      return changed;
    });
  }
}
