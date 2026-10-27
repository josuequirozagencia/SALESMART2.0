import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { automationRuns, automationRunSteps, automations, contacts, Database, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { withAutomationOrigin } from '../events';
import type { OrgDirectory } from '../organizations';
import { ActionFailed, ActionSkipped, AutomationActionsService } from './automation-actions.service';
import { actionSchema, waitMs, waitText, type ActionDef } from './automation-model';

/** Ejecuciones que una pasada toma por empresa. */
export const RUN_BATCH = 25;
/** Intentos ante un error inesperado (la espera crece: 10 s, 20 s…) antes de darla por fallida. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 10_000;
/** Ejecuciones que llevan tanto tiempo en cola que ya no tienen sentido (la empresa estuvo sin tarea, p. ej. un despliegue largo). */
export const STALE_MS = 24 * 60 * 60 * 1000;

type Run = typeof automationRuns.$inferSelect;
type Outcome = 'done' | 'skipped' | 'failed' | 'retry' | 'waiting';

/**
 * El motor de las automatizaciones (M9.3, ADR-54; F20): toma las ejecuciones en cola y hace lo que la regla dice. Cada ejecución corre ENTERA en una transacción (`FOR UPDATE SKIP LOCKED`: varias
 * instancias no pisan la misma): o quedan todas sus acciones o ninguna. Cada acción va en su `SAVEPOINT`, así que una que no se puede hacer (algo que nombra ya no existe, no hay a quién…) se registra y las
 * demás siguen. Un error inesperado revierte la ejecución completa y se reintenta con espera creciente; tras {@link MAX_ATTEMPTS} intentos queda como fallida. Todo lo que la ejecución provoca
 * se anuncia con su origen (`withAutomationOrigin`) para que el encolador corte los ciclos. La regla se vuelve a leer al ejecutar: si se pausó o se borró después del hecho, la ejecución se descarta.
 */
@Injectable()
export class AutomationRunnerService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AutomationActionsService) private readonly actions: AutomationActionsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Una pasada bajo el TenantContext de la empresa. Devuelve cuántas ejecuciones resolvió. */
  async runDue(now: Date, dir: OrgDirectory, batch = RUN_BATCH): Promise<number> {
    const ids = await this.db.withTenant((tx) =>
      tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.status, 'queued'), lte(automationRuns.nextAttemptAt, now)))
        .orderBy(asc(automationRuns.nextAttemptAt), asc(automationRuns.id))
        .limit(batch),
    );
    let resolved = 0;
    for (const { id } of ids) {
      const outcome = await this.runOne(id, now, dir).catch((e: unknown) => this.unexpected(id, e, now));
      if (outcome !== 'retry') resolved += 1;
    }
    return resolved;
  }

  private async runOne(id: string, now: Date, dir: OrgDirectory): Promise<Outcome> {
    return this.db.withTenant(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(and(eq(automationRuns.id, id), eq(automationRuns.status, 'queued'))).limit(1).for('update', { skipLocked: true });
      if (!run) return 'skipped'; // otra instancia la tomó o ya se resolvió
      // Una ejecución que ya empezó y está esperando puede tardar días: lo de «demasiado tiempo en cola» solo vale para la que aún no empezó
      const resuming = run.resumeActions !== null;
      if (!resuming && now.getTime() - run.createdAt.getTime() > STALE_MS) return this.close(tx, run, 'skipped', 'Quedó en cola demasiado tiempo y ya no se ejecuta', now);

      const [rule] = await tx.select().from(automations).where(and(eq(automations.id, run.automationId), eq(automations.status, 'active'), isNull(automations.deletedAt))).limit(1);
      if (!rule) return this.close(tx, run, 'skipped', 'La automatización se pausó o se borró antes de ejecutarse', now);
      const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, run.contactId), isNull(contacts.deletedAt))).limit(1);
      if (!contact) return this.close(tx, run, 'skipped', 'El contacto ya no existe', now);

      await tx.update(automationRuns).set({ startedAt: run.startedAt ?? now }).where(eq(automationRuns.id, run.id));
      const origin = { runId: run.id, depth: run.depth, chain: run.chain };
      // Lo que falta por hacer: tras una espera, las acciones tal como eran al empezar (editar la regla no cambia lo que ya empezó)
      const pending = (resuming ? run.resumeActions : rule.actions) as Array<Record<string, unknown>>;
      let position = resuming ? (await tx.select({ n: sql<number>`count(*)::int` }).from(automationRunSteps).where(eq(automationRunSteps.runId, run.id)))[0]!.n : 0;
      for (const [index, raw] of pending.entries()) {
        position += 1;
        const parsed = actionSchema.safeParse(raw);
        if (parsed.success && parsed.data.type === 'wait') {
          const rest = pending.slice(index + 1);
          await tx.insert(automationRunSteps).values({ runId: run.id, position, actionType: 'wait', outcome: 'done', detail: rest.length > 0 ? `Espera de ${waitText(parsed.data)}` : 'No hay acciones después de la espera: no hay nada más que hacer' });
          if (rest.length === 0) break;
          await tx.update(automationRuns).set({ resumeActions: rest, nextAttemptAt: new Date(now.getTime() + waitMs(parsed.data)), attempts: 0 }).where(eq(automationRuns.id, run.id));
          return 'waiting';
        }
        const step = parsed.success ? await this.step(tx, parsed.data, { contactId: run.contactId, now, dir }, origin) : { outcome: 'failed' as const, detail: 'La acción guardada no es válida' };
        const type = (raw as { type?: unknown }).type;
        await tx.insert(automationRunSteps).values({ runId: run.id, position, actionType: typeof type === 'string' ? type.slice(0, 40) : 'unknown', outcome: step.outcome, detail: step.detail.slice(0, 500) });
      }
      // Los fallos se cuentan sobre TODOS los pasos de la ejecución (una espera la parte en tramos)
      const failed = (await tx.select({ n: sql<number>`count(*)::int` }).from(automationRunSteps).where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.outcome, 'failed'))))[0]!.n;
      return this.close(tx, run, failed > 0 ? 'failed' : 'done', failed > 0 ? `${failed} ${failed === 1 ? 'acción falló' : 'acciones fallaron'}` : null, now);
    });
  }

  /** Una acción en su SAVEPOINT. Lo previsto (omitida, fallida) se anota; lo inesperado sube y revierte la ejecución completa. */
  private async step(tx: TenantTx, action: ActionDef, ctx: { contactId: string; now: Date; dir: OrgDirectory }, origin: { runId: string; depth: number; chain: readonly string[] }): Promise<{ outcome: 'done' | 'skipped' | 'failed'; detail: string }> {
    await tx.execute(sql`SAVEPOINT automation_step`);
    try {
      const r = await withAutomationOrigin(origin, () => this.actions.execute(tx, action, ctx));
      await tx.execute(sql`RELEASE SAVEPOINT automation_step`);
      return r;
    } catch (e) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT automation_step`);
      if (e instanceof ActionSkipped) return { outcome: 'skipped', detail: e.message };
      if (e instanceof ActionFailed) return { outcome: 'failed', detail: e.message };
      throw e;
    }
  }

  private async close(tx: TenantTx, run: Run, status: 'done' | 'skipped' | 'failed', reason: string | null, now: Date): Promise<Outcome> {
    await tx.update(automationRuns).set({ status, reason, finishedAt: now, resumeActions: null }).where(eq(automationRuns.id, run.id));
    return status;
  }

  /** Error inesperado: la transacción ya se revirtió. Se cuenta el intento y se reprograma, o se da por fallida. */
  private async unexpected(id: string, e: unknown, now: Date): Promise<Outcome> {
    this.log.error({ err: e, automation_run_id: id }, 'fallo inesperado al ejecutar una automatización'); // sin datos del contacto
    return this.db.withTenant(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(and(eq(automationRuns.id, id), eq(automationRuns.status, 'queued'))).limit(1).for('update');
      if (!run) return 'skipped';
      const attempts = run.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await tx.update(automationRuns).set({ status: 'failed', reason: 'Falló de forma inesperada y se agotaron los intentos', attempts, finishedAt: now }).where(eq(automationRuns.id, id));
        return 'failed';
      }
      await tx.update(automationRuns).set({ attempts, nextAttemptAt: new Date(now.getTime() + BACKOFF_MS * 2 ** (attempts - 1)) }).where(eq(automationRuns.id, id));
      return 'retry';
    });
  }
}
