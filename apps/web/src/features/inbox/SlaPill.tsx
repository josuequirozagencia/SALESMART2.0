import type { ConversationSla } from '../../lib/types';
import { Pill } from '../../ui/Pill';
import { slaChip } from './inboxFormat';

/**
 * El cronómetro de respuesta de una conversación (M5.5b): al día, en riesgo, vencido, en pausa por estar fuera de horario o ya respondido. Los minutos se cuentan
 * contra la hora de vencimiento que da el servidor (que ya descuenta horario y feriados). `hideDone` oculta «Respondió en…» en el listado, donde estorba.
 */
export function SlaPill({ sla, now, hideDone = false }: { sla: ConversationSla | null; now: number; hideDone?: boolean }) {
  if (!sla || (hideDone && sla.state === 'done')) return null;
  const chip = slaChip(sla, now);
  return <span title={chip.title}><Pill kind={chip.kind}>{chip.text}</Pill></span>;
}
