import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { agentFollowUpRuns, agentFollowUps, agentFollowUpSteps, automations, Database } from '../../db';
import { ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AgentsService } from '../ai';
import { writeAudit } from '../audit';
import { variablesIn } from '../quick-replies';
import { disallowedVariables, FOLLOW_UP_VARIABLES, SCENARIO } from './follow-up-rules';
import type { FollowUpsView, SetFollowUpsDto } from './follow-ups.dto';

/**
 * La configuración de los seguimientos de un agente (v11 S5, ADR-68): GET y PUT de la secuencia completa del escenario «El contacto dejó de responder». Solo el administrador (`agents.manage`).
 * El servidor valida todo (la pantalla es ayuda): pasos de 1 a 5 en orden, textos con solo las variables permitidas y automatizaciones que existan, estén activas y sean de la empresa.
 * Guardar apagado o con cero pasos es válido; lo que ya estaba programado se cancela solo (el motor lo comprueba antes de cada envío: «el escenario se deshabilitó» o «el paso ya no existe»).
 */
@Injectable()
export class FollowUpsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {}

  async get(agentId: string): Promise<FollowUpsView> {
    await this.agents.runtimeSettings(agentId); // 404 uniforme si no existe o es de otra empresa
    return this.db.withTenant((tx) => this.view(tx, agentId));
  }

  async set(agentId: string, input: SetFollowUpsDto): Promise<FollowUpsView> {
    await this.agents.runtimeSettings(agentId);
    this.validateTexts(input);
    const userId = TenantContext.current().userId ?? null;
    return this.db.withTenant(async (tx) => {
      const ids = [...new Set(input.steps.map((s) => s.start_automation_id).filter((x): x is string => !!x))];
      if (ids.length > 0) {
        const ok = await tx.select({ id: automations.id }).from(automations).where(and(inArray(automations.id, ids), isNull(automations.deletedAt)));
        if (ok.length !== ids.length) throw new ValidationError([{ path: 'steps', code: 'automation_not_found', message: 'Alguna de las automatizaciones elegidas no existe' }]);
      }
      const before = await this.view(tx, agentId);
      const [row] = await tx
        .insert(agentFollowUps)
        .values({ agentId, scenario: SCENARIO, enabled: input.enabled, updatedBy: userId })
        .onConflictDoUpdate({ target: [agentFollowUps.organizationId, agentFollowUps.agentId, agentFollowUps.scenario], set: { enabled: input.enabled, updatedBy: userId, updatedAt: new Date() } })
        .returning({ id: agentFollowUps.id });
      await tx.delete(agentFollowUpSteps).where(eq(agentFollowUpSteps.followUpId, row!.id));
      if (input.steps.length > 0) {
        await tx.insert(agentFollowUpSteps).values(
          input.steps.map((s, i) => ({ followUpId: row!.id, position: i + 1, delayMinutes: s.delay_minutes, mode: s.mode, fixedText: s.mode === 'fixed_text' ? (s.fixed_text ?? null) : null, startAutomationId: s.start_automation_id ?? null })),
        );
      }
      const after = await this.view(tx, agentId);
      const shape = (v: FollowUpsView) => ({ enabled: v.enabled, steps: v.steps.map((s) => ({ delay_minutes: s.delay_minutes, mode: s.mode, has_text: s.fixed_text !== null, automation: s.start_automation_id })) });
      if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) await writeAudit(tx, { entityType: 'agent', entityId: agentId, field: 'follow_ups', oldValue: shape(before), newValue: shape(after), source: 'manual' }); // el texto no va a la auditoría
      return after;
    });
  }

  /** Los textos fijos solo pueden llevar las variables permitidas (se rechaza lo demás antes de guardar). */
  private validateTexts(input: SetFollowUpsDto): void {
    input.steps.forEach((s, i) => {
      if (s.mode !== 'fixed_text' || !s.fixed_text) return;
      const bad = disallowedVariables(variablesIn(s.fixed_text));
      if (bad.length > 0) throw new ValidationError([{ path: `steps.${i}.fixed_text`, code: 'variable_not_allowed', message: `Variables no permitidas: ${bad.map((b) => `{{${b}}}`).join(', ')}. Usa solo ${FOLLOW_UP_VARIABLES.map((v) => `{{${v}}}`).join(', ')}` }]);
    });
  }

  private async view(tx: Parameters<Parameters<Database['withTenant']>[0]>[0], agentId: string): Promise<FollowUpsView> {
    const [fu] = await tx.select().from(agentFollowUps).where(and(eq(agentFollowUps.agentId, agentId), eq(agentFollowUps.scenario, SCENARIO))).limit(1);
    const steps = fu ? await tx.select().from(agentFollowUpSteps).where(eq(agentFollowUpSteps.followUpId, fu.id)).orderBy(asc(agentFollowUpSteps.position)) : [];
    const autos = await tx.select({ id: automations.id, name: automations.name }).from(automations).where(and(eq(automations.status, 'active'), isNull(automations.deletedAt))).orderBy(asc(automations.name)).limit(100);
    const recent = await tx
      .select({ status: agentFollowUpRuns.status, reason: agentFollowUpRuns.reason, n: sql<number>`count(*)::int` })
      .from(agentFollowUpRuns)
      .where(and(eq(agentFollowUpRuns.agentId, agentId), gt(agentFollowUpRuns.createdAt, new Date(Date.now() - 7 * 86_400_000))))
      .groupBy(agentFollowUpRuns.status, agentFollowUpRuns.reason)
      .orderBy(desc(sql`count(*)`));
    const summary = { sent: 0, skipped: 0, cancelled: 0, pending: 0, reasons: {} as Record<string, number> };
    for (const r of recent) {
      summary[r.status as 'sent' | 'skipped' | 'cancelled' | 'pending'] += r.n;
      if (r.reason) summary.reasons[r.reason] = (summary.reasons[r.reason] ?? 0) + r.n;
    }
    return {
      scenario: SCENARIO,
      enabled: fu?.enabled ?? false,
      steps: steps.map((s) => ({ position: s.position, delay_minutes: s.delayMinutes, mode: s.mode as 'ai' | 'fixed_text' | 'none', fixed_text: s.fixedText, start_automation_id: s.startAutomationId })),
      variables: [...FOLLOW_UP_VARIABLES],
      automations: autos,
      summary,
      updated_at: fu?.updatedAt.toISOString() ?? null,
    };
  }
}
