import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, organizations } from '../../db';
import { NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { OrgDirectoryService } from './org-directory.service';

export interface OrgIdentityProfile {
  name: string;
  country: string | null;
  timezone: string;
  currency: string;
}
export type OrgIdentityPatch = Partial<Pick<OrgIdentityProfile, 'name' | 'country' | 'timezone'>>;

/**
 * La parte de identidad del perfil de la empresa del contexto (V25, ADR-76): nombre, país y zona horaria viven en `organizations` (solo `app_identity`). La empresa sale SIEMPRE del
 * TenantContext. Se llama FUERA de toda transacción de negocio.
 */
@Injectable()
export class OrgIdentityProfileService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async read(): Promise<OrgIdentityProfile> {
    const org = TenantContext.current().organizationId;
    const [row] = await this.db.withIdentity((tx) =>
      tx.select({ name: organizations.name, country: organizations.country, timezone: organizations.timezone, currency: organizations.currency }).from(organizations).where(eq(organizations.id, org)).limit(1),
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  /** Cambia solo lo que difiere (con la fila bloqueada) y devuelve cómo estaba y qué cambió. Olvida la zona horaria guardada en memoria. */
  async update(patch: OrgIdentityPatch): Promise<{ before: OrgIdentityProfile; changed: Array<keyof OrgIdentityPatch> }> {
    const org = TenantContext.current().organizationId;
    const out = await this.db.withIdentity(async (tx) => {
      const [before] = await tx
        .select({ name: organizations.name, country: organizations.country, timezone: organizations.timezone, currency: organizations.currency })
        .from(organizations)
        .where(eq(organizations.id, org))
        .for('update')
        .limit(1);
      if (!before) throw new NotFoundError();
      const changed = (['name', 'country', 'timezone'] as const).filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
      if (changed.length > 0) await tx.update(organizations).set({ ...Object.fromEntries(changed.map((k) => [k, patch[k]])), updatedAt: new Date() }).where(eq(organizations.id, org));
      return { before, changed };
    });
    if (out.changed.includes('timezone')) this.directory.invalidate();
    return out;
  }
}
