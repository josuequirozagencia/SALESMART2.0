import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { automations, contactPhones, contacts, conversations, Database, opportunities, pipelineStages, tags, type TenantTx } from '../../db';
import { NotFoundError } from '../../errors';
import { AgentRuntimeService } from '../ai';
import { OrgMembersService } from '../organizations';
import { OutreachService } from '../outreach';
import { AutomationEnqueueService } from './automation-enqueue.service';
import { ACTION_LABEL, actionSchema, meetsConditions, renderParam, renderText, waitText, type ActionDef, type ConditionDef, type ContactFacts } from './automation-model';

/** Qué haría una acción con este contacto, ahora: `do` la haría, `skip` la omitiría (ya estaba hecho, no hay a quién…), `fail` no podría (algo que nombra ya no existe). */
export interface DryStep {
  position: number;
  action: string;
  label: string;
  would: 'do' | 'skip' | 'fail';
  detail: string;
  /** Va después de una espera: se estima con lo de AHORA, no con lo que habrá pasado cuando termine de esperar. */
  after_wait: boolean;
}
export interface DryRunView {
  contact: { id: string; name: string };
  /** Cada condición de la regla, en su orden, y si el contacto la cumple. */
  conditions: Array<{ index: number; met: boolean }>;
  /** Si el contacto cumple TODAS las condiciones. Si no, la regla no se ejecutaría y no se listan las acciones. */
  meets: boolean;
  actions: DryStep[];
}

/**
 * Prueba en seco de una automatización (M9.4, ADR-54; F20): dice qué haría la regla con un contacto elegido SIN escribir nada. Solo consulta —nunca envía, asigna ni cambia datos—, con las mismas
 * comprobaciones que el motor hace al ejecutar (condiciones, personas que pueden recibir trabajo, etapas, etiquetas, consentimiento, ventana de 24 h, plantilla enviable). Es una estimación del
 * momento: lo que pase entre la prueba y el hecho real puede cambiar el resultado.
 */
