import { Injectable } from '@nestjs/common';
import type { TenantTx } from '../../db';

/** De dónde viene un cambio de etiqueta: una persona o el sistema de este lado, o un canal externo que ya lo tiene (GoHighLevel): ese no debe devolverse a su origen (anti-eco, ADR-52). */
export type TagChangeOrigin = 'local' | 'ghl';

export interface TagChange {
  contactId: string;
  /** Nombre de la etiqueta tal como está en la empresa. */
  tagName: string;
  tagKind: 'system' | 'custom';
  op: 'add' | 'remove';
  origin: TagChangeOrigin;
}

export type TagChangeListener = (tx: TenantTx, change: TagChange) => Promise<void>;

/** Se borró una etiqueta personalizada de la empresa (de todos los contactos a la vez). */
export interface TagDeleted {
  /** Nombre que tenía la etiqueta. */
  tagName: string;
  origin: TagChangeOrigin;
}
export type TagDeletedListener = (tx: TenantTx, event: TagDeleted) => Promise<void>;

/**
 * Aviso de que se puso o se quitó una etiqueta de un contacto (M7.3, ADR-52). Quien cambia las etiquetas (`ContactTaggingService`, `SystemTagsService`) lo emite DENTRO de su transacción;
 * quien necesite reaccionar (la salida hacia GoHighLevel) se registra una vez al arrancar. Así el módulo de etiquetas no conoce a ningún canal externo y la reacción es atómica con el cambio.
 * Sin oyentes no hace nada.
 */
@Injectable()
export class TagChangeBus {
  private readonly listeners: TagChangeListener[] = [];
  private readonly deletedListeners: TagDeletedListener[] = [];

  /** Registra un oyente (idempotente: el mismo no se agrega dos veces). Devuelve la función que lo retira. */
  subscribe(listener: TagChangeListener): () => void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Un fallo de un oyente propaga: revierte el cambio de etiqueta completo (la salida y el cambio viven o mueren juntos). */
  async emit(tx: TenantTx, change: TagChange): Promise<void> {
    for (const l of this.listeners) await l(tx, change);
  }

  /** Como `subscribe`, para el borrado de una etiqueta completa. */
  subscribeDeleted(listener: TagDeletedListener): () => void {
    if (!this.deletedListeners.includes(listener)) this.deletedListeners.push(listener);
    return () => {
      const i = this.deletedListeners.indexOf(listener);
      if (i >= 0) this.deletedListeners.splice(i, 1);
    };
  }

  async emitDeleted(tx: TenantTx, event: TagDeleted): Promise<void> {
    for (const l of this.deletedListeners) await l(tx, event);
  }

  get size(): number {
    return this.listeners.length;
  }
}
