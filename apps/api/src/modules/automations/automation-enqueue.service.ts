import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { automationRuns, automations, contacts, contactTags, tags, type TenantTx } from '../../db';
import { CustomValuesService } from '../custom-fields';
import { DomainEventBus, type AutomationOrigin, type DomainEvent } from '../events';
import { contextOf, matchesTrigger, meetsConditions, MAX_DEPTH, MAX_RUNS_PER_CONTACT_HOUR, type ConditionDef, type ContactFacts } from './automation-model';

/**
 * Convierte los hechos del negocio en ejecuciones en cola (M9.3, ADR-54; F20). Se registra una vez en el bus de hechos y corre DENTRO de la transacción de quien causó el hecho: la ejecución
 * nace o no nace junto con él, y las condiciones se evalúan con el estado exacto de ese instante. Aquí NO se hace nada de negocio (eso lo hace el motor, después): solo se decide qué reglas
 * reaccionan, con tres defensas contra cascadas:
 *  - **profundidad**: lo que una regla provoca puede disparar otra regla, hasta {@link MAX_DEPTH} niveles;
 *  - **ciclo**: una regla que ya participó en la cadena no vuelve a dispararse por lo que ella misma provocó (queda registrado como omitido);
 *  - **tope por hora**: una regla ejecuta a lo sumo {@link MAX_RUNS_PER_CONTACT_HOUR} veces por contacto por hora.
 * Una regla ejecuta una sola vez por hecho (índice único por regla y hecho).
 */
@Injectable()
export class AutomationEnqueueService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(DomainEventBus) private readonly bus: DomainEventBus,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((tx, event, origin) => this.onEvent(tx, event, origin));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async onEvent(tx: TenantTx, event: DomainEvent, origin: AutomationOrigin | null): Promise<void> {
    const depth = origin ? origin.depth + 1 : 0;
    const rules = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.triggerType, event.type), eq(automations.status, 'active'), isNull(automations.deletedAt)));
    const matching = rules.filter((r) => matchesTrigger(r.triggerType as DomainEvent['type'], r.triggerFilter, event));
    if (matching.length === 0) return;

    let facts: ContactFacts | null = null;
    for (const r of matching) {
      const base = { automationId: r.id, contactId: event.contactId, eventType: event.type, eventKey: event.key, context: contextOf(event), depth, chain: [...(origin?.chain ?? []), r.id], causeRunId: origin?.runId ?? null };
      if (depth > MAX_DEPTH) {
        await this.record(tx, { ...base, status: 'skipped', reason: `Se superó el máximo de ${MAX_DEPTH} reglas encadenadas` });
        continue;
      }
      if (origin?.chain.includes(r.id)) {
        await this.record(tx, { ...base, status: 'skipped', reason: 'Ciclo: esta regla ya participó en la cadena que la volvió a disparar' });
        continue;
      }
      const conditions = r.conditions as ConditionDef[];
      if (conditions.length > 0) {
        facts ??= await this.factsOf(tx, event.contactId);
        if (!facts || !meetsConditions(conditions, facts)) continue; // no aplica: no deja rastro
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(automationRuns)
        .where(and(eq(automationRuns.automationId, r.id), eq(automationRuns.contactId, event.contactId), inArray(automationRuns.status, ['queued', 'done', 'failed']), sql`${automationRuns.createdAt} > now() - interval '1 hour'`));
      if (n >= MAX_RUNS_PER_CONTACT_HOUR) {
        await this.record(tx, { ...base, status: 'skipped', reason: `Tope de ${MAX_RUNS_PER_CONTACT_HOUR} ejecuciones por hora para este contacto` });
        continue;
      }
      await this.record(tx, { ...base, status: 'queued', reason: null });
    }
  }

  private async record(tx: TenantTx, v: { automationId: string; contactId: string; eventType: string; eventKey: string; context: Record<string, unknown>; depth: number; chain: string[]; causeRunId: string | null; status: 'queued' | 'skipped'; reason: string | null }): Promise<void> {
    await tx
      .insert(automationRuns)
      .values({ ...v, finishedAt: v.status === 'skipped' ? new Date() : null })
      .onConflictDoNothing();
  }

  /** Lo que se sabe del contacto para evaluar condiciones; null si ya no existe. */
  async factsOf(tx: TenantTx, contactId: string): Promise<ContactFacts | null> {
    const [c] = await tx.select({ source: contacts.source, ownerId: contacts.ownerId, consent: contacts.consent }).from(contacts).where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c) return null;
    const customs = (await this.custom.valuesFor(tx, 'contact', [contactId])).get(contactId) ?? {};
    const tagRows = await tx
      .select({ id: contactTags.tagId })
      .from(contactTags)
      .innerJoin(tags, and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)))
      .where(and(eq(contactTags.contactId, contactId), isNull(tags.deletedAt)));
    return { customs, tagIds: new Set(tagRows.map((t) => t.id)), source: c.source, ownerId: c.ownerId, consent: c.consent };
  }
}
