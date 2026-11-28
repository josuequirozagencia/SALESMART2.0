import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../db';
import { TooManyAttemptsError, UnauthorizedError } from '../../errors';
import { WindowLimiter } from '../../http';
import type { Principal } from '../../http/access-resolver';
import { writeAudit } from '../audit';
import { MyProfileStore, type MyIdentity, type ProfileHistory } from '../auth';
import { PlatformAuditService } from '../platform';
import { UserHoursService, type WeekView } from '../sla';
import type { UpdateMyProfileDto } from './my-profile.dto';

export type MyProfileView = MyIdentity & {
  /** Horario propio (solo lectura; lo fija el administrador). null = disponible siempre o no aplica. */
  hours: WeekView | null;
  time_zone: string | null;
  /** ¿Puede poner foto en la empresa actual? Solo quien es miembro de ella y ve conversaciones. */
  photo: boolean;
};

/** Cambios de perfil permitidos por persona en la ventana. */
export const PROFILE_CHANGES_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60_000;

type Tenant = Extract<Principal, { kind: 'tenant' }>;
/** La persona está en SU empresa (no actuando como soporte ni agencia dentro de un cliente). */
const member = (p: Principal): p is Tenant => p.kind === 'tenant' && p.actingAs === undefined;

/**
 * «Mi perfil» (V25, ADR-76). Todo se hace sobre la persona de la sesión: no acepta identificadores de usuario ni de empresa. Dónde queda constancia del cambio:
 *  - miembro en su empresa → auditoría de la empresa (solo nombres de campos) y, si cambió el nombre, la historia del equipo;
 *  - soporte o agencia dentro de un cliente → historia de SU empresa de origen, nunca la del cliente;
 *  - Súper Admin en la Consola → auditoría de plataforma.
 */
@Injectable()
export class MyProfileService {
  private readonly limiter = new WindowLimiter(PROFILE_CHANGES_PER_WINDOW, WINDOW_MS);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MyProfileStore) private readonly store: MyProfileStore,
    @Inject(UserHoursService) private readonly hours: UserHoursService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
  ) {}

  async get(p: Principal | undefined): Promise<MyProfileView> {
    if (!p) throw new UnauthorizedError();
    const identity = await this.store.read(p.userId);
    const own = member(p) ? await this.hours.get(p.userId) : null;
    return { ...identity, hours: own?.hours ?? null, time_zone: own?.time_zone ?? null, photo: member(p) && p.permissions?.has('inbox.read') === true };
  }

  async update(p: Principal | undefined, dto: UpdateMyProfileDto): Promise<MyProfileView> {
    if (!p) throw new UnauthorizedError();
    const take = this.limiter.take(p.userId);
    if (!take.ok) throw new TooManyAttemptsError(take.retryAfterSeconds);
    const history: ProfileHistory | null = p.kind !== 'tenant' ? null : p.actingAs === undefined ? { organizationId: p.organizationId, when: 'name' } : p.actingOrgId ? { organizationId: p.actingOrgId, when: 'any' } : null;
    const changed = await this.store.update(p.userId, { ...(dto.full_name !== undefined ? { full_name: dto.full_name } : {}), ...(dto.phone !== undefined ? { phone: dto.phone } : {}) }, history);
    if (changed.length > 0) {
      if (p.kind === 'platform') await this.platformAudit.record({ action: 'user.profile.update', entityType: 'user', entityId: p.userId, details: { fields: changed } });
      else if (member(p)) await this.db.withTenant((tx) => writeAudit(tx, { entityType: 'user.profile', entityId: p.userId, field: 'update', newValue: { fields: changed }, source: 'manual' }));
    }
    return this.get(p);
  }
}
