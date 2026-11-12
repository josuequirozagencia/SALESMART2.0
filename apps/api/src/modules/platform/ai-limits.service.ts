import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { aiLimits, Database } from '../../db';
import { PlatformContext, TenantContext } from '../../tenant';
import { PlatformAuditService } from './platform-audit.service';

/** Usuario «del sistema» para lecturas de plataforma que no vienen de una persona (la comprobación del tope en la ruta del cliente y en las tareas). Solo lectura: nunca firma una auditoría. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const CACHE_MS = 30_000;

/** Topes diarios de la IA por empresa (cada uno cuenta las últimas 24 horas). */
export interface AiLimits {
  /** Mensajes de prueba del simulador de un agente. */
  readonly testsPerDay: number;
  /** Sugerencias de respuesta para quien atiende. */
  readonly suggestionsPerDay: number;
  /** Seguimientos automáticos enviados por los agentes. */
  readonly followUpsPerDay: number;
}

export interface AiLimitsView {
  tests_per_day: number;
  suggestions_per_day: number;
  follow_ups_per_day: number;
  updated_at: string;
}

/** Los valores con que nace la plataforma (los que antes iban fijos en el código; la migración siembra los mismos). */
export const DEFAULT_AI_LIMITS: AiLimits = { testsPerDay: 100, suggestionsPerDay: 50, followUpsPerDay: 200 };

/**
 * Topes diarios de la IA (v11): tabla de PLATAFORMA con una sola fila. El Súper Admin los cambia; los servicios de prueba, sugerencias y seguimientos los leen antes de actuar (con memoria de 30 s;
 * un cambio se ve de inmediato en la instancia que lo guarda y en 30 s en las demás). El tope es para toda la plataforma: cada empresa tiene su propio conteo contra el mismo número.
 */
@Injectable()
export class AiLimitsService {
  private cache: { at: number; value: AiLimits } | null = null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  /** Los topes vigentes. Lo pueden llamar la ruta del cliente y las tareas (sin contexto de plataforma): leen como «el sistema». Debe llamarse ANTES de abrir una transacción de empresa. */
  async resolve(now = Date.now()): Promise<AiLimits> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const read = () => this.db.withPlatform((tx) => tx.select().from(aiLimits).where(eq(aiLimits.id, 1)).limit(1));
    // Desde una petición o una tarea de empresa se sale de su contexto para leer como «el sistema» (los contextos no se anidan)
    const [row] = PlatformContext.currentOrNull() ? await read() : await TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
    if (!row) throw new Error('ai_limits sin fila: la migración 0136 la siembra'); // no es un error del cliente
    const value: AiLimits = { testsPerDay: row.testsPerDay, suggestionsPerDay: row.suggestionsPerDay, followUpsPerDay: row.followUpsPerDay };
    this.cache = { at: now, value };
    return value;
  }

  async get(): Promise<AiLimitsView> {
    const [r] = await this.db.withPlatform((tx) => tx.select().from(aiLimits).where(eq(aiLimits.id, 1)).limit(1));
    if (!r) throw new Error('ai_limits sin fila: la migración 0136 la siembra');
    return { tests_per_day: r.testsPerDay, suggestions_per_day: r.suggestionsPerDay, follow_ups_per_day: r.followUpsPerDay, updated_at: r.updatedAt.toISOString() };
  }

  async set(input: { tests_per_day: number; suggestions_per_day: number; follow_ups_per_day: number }): Promise<AiLimitsView> {
    const actor = PlatformContext.current().actorUserId;
    const before = await this.get();
    await this.db.withPlatform((tx) =>
      tx.update(aiLimits).set({ testsPerDay: input.tests_per_day, suggestionsPerDay: input.suggestions_per_day, followUpsPerDay: input.follow_ups_per_day, updatedAt: new Date(), updatedBy: actor }).where(eq(aiLimits.id, 1)),
    );
    this.cache = null;
    await this.audit.record({
      action: 'ai.limits.update',
      entityType: 'ai_limits',
      details: {
        before: { tests_per_day: before.tests_per_day, suggestions_per_day: before.suggestions_per_day, follow_ups_per_day: before.follow_ups_per_day },
        after: input,
      },
    });
    return this.get();
  }

  invalidate(): void {
    this.cache = null;
  }
}
