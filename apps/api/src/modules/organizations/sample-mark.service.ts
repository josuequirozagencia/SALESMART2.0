import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Database, organizations } from '../../db';

/**
 * Marca de «ya se crearon los datos de ejemplo» de una empresa (M10.6, ADR-56 B5): `organizations.sample_seeded_at`, que es de identidad. Con ella, lo que el cliente borre de los
 * ejemplos no reaparece. La empresa se pasa explícita (la lee de su contexto quien llama).
 */
@Injectable()
export class SampleMarkService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async isSeeded(organizationId: string): Promise<boolean> {
    const [o] = await this.db.withIdentity((tx) => tx.select({ at: organizations.sampleSeededAt }).from(organizations).where(eq(organizations.id, organizationId)).limit(1));
    return o?.at !== undefined && o.at !== null;
  }

  /** Marca la empresa; solo la primera vez (condicional): devuelve si esta llamada fue la que la marcó. */
  async markSeeded(organizationId: string, now = new Date()): Promise<boolean> {
    const rows = await this.db.withIdentity((tx) =>
      tx.update(organizations).set({ sampleSeededAt: now }).where(and(eq(organizations.id, organizationId), eq(organizations.kind, 'client'), isNull(organizations.sampleSeededAt))).returning({ id: organizations.id }),
    );
    return rows.length > 0;
  }
}