@Injectable()
export class AutomationDryRunService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AutomationEnqueueService) private readonly enqueue: AutomationEnqueueService,
    @Inject(OutreachService) private readonly outreach: OutreachService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(AgentRuntimeService) private readonly agents: AgentRuntimeService,
  ) {}

  async test(automationId: string, contactId: string): Promise<DryRunView> {
    const people = new Set((await this.members.assignable()).map((p) => p.id)); // identidad: se lee ANTES de la transacción de negocio
    return this.db.withTenant(async (tx) => {
      const [rule] = await tx.select().from(automations).where(and(eq(automations.id, automationId), isNull(automations.deletedAt))).limit(1);
      if (!rule) throw new NotFoundError();
      const [c] = await tx.select({ id: contacts.id, name: contacts.name, ownerId: contacts.ownerId }).from(contacts).where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1);
      if (!c) throw new NotFoundError();
      const facts = await this.enqueue.factsOf(tx, contactId);
      const conditions = rule.conditions as ConditionDef[];
      const met = conditions.map((cond, index) => ({ index, met: facts ? meetsConditions([cond], facts) : false }));
      const meets = met.every((m) => m.met);
      const out: DryRunView = { contact: { id: c.id, name: c.name }, conditions: met, meets, actions: [] };
      if (!meets) return out;
      const now = new Date();
      let position = 0;
      let afterWait = false;
      for (const raw of rule.actions) {
        position += 1;
        const parsed = actionSchema.safeParse(raw);
        const type = (raw as { type?: unknown }).type;
        if (!parsed.success) {
          out.actions.push({ position, action: typeof type === 'string' ? type : 'unknown', label: 'Acción no válida', would: 'fail', detail: 'La acción guardada no es válida', after_wait: afterWait });
          continue;
        }
        const r = await this.preview(tx, parsed.data, { contactId, name: c.name, ownerId: c.ownerId, customs: facts?.customs ?? {}, tagIds: facts?.tagIds ?? new Set<string>(), people, now, facts, selfId: rule.id });
        out.actions.push({ position, action: parsed.data.type, label: ACTION_LABEL[parsed.data.type], ...r, after_wait: afterWait });
        if (parsed.data.type === 'wait') afterWait = true;
      }
      return out;
    });
  }

  private async preview(
    tx: TenantTx,
    a: ActionDef,
    k: { contactId: string; name: string; ownerId: string | null; customs: Readonly<Record<string, unknown>>; tagIds: ReadonlySet<string>; people: ReadonlySet<string>; now: Date; facts: ContactFacts | null; selfId: string },
  ): Promise<Pick<DryStep, 'would' | 'detail'>> {
    const doIt = (detail: string): Pick<DryStep, 'would' | 'detail'> => ({ would: 'do', detail });
    const skip = (detail: string): Pick<DryStep, 'would' | 'detail'> => ({ would: 'skip', detail });
    const fail = (detail: string): Pick<DryStep, 'would' | 'detail'> => ({ would: 'fail', detail });
    switch (a.type) {
      case 'wait':
        return doIt(`Esperaría ${waitText(a)} y seguiría con las acciones siguientes`);
      case 'run_rule': {
        const [target] = await tx.select().from(automations).where(and(eq(automations.id, a.automation_id), isNull(automations.deletedAt))).limit(1);
        if (!target) return fail('La automatización que debía ejecutar ya no existe');
        if (target.id === k.selfId) return skip('Una automatización no puede ejecutarse a sí misma');
        if (target.status !== 'active') return skip(`«${target.name}» no está activa`);
        const conds = target.conditions as ConditionDef[];
        if (conds.length > 0 && (!k.facts || !meetsConditions(conds, k.facts))) return skip(`El contacto no cumple las condiciones de «${target.name}»`);
        return doIt(`Ejecutaría «${target.name}» (corre en su propia ejecución)`);
      }
      case 'start_agent': {
        const t = await this.agents.startTarget(tx, k.contactId);
        if (t.ok) return doIt('Activaría al agente de IA: contestaría lo que el cliente escriba desde ahora');
        return skip({ no_conversation: 'No hay una conversación abierta con el contacto', no_agent: 'La conexión de la conversación no tiene un agente de IA activo', already_active: 'El agente de IA ya está activo en la conversación' }[t.reason]);
      }
      case 'assign_user': {
        if (!k.people.has(a.user_id)) return fail('Esa persona ya no puede recibir trabajo en la empresa');
        const others = await tx
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(and(eq(opportunities.contactId, k.contactId), eq(opportunities.status, 'open'), isNull(opportunities.deletedAt), or(isNull(opportunities.ownerId), ne(opportunities.ownerId, a.user_id)), k.ownerId === null ? isNull(opportunities.ownerId) : or(isNull(opportunities.ownerId), eq(opportunities.ownerId, k.ownerId))))
          .limit(1);
        return k.ownerId === a.user_id && others.length === 0 ? skip('El contacto ya es de esa persona') : doIt('Cambiaría el responsable del contacto y de sus oportunidades abiertas');
      }
      case 'assign_queue': {
        const [conv] = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.contactId, k.contactId), eq(conversations.status, 'unassigned'))).orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt)).limit(1);
        return conv ? doIt('Repartiría la conversación sin asignar con las reglas de la cola') : skip('No hay una conversación sin asignar');
      }
      case 'move_stage': {
        const [target] = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.id, a.stage_id), isNull(pipelineStages.deletedAt))).limit(1);
        if (!target || target.isHidden || target.kind !== 'open') return fail('La etapa ya no existe, está oculta o no es una etapa abierta');
        const [opp] = await tx
          .select({ stageId: opportunities.stageId })
          .from(opportunities)
          .where(and(eq(opportunities.contactId, k.contactId), eq(opportunities.pipelineId, target.pipelineId), eq(opportunities.status, 'open'), isNull(opportunities.deletedAt)))
          .orderBy(desc(opportunities.createdAt))
          .limit(1);
        if (!opp) return skip('El contacto no tiene una oportunidad abierta en ese pipeline');
        return opp.stageId === target.id ? skip('La oportunidad ya está en esa etapa') : doIt(`Movería la oportunidad a «${target.name}»`);
      }
      case 'set_field': {
        const cur = k.customs[a.field];
        const same = cur !== undefined && cur !== null && String(cur).trim().toLowerCase() === a.value.trim().toLowerCase();
        return same ? skip('El campo ya tiene ese valor') : doIt(`Cambiaría el campo «${a.field}»`);
      }
      case 'add_tag':
      case 'remove_tag': {
        const [t] = await tx.select().from(tags).where(and(eq(tags.id, a.tag_id), isNull(tags.deletedAt))).limit(1);
        if (!t || t.isSystem) return fail('La etiqueta ya no existe o es del sistema');
        const has = k.tagIds.has(a.tag_id);
        if (a.type === 'add_tag') return has ? skip('El contacto ya tiene la etiqueta') : doIt(`Pondría la etiqueta «${t.name}»`);
        return has ? doIt(`Quitaría la etiqueta «${t.name}»`) : skip('El contacto no tiene la etiqueta');
      }
      case 'create_task': {
        const assignee = a.assignee === 'owner' ? k.ownerId : a.assignee;
        if (!assignee) return skip('El contacto no tiene responsable a quien asignarle la tarea');
        if (!k.people.has(assignee)) return fail('Esa persona ya no puede recibir trabajo en la empresa');
        return doIt(`Crearía la tarea «${renderText(a.title, { name: k.name }).slice(0, 80)}»`);
      }
      case 'send_text': {
        const t = await this.outreach.textTarget(tx, { contactId: k.contactId, now: k.now }, false);
        if (t.ok) return doIt(`Enviaría: «${renderText(a.text, { name: k.name }).slice(0, 120)}»`);
        return skip({ revoked: 'El contacto revocó su consentimiento', no_conversation: 'No hay una conversación abierta con el contacto', window_closed: 'Pasaron más de 24 h desde su último mensaje: solo se puede enviar una plantilla', channel_unavailable: 'La conexión no está activa' }[t.reason]);
      }
      case 'send_template': {
        const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, k.contactId), isNull(contactPhones.deletedAt))).limit(1);
        if (!p) return skip('El contacto no tiene teléfono');
        const params = Object.fromEntries(Object.entries(a.params).map(([key, v]) => [key, renderParam(v, { name: k.name })]));
        const plan = await this.outreach.checkTemplate(tx, { contactId: k.contactId, channelId: a.channel_id, templateId: a.template_id, params });
        if (plan.ok) return doIt(`Enviaría la plantilla «${plan.row.name}»`);
        return skip({ revoked: 'El contacto revocó su consentimiento', channel_unavailable: 'La conexión no está activa', template_unavailable: 'La plantilla ya no está disponible o sus valores no son válidos' }[plan.reason]);
      }
    }
  }
}
