import { useState, type ReactNode } from 'react';
import { friendlyError } from '../../lib/errors';
import type { AgentStatus, Conversation } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { useAgentControl, useAgentStatus } from './useInbox';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** Por qué el agente ya no contesta, dicho para quien atiende. */
const REASONS: Record<string, string> = {
  manual: 'Pausaste al agente en esta conversación.',
  human_message: 'El agente se pausó porque una persona respondió.',
  human_took: 'El agente se pausó porque una persona tomó la conversación.',
  no_credits: 'El agente se detuvo: la empresa se quedó sin créditos de IA.',
  requested: 'El cliente pidió hablar con una persona.',
  turn_limit: 'El agente llegó al máximo de respuestas seguidas.',
  unsupported_media: 'El cliente envió algo que no es texto y el agente solo lee texto.',
  ai_error: 'El servicio de IA no estuvo disponible.',
  no_support: 'El agente no encontró en sus documentos lo que el cliente preguntó.',
};

const NO_CREDITS_HINT = 'No puedes reanudarlo todavía: la empresa no tiene créditos de IA disponibles.';

/** Motivos que se dicen con una frase completa y propia (textos aprobados por el responsable el 2026-11-06). */
const WHOLE: Record<string, string> = {
  human_message: 'Pausado: una persona intervino. Puedes reanudarlo.',
  human_took: 'Pausado: una persona intervino. Puedes reanudarlo.',
  empty_reply: 'El agente no pudo responder. Revisa esta conversación.',
};

/** Lo que se dice del agente según su estado (el mismo texto en el aviso de arriba y en el panel del contacto). */
function line(s: AgentStatus): ReactNode {
  const name = s.agent?.name ?? '';
  const active = s.state === 'active';
  const whole = !active && s.reason ? WHOLE[s.reason] : undefined;
  return active ? (s.outcome === 'out_of_hours' ? <>El agente espera el horario de atención.</> : <>Agente de IA atendiendo · <b>{name}</b></>) : whole ? <>{whole}</> : <>El agente <b>{name}</b> {s.state === 'handed_off' ? 'pasó la conversación a una persona.' : 'está en pausa.'} {s.reason ? REASONS[s.reason] ?? '' : ''}</>;
}

/**
 * Interruptor del agente de IA en la cabecera del chat (v11, punto 10; reemplaza al botón «Reanudar agente»). Encendido = el agente atiende; apagado = pausado por una persona (misma acción
 * que el servidor ya registra con origen `manual`). Solo una persona puede encenderlo. Sin agente en la conexión queda apagado y deshabilitado con su motivo; sin créditos no se puede
 * encender. En una conversación finalizada no se muestra. `compact` deja solo «IA» (cabecera móvil, donde el espacio es poco).
 */
export function AgentSwitch({ c, compact = false, onError }: { c: Conversation; compact?: boolean; onError: (message: string | undefined) => void }) {
  const q = useAgentStatus(c.id);
  const control = useAgentControl(c.id);
  const s = q.data;
  if (!s || c.status === 'closed') return null;
  const hasAgent = !!s.agent;
  const on = hasAgent && (s.state === 'active' || s.state === 'idle');
  const blocked = !on && s.resume_blocked === 'no_credits';
  const reason = !hasAgent ? 'Sin agente en esta conversación' : !s.can_control ? 'Solo quien atiende la conversación puede controlar al agente' : blocked ? NO_CREDITS_HINT : on ? 'Pausar al agente de IA en esta conversación' : 'Reanudar al agente de IA en esta conversación';
  const disabled = !hasAgent || !s.can_control || blocked || control.isPending;
  const toggle = (): void => {
    onError(undefined);
    control.mutate(on ? 'pause' : 'resume', { onError: (e) => onError(friendlyError(e, on ? 'No pudimos pausar al agente.' : 'No pudimos reanudar al agente.')) });
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Agente de IA"
      title={reason}
      disabled={disabled}
      onClick={toggle}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-2 text-[12.5px] font-semibold text-fg hover:bg-surface2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon name="bot" size={16} aria-hidden="true" />
      <span className={compact ? '' : 'hidden min-[1500px]:inline'}>{compact ? 'IA' : 'Agente de IA'}</span>
      <span aria-hidden="true" className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-150 ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      {!hasAgent ? <span className="sr-only">Sin agente en esta conversación</span> : null}
    </button>
  );
}

