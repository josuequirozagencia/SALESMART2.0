import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
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
  const name = s.agent.name;
  const act = (a: 'pause' | 'resume'): void => {
    setError(undefined);
    control.mutate(a, { onError: (e) => setError(friendlyError(e, a === 'pause' ? 'No pudimos pausar al agente.' : 'No pudimos reanudar al agente.')) });
  };
  const active = s.state === 'active';
  return (
    <div role="status" aria-label="Agente de IA" className={`flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[13px] ${active ? 'bg-accent-soft text-fg' : 'bg-warn-soft text-warn'}`}>
      <span aria-hidden="true">🤖</span>
      <span className="min-w-0 flex-1">
        {active ? <>El agente <b>{name}</b> está atendiendo esta conversación.</> : <>El agente <b>{name}</b> {s.state === 'handed_off' ? 'pasó la conversación a una persona.' : 'está en pausa.'} {s.reason ? REASONS[s.reason] ?? '' : ''}</>}
      </span>
      {s.can_control ? (
        active ? <Button className={SMALL} loading={control.isPending} onClick={() => act('pause')}>Tomar control</Button> : <Button className={SMALL} loading={control.isPending} onClick={() => act('resume')}>Reanudar agente</Button>
      ) : null}
      {error ? <div className="basis-full"><Alert>{error}</Alert></div> : null}
    </div>
  );
}
