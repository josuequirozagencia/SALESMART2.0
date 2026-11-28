import type { QuickReplyAsset } from '../../lib/types';

/**
 * Borradores del redactor, uno por conversación y solo en memoria de esta sesión del navegador (ADR-60, Fase 5): al volver a la lista y reabrir la conversación, lo escrito sigue
 * ahí. No se guarda en el servidor ni en el almacenamiento del navegador (puede llevar datos del cliente) y se borra al enviar o al salir de la sesión.
 */
export interface Draft {
  text: string;
  mode: 'reply' | 'note';
  /** La respuesta rápida con archivos que está preparada (V25). */
  quick?: { replyId: string; assets: QuickReplyAsset[] } | null;
}

const drafts = new Map<string, Draft>();

export function readDraft(conversationId: string): Draft {
  return drafts.get(conversationId) ?? { text: '', mode: 'reply' };
}

export function writeDraft(conversationId: string, draft: Draft): void {
  if (draft.text === '' && draft.mode === 'reply' && !draft.quick) drafts.delete(conversationId);
  else drafts.set(conversationId, draft);
}

/** Olvida todos los borradores (al cerrar sesión y entre pruebas). */
export function clearDrafts(): void {
  drafts.clear();
}