/**
 * El estado del agente DENTRO del panel del contacto del chat móvil (v10; ahí ya no hay aviso amarillo sobre el chat y el botón «Reanudar agente» vive también en la cabecera): el mismo texto, con
 * «Tomar control» si atiende o «Reanudar agente» si está detenido. No se muestra si la conexión no tiene agente o este no ha intervenido.
 */
export function AgentPanelBlock({ c }: { c: Conversation }) {
  const q = useAgentStatus(c.id);
  const control = useAgentControl(c.id);
  const [error, setError] = useState<string>();
  const s = q.data;
  if (!s || !s.agent || s.state === 'idle' || c.status === 'closed') return null;
  const active = s.state === 'active';
  const act = (a: 'pause' | 'resume'): void => {
    setError(undefined);
    control.mutate(a, { onError: (e) => setError(friendlyError(e, a === 'pause' ? 'No pudimos pausar al agente.' : 'No pudimos reanudar al agente.')) });
  };
  return (
    <div role="status" aria-label="Agente de IA" className={`mx-4 mt-3 grid gap-2 rounded-xl border px-3 py-2.5 text-[13px] ${active ? 'border-line bg-accent-soft text-fg' : 'border-warn bg-warn-soft text-warn'}`}>
      <p className="flex items-start gap-2"><Icon name="bot" size={18} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{line(s)}</span></p>
      {s.can_control ? (
        active ? <Button className="w-full justify-center" loading={control.isPending} onClick={() => act('pause')}>Tomar control</Button> : <Button className="w-full justify-center" loading={control.isPending} disabled={!!s.resume_blocked} title={s.resume_blocked ? NO_CREDITS_HINT : undefined} onClick={() => act('resume')}>Reanudar agente</Button>
      ) : null}
      {s.resume_blocked ? <p className="text-[12px]">{NO_CREDITS_HINT}</p> : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

/**
 * Qué hace el agente de IA en esta conversación (M8.5, ADR-53; F17): si atiende, quien responde puede tomar el control; si se pausó o pasó la conversación a una persona, ve por qué y puede reanudarlo.
 * No se muestra si la conexión no tiene agente o el agente no ha intervenido.
 */
export function AgentBanner({ c }: { c: Conversation }) {
  const q = useAgentStatus(c.id);
  const control = useAgentControl(c.id);
  const [error, setError] = useState<string>();
  const s = q.data;
  if (!s || !s.agent || s.state === 'idle' || c.status === 'closed') return null;
  const act = (a: 'pause' | 'resume'): void => {
    setError(undefined);
    control.mutate(a, { onError: (e) => setError(friendlyError(e, a === 'pause' ? 'No pudimos pausar al agente.' : 'No pudimos reanudar al agente.')) });
  };
  const active = s.state === 'active';
  return (
    <div role="status" aria-label="Agente de IA" className={`flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[13px] ${active ? 'bg-accent-soft text-fg' : 'bg-warn-soft text-warn'}`}>
      <span aria-hidden="true">🤖</span>
      <span className="min-w-0 flex-1">
        {line(s)}
      </span>
      {s.can_control ? (
        active ? <Button className={SMALL} loading={control.isPending} onClick={() => act('pause')}>Tomar control</Button> : <Button className={SMALL} loading={control.isPending} disabled={!!s.resume_blocked} title={s.resume_blocked ? NO_CREDITS_HINT : undefined} onClick={() => act('resume')}>Reanudar agente</Button>
      ) : null}
      {s.resume_blocked ? <div className="basis-full text-[12px]">{NO_CREDITS_HINT}</div> : null}
      {error ? <div className="basis-full"><Alert>{error}</Alert></div> : null}
    </div>
  );
}
