import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { businessHours, Database, holidays, queues, slaPolicies, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService } from '../organizations';
import { isOpenAt, parseWeek, weekFromJson, weekHasOpenTime, weekToInput, weekToJson, type WeekdayKey } from './calendar';
import { MAX_HOLIDAYS, type HolidayDto, type HoursDto, type PolicyDto } from './sla.dto';
import { SlaService } from './sla.service';

export type WeekView = Record<WeekdayKey, Array<[string, string]>>;

export interface HolidayView {
  id: string;
  /** AAAA-MM-DD. */
  date: string;
  name: string;
  yearly: boolean;
}

export interface SlaSettings {
  policy: { target_minutes: number; risk_minutes: number };
  /** Horario de la empresa; null = sin horario (abierta siempre). */
  hours: WeekView | null;
  holidays: HolidayView[];
  /** Zona horaria de la empresa (se fija al crearla). */
  time_zone: string;
  /** ¿Está abierta ahora (con su horario y sus feriados)? */
  open_now: boolean;
}

const POLICY_AUDIT = 'sla_policy';
const HOURS_AUDIT = 'business_hours';
const HOLIDAY_AUDIT = 'holiday';

/**
 * Configuración del SLA, el horario laboral y los feriados (M5.5b, ADR-50). Solo `sla.manage` (administrador) para la empresa y `queues.manage` para el horario propio de
 * una cola; lo exigen los controladores. Cada cambio queda en la auditoría. La zona horaria es la de la empresa (identidad) y se lee antes de la transacción.
 */
