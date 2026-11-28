import { Inject, Injectable } from '@nestjs/common';
import { Database, organizationProfiles, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgIdentityProfileService, type OrgIdentityProfile } from '../organizations';
import { hasSales } from '../sales';
import type { UpdateProfileDto } from './organization-profile.dto';

/** Campo de la API → columna de la tabla. */
const FIELDS = {
  legal_name: 'legalName',
  tax_id: 'taxId',
  contact_phone: 'contactPhone',
  contact_email: 'contactEmail',
  website: 'website',
  address: 'address',
  city: 'city',
  description: 'description',
} as const;
type Field = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as Field[];

export type ProfileView = OrgIdentityProfile & Record<Field, string | null> & { currency_locked: boolean; currency_locked_reason: string | null; access: { edit: boolean } };

type Row = typeof organizationProfiles.$inferSelect;

/**
 * Perfil de la empresa (V25, ADR-76). El nombre, el país y la zona horaria son IDENTIDAD (`OrgIdentityProfileService`); los datos básicos, una tabla de negocio. Cada petición usa dos
 * transacciones separadas (roles distintos, ADR-25): primero identidad y después negocio con la auditoría. Si la segunda fallara, queda en el registro estructurado qué cambió sin auditar.
 * La moneda se lee aquí pero se cambia con las reglas de ventas.
 */
@Injectable()
export class OrganizationProfileService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgIdentityProfileService) private readonly identity: OrgIdentityProfileService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async get(canEdit: boolean): Promise<ProfileView> {
    const org = await this.identity.read();
    const { row, locked } = await this.db.withTenant(async (tx) => ({ row: await this.row(tx), locked: await hasSales(tx) }));
    return {
      ...org,
      ...(Object.fromEntries(FIELD_KEYS.map((f) => [f, row?.[FIELDS[f]] ?? null])) as Record<Field, string | null>),
      currency_locked: locked,
      currency_locked_reason: locked ? 'Ya hay ventas registradas: la moneda de la empresa no se puede cambiar' : null,
      access: { edit: canEdit },
    };
  }

  async update(dto: UpdateProfileDto): Promise<ProfileView> {
    const identity = await this.identity.update({
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.country !== undefined ? { country: dto.country } : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
    });
    try {
      await this.db.withTenant(async (tx) => {
        const current = await this.row(tx);
        const changed = FIELD_KEYS.filter((f) => dto[f] !== undefined && dto[f] !== (current?.[FIELDS[f]] ?? null));
        if (changed.length > 0) {
          const values = Object.fromEntries(changed.map((f) => [FIELDS[f], dto[f] ?? null]));
          const stamp = { updatedBy: TenantContext.current().userId ?? null, updatedAt: new Date() };
          await tx
            .insert(organizationProfiles)
            .values({ ...values, ...stamp })
            .onConflictDoUpdate({ target: organizationProfiles.organizationId, set: { ...values, ...stamp } });
        }
        const fields: string[] = [...identity.changed, ...changed];
        if (fields.length === 0) return;
        // Del nombre, el país y la zona se guarda antes y después; de los datos de contacto, SOLO el nombre del campo (nunca el valor)
        const shown = identity.changed;
        await writeAudit(tx, {
          entityType: 'organization.profile',
          entityId: TenantContext.current().organizationId,
          field: 'update',
          oldValue: shown.length > 0 ? Object.fromEntries(shown.map((k) => [k, identity.before[k]])) : null,
          newValue: { fields, ...Object.fromEntries(shown.map((k) => [k, dto[k]])) },
          source: 'manual',
        });
      });
    } catch (e) {
      if (identity.changed.length > 0) this.log.error({ org_id: TenantContext.current().organizationId, fields: identity.changed }, 'perfil de empresa: el cambio de identidad se guardó pero falló lo demás (sin auditoría)');
      throw e;
    }
    return this.get(true);
  }

  private async row(tx: TenantTx): Promise<Row | undefined> {
    const [row] = await tx.select().from(organizationProfiles).limit(1);
    return row;
  }
}
