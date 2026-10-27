import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TenantTx } from '../../db';

/**
 * Los hechos del negocio a los que una automatización puede reaccionar (M9.3, ADR-54). Cada uno lleva `key`, un identificador estable de ESE hecho (el id del mensaje, de la oportunidad…): sirve para
 * que una regla no se ejecute dos veces por el mismo hecho. Los valores que viajan son cortos y de lectura: lo demás se consulta al ejecutar.
 */
export type DomainEvent =
  | { type: 'contact_created'; contactId: string; key: string; source: string }
  | { type: 'message_received'; contactId: string; key: string; channelId: string; conversationId: string; kind: string }
  | { type: 'opportunity_created'; contactId: string; key: string; opportunityId: string; pipelineId: string; stageId: string }
  | { type: 'stage_changed'; contactId: string; key: string; opportunityId: string; pipelineId: string; fromStageId: string | null; toStageId: string; status: 'open' | 'won' | 'lost' }
  | { type: 'field_changed'; contactId: string; key: string; field: string; oldValue: string | null; newValue: string | null }
  | { type: 'sale_created'; contactId: string; key: string; saleId: string; total: string };

export type DomainEventType = DomainEvent['type'];
export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = ['contact_created', 'message_received', 'opportunity_created', 'stage_changed', 'field_changed', 'sale_created'];

/**
 * De dónde viene un hecho cuando lo causó una automatización (para cortar los ciclos): la ejecución que lo provocó, su profundidad (0 = la causó un hecho de una persona o del cliente) y las
 * reglas que ya participaron en la cadena.
 */
export interface AutomationOrigin {
  readonly runId: string;
  readonly depth: number;
  readonly chain: readonly string[];
}

const origin = new AsyncLocalStorage<AutomationOrigin>();

/** Ejecuta `fn` marcando que todo hecho que ocurra dentro lo causó la ejecución dada. Es lo que permite detectar que una regla se dispara a sí misma. */
export const withAutomationOrigin = <T>(o: AutomationOrigin, fn: () => Promise<T>): Promise<T> => origin.run(o, fn);
export const currentAutomationOrigin = (): AutomationOrigin | null => origin.getStore() ?? null;

export type DomainEventListener = (tx: TenantTx, event: DomainEvent, origin: AutomationOrigin | null) => Promise<void>;

/**
 * Aviso de que ocurrió un hecho del negocio (M9.3). Quien lo causa (contactos, mensajes, oportunidades, ventas, campos) lo emite DENTRO de su transacción; quien necesite reaccionar (las
 * automatizaciones) se registra una vez al arrancar. Así los módulos de negocio no conocen a las automatizaciones y la reacción es atómica con el hecho. Sin oyentes no hace nada.
 */
@Injectable()
export class DomainEventBus {
  private readonly listeners: DomainEventListener[] = [];

  subscribe(listener: DomainEventListener): () => void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Un fallo de un oyente propaga: revierte el hecho completo (la reacción y el hecho viven o mueren juntos). */
  async emit(tx: TenantTx, event: DomainEvent): Promise<void> {
    if (this.listeners.length === 0) return;
    const o = currentAutomationOrigin();
    for (const l of this.listeners) await l(tx, event, o);
  }

  get size(): number {
    return this.listeners.length;
  }
}