@Injectable()
export class SlaConfigService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async get(): Promise<SlaSettings> {
    const dir = await this.directory.current({ fresh: true });
    const now = new Date();
    return this.db.withTenant(async (tx) => {
      const policy = await this.sla.policy(tx);
      const [org] = await tx.select({ days: businessHours.days }).from(businessHours).where(eq(businessHours.scope, 'org')).limit(1);
      const rows = await tx.select({ id: holidays.id, day: holidays.day, name: holidays.name, yearly: holidays.yearly }).from(holidays).where(isNull(holidays.deletedAt)).orderBy(asc(holidays.day), asc(holidays.id));
      const cals = await this.sla.calendars(tx, dir.timeZone);
      return {
        policy: { target_minutes: policy.targetMinutes, risk_minutes: policy.riskMinutes },
        hours: org && weekHasOpenTime(weekFromJson(org.days)) ? weekToInput(weekFromJson(org.days)) : null,
        holidays: rows.map((r) => ({ id: r.id, date: r.day, name: r.name, yearly: r.yearly })),
        time_zone: dir.timeZone,
        open_now: isOpenAt(cals.forQueue(null), now),
      };
    });
  }

  async setPolicy(input: PolicyDto): Promise<SlaSettings> {
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(slaPolicies).for('update').limit(1);
      const userId = TenantContext.current().userId ?? null;
      const now = new Date();
      if (!cur) {
        const [row] = await tx.insert(slaPolicies).values({ targetMinutes: input.target_minutes, riskMinutes: input.risk_minutes, updatedBy: userId }).returning({ id: slaPolicies.id });
        await writeAudit(tx, { entityType: POLICY_AUDIT, entityId: row!.id, newValue: { target_minutes: input.target_minutes, risk_minutes: input.risk_minutes }, source: 'manual' });
        return;
      }
      if (cur.targetMinutes === input.target_minutes && cur.riskMinutes === input.risk_minutes) return;
      await tx.update(slaPolicies).set({ targetMinutes: input.target_minutes, riskMinutes: input.risk_minutes, updatedBy: userId, updatedAt: now }).where(eq(slaPolicies.id, cur.id));
      await writeAudit(tx, { entityType: POLICY_AUDIT, entityId: cur.id, oldValue: { target_minutes: cur.targetMinutes, risk_minutes: cur.riskMinutes }, newValue: { target_minutes: input.target_minutes, risk_minutes: input.risk_minutes }, source: 'manual' });
    });
    return this.get();
  }

  /** Horario de la empresa; `null` la deja abierta siempre. */
  async setHours(input: HoursDto): Promise<SlaSettings> {
    await this.db.withTenant((tx) => this.saveHours(tx, 'org', null, input));
    return this.get();
  }

  /** Horario propio de una cola; `null` vuelve a usar el de la empresa. 404 si la cola no existe. */
  async setQueueHours(queueId: string, input: HoursDto): Promise<void> {
    await this.db.withTenant(async (tx) => {
      const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, queueId), isNull(queues.deletedAt))).for('update').limit(1);
      if (!q) throw new NotFoundError();
      await this.saveHours(tx, 'queue', queueId, input);
    });
  }

  /** El horario propio de cada cola indicada (las que no tienen, no aparecen). */
  async queueHours(tx: TenantTx, queueIds: readonly string[]): Promise<Map<string, WeekView>> {
    const out = new Map<string, WeekView>();
    if (queueIds.length === 0) return out;
    const rows = await tx.select({ queueId: businessHours.queueId, days: businessHours.days }).from(businessHours).where(eq(businessHours.scope, 'queue'));
    const wanted = new Set(queueIds);
    for (const r of rows) if (r.queueId && wanted.has(r.queueId) && weekHasOpenTime(weekFromJson(r.days))) out.set(r.queueId, weekToInput(weekFromJson(r.days)));
    return out;
  }

  async addHoliday(input: HolidayDto): Promise<HolidayView> {
    return this.db
      .withTenant(async (tx) => {
        const [n] = await tx.select({ n: count() }).from(holidays).where(isNull(holidays.deletedAt));
        if ((n?.n ?? 0) >= MAX_HOLIDAYS) throw new ConflictError('HOLIDAY_LIMIT', `Se alcanzó el máximo de ${MAX_HOLIDAYS} feriados. Quita alguno para agregar otro`);
        const [row] = await tx.insert(holidays).values({ day: input.date, name: input.name, yearly: input.yearly, createdBy: TenantContext.current().userId ?? null }).returning({ id: holidays.id, day: holidays.day, name: holidays.name, yearly: holidays.yearly });
        await writeAudit(tx, { entityType: HOLIDAY_AUDIT, entityId: row!.id, newValue: { date: row!.day, name: row!.name, yearly: row!.yearly }, source: 'manual' });
        return { id: row!.id, date: row!.day, name: row!.name, yearly: row!.yearly };
      })
      .catch((e: unknown) => {
        const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
        if (cause?.code === '23505' && cause.constraint === 'holidays_org_day_uq') throw new ConflictError('HOLIDAY_EXISTS', 'Ya hay un feriado en esa fecha');
        throw e;
      });
  }

  async removeHoliday(id: string): Promise<{ id: string; removed: true }> {
    await this.db.withTenant(async (tx) => {
      const [h] = await tx.select({ day: holidays.day, name: holidays.name, yearly: holidays.yearly }).from(holidays).where(and(eq(holidays.id, id), isNull(holidays.deletedAt))).for('update').limit(1);
      if (!h) throw new NotFoundError();
      await tx.update(holidays).set({ deletedAt: new Date() }).where(eq(holidays.id, id));
      await writeAudit(tx, { entityType: HOLIDAY_AUDIT, entityId: id, oldValue: { date: h.day, name: h.name, yearly: h.yearly }, newValue: null, source: 'manual' });
    });
    return { id, removed: true };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Guarda (o quita) el horario de la empresa o de una cola, ya validado. */
  private async saveHours(tx: TenantTx, scope: 'org' | 'queue', queueId: string | null, input: HoursDto): Promise<void> {
    const where = scope === 'org' ? eq(businessHours.scope, 'org') : and(eq(businessHours.scope, 'queue'), eq(businessHours.queueId, queueId!));
    const [cur] = await tx.select().from(businessHours).where(where).for('update').limit(1);
    const entity = cur?.id ?? queueId ?? 'org';
    if (input.days === null) {
      if (!cur) return;
      await tx.delete(businessHours).where(eq(businessHours.id, cur.id));
      await writeAudit(tx, { entityType: HOURS_AUDIT, entityId: cur.id, oldValue: { scope, queue_id: queueId, days: weekToInput(weekFromJson(cur.days)) }, newValue: null, source: 'manual' });
      return;
    }
    const parsed = parseWeek(input.days);
    if (!parsed.ok) throw new ValidationError([{ path: `days.${parsed.path}`, code: 'invalid_hours', message: parsed.message }]);
    if (!weekHasOpenTime(parsed.week)) throw new ValidationError([{ path: 'days', code: 'invalid_hours', message: 'La semana debe tener al menos un día abierto (para dejarla abierta siempre, quita el horario)' }]);
    const json = weekToJson(parsed.week);
    const userId = TenantContext.current().userId ?? null;
    if (cur) {
      if (JSON.stringify(cur.days) === JSON.stringify(json)) return;
      await tx.update(businessHours).set({ days: json, updatedBy: userId, updatedAt: new Date() }).where(eq(businessHours.id, cur.id));
      await writeAudit(tx, { entityType: HOURS_AUDIT, entityId: cur.id, oldValue: { scope, queue_id: queueId, days: weekToInput(weekFromJson(cur.days)) }, newValue: { scope, queue_id: queueId, days: weekToInput(parsed.week) }, source: 'manual' });
      return;
    }
    const [row] = await tx.insert(businessHours).values({ scope, queueId, days: json, updatedBy: userId }).returning({ id: businessHours.id });
    await writeAudit(tx, { entityType: HOURS_AUDIT, entityId: row?.id ?? entity, newValue: { scope, queue_id: queueId, days: weekToInput(parsed.week) }, source: 'manual' });
  }
}
