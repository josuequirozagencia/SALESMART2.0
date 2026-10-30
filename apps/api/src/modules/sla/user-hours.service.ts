import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Database, userHours, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService } from '../organizations';
import { parseWeek, weekFromJson, weekHasOpenTime, weekToInput, weekToJson } from './calendar';
import type { WeekView } from './sla-config.service';
import type { HoursDto } from './sla.dto';

const AUDIT = 'user_hours';

/**
 * Horario laboral de una persona (M10.4, ADR-56 B3 #9). Con horario activo, el reparto automático solo le asigna conversaciones nuevas dentro de él (ver `SlaService.closedUsers`).
 * Quitarlo lo DESACTIVA (las tablas de negocio no tienen DELETE) y la persona vuelve a estar disponible siempre. Quien llama (el módulo de equipo) ya comprobó que la persona
 * es de la empresa del contexto y que quien pide tiene `users.manage`.
 */
@Injectable()
export class UserHoursService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  /** Los horarios activos de estas personas (las que no tienen, no aparecen). */
  async of(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, WeekView>> {
    const out = new Map<string, WeekView>();
    if (userIds.length === 0) return out;
    const rows = await tx.select({ userId: userHours.userId, days: userHours.days, active: userHours.active }).from(userHours);
    const wanted = new Set(userIds);
    for (const r of rows) if (r.active && wanted.has(r.userId) && weekHasOpenTime(weekFromJson(r.days))) out.set(r.userId, weekToInput(weekFromJson(r.days)));
    return out;
  }

  async get(userId: string): Promise<{ hours: WeekView | null; time_zone: string }> {
    const dir = await this.directory.current();
    const hours = await this.db.withTenant(async (tx) => (await this.of(tx, [userId])).get(userId) ?? null);
    return { hours, time_zone: dir.timeZone };
  }

  /** Guarda (o quita con `days: null`) el horario de la persona. */
  async set(userId: string, input: HoursDto): Promise<{ hours: WeekView | null; time_zone: string }> {
    const actor = TenantContext.current().userId ?? null;
    let json: number[][][] | null = null;
    if (input.days !== null) {
      const parsed = parseWeek(input.days);
      if (!parsed.ok) throw new ValidationError([{ path: `days.${parsed.path}`, code: 'invalid_hours', message: parsed.message }]);
      if (!weekHasOpenTime(parsed.week)) throw new ValidationError([{ path: 'days', code: 'invalid_hours', message: 'La semana debe tener al menos un día abierto (para dejar a la persona disponible siempre, quita el horario)' }]);
      json = weekToJson(parsed.week);
    }
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(userHours).where(eq(userHours.userId, userId)).for('update').limit(1);
      const before = cur && cur.active ? weekToInput(weekFromJson(cur.days)) : null;
      if (json === null) {
        if (!cur || !cur.active) return;
        await tx.update(userHours).set({ active: false, updatedBy: actor, updatedAt: new Date() }).where(eq(userHours.id, cur.id));
        await writeAudit(tx, { entityType: AUDIT, entityId: userId, oldValue: before, newValue: null, source: 'manual' });
        return;
      }
      if (cur) {
        if (cur.active && JSON.stringify(cur.days) === JSON.stringify(json)) return;
        await tx.update(userHours).set({ days: json, active: true, updatedBy: actor, updatedAt: new Date() }).where(eq(userHours.id, cur.id));
      } else {
        await tx.insert(userHours).values({ userId, days: json, updatedBy: actor });
      }
      await writeAudit(tx, { entityType: AUDIT, entityId: userId, oldValue: before, newValue: weekToInput(weekFromJson(json)), source: 'manual' });
    });
    return this.get(userId);
  }
}
