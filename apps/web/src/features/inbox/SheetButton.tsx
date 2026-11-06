import type { ReactNode } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Icon, type IconName } from '../../ui/Icon';
import { useAgentControl, useAgentStatus } from './useInbox';

/** Una fila de una hoja inferior (ADR-60): objetivo táctil de 48 px, icono y texto; `danger` para lo destructivo. */
export function SheetButton({ icon, onClick, danger = false, primary = false, disabled = false, hint, children }: { icon?: IconName; onClick: () => void; danger?: boolean; primary?: boolean; disabled?: boolean; hint?: string; children: ReactNode }) {
  const tone = primary ? 'bg-accent text-accent-ink' : danger ? 'text-crit hover:bg-crit-soft' : 'text-fg hover:bg-surface2';
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] font-semibold disabled:opacity-50 ${tone}`}>
      {icon ? <Icon name={icon} /> : null}
      <span className="min-w-0 flex-1">
        {children}
        {hint ? <span className="block text-[12px] font-normal opacity-80">{hint}</span> : null}
      </span>
    </button>
  );
}

/** «Pausar / Reanudar al agente» de la hoja de acciones del chat móvil. Solo aparece si el agente intervino en esta conversación y la persona puede controlarlo. */
export function AgentSheetItem({ c, onDone, onError }: { c: Conversation; onDone: () => void; onError: (m: string) => void }) {
  const q = useAgentStatus(c.id);
  const control = useAgentControl(c.id);
  const s = q.data;
  if (!s || !s.agent || s.state === 'idle' || c.status === 'closed' || !s.can_control) return null;
  const active = s.state === 'active';
  return (
    <SheetButton
      icon="bot"
      disabled={control.isPending}
      onClick={() => {
        const a = active ? 'pause' : 'resume';
        control.mutate(a, { onError: (e) => onError(friendlyError(e, a === 'pause' ? 'No pudimos pausar al agente.' : 'No pudimos reanudar al agente.')) });
        onDone();
      }}
    >
      {active ? `Pausar al agente ${s.agent.name}` : `Reanudar al agente ${s.agent.name}`}
    </SheetButton>
  );
}
