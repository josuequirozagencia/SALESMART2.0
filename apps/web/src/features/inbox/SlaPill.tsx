import type { ConversationSla } from '../../lib/types';
import { Icon } from '../../ui/Icon';
import type { PillKind } from '../../ui/Pill';
import { slaChip } from './inboxFormat';

// El estado se distingue también por la forma, no solo por el color (v13 S1.4): vencido = borde continuo y negrita; en riesgo = borde discontinuo; al día = sin borde.
const CLS: Record<PillKind, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'border border-dashed border-warn bg-warn-soft text-warn',
  crit: 'border border-crit bg-crit-soft font-bold text-crit',
  info: 'bg-info-soft text-info',
  muted: 'bg-surface2 text-muted',
  accent: 'bg-accent-soft text-accent',
};

/**
 * El cronómetro de respuesta de una conversación (M5.5b, v13 S1.4): solo un icono y el tiempo («8 h 10 min»), sin palabras. El estado completo («SLA vencido hace 8 h 10 min») va en el nombre
 * accesible y en el título, y se cuenta contra la hora de vencimiento que da el servidor (que ya descuenta horario y feriados). `hideDone` oculta «Respondió en…» en el listado.
 */
export function SlaPill({ sla, now, hideDone = false }: { sla: ConversationSla | null; now: number; hideDone?: boolean }) {
  if (!sla || (hideDone && sla.state === 'done')) return null;
  const chip = slaChip(sla, now);
  return (
    <span role="img" aria-label={chip.label} title={`${chip.label}. ${chip.title}`} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${CLS[chip.kind]}`}>
      <Icon name={chip.icon} size={13} />
      {chip.time ? <span aria-hidden="true">{chip.time}</span> : null}
    </span>
  );
}
