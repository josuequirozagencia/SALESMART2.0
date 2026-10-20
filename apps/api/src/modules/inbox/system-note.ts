import { messages, type TenantTx } from '../../db';

/** Aviso automático en el historial de una conversación: nota interna del sistema (`internal`, sin autor, nunca sale al cliente) con el texto ya redactado. */
export async function addSystemNote(tx: TenantTx, c: { id: string; channelAccountId: string }, text: string, now: Date): Promise<void> {
  await tx.insert(messages).values({ conversationId: c.id, channelAccountId: c.channelAccountId, direction: 'out', senderType: 'system', kind: 'note', body: text.slice(0, 2000), status: 'internal', sentAt: now });
}
