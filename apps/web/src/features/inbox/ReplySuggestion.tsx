import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { useAgentStatus } from './useInbox';

export interface SuggestionResult {
  text: string;
  agent: { id: string; name: string };
  credits_used: number;
  remaining_today: number;
}

/**
 * «Sugerir respuesta» (v11 S4, ADR-61): pide al agente de la conexión un BORRADOR para quien atiende. No envía nada, no cambia el estado del agente y el texto no se guarda en el servidor: vive aquí
 * mientras la tarjeta esté a la vista. Solo se ofrece si el agente de la conexión tiene activadas las sugerencias, la persona puede responder y la conversación admite texto libre.
 */
export function useReplySuggestion(c: Conversation) {
  const status = useAgentStatus(c.id);
  const mutation = useMutation({ mutationFn: () => api<SuggestionResult>(`/conversations/${c.id}/ai/suggest`, { method: 'POST' }) });
  const available = status.data?.agent?.suggestions_enabled === true && c.can.reply && c.status !== 'closed' && c.window.open;
  return {
    available,
    pending: mutation.isPending,
    draft: mutation.data ?? null,
    error: mutation.isError ? friendlyError(mutation.error, 'No pudimos preparar la sugerencia. Inténtalo de nuevo.') : null,
    run: (): void => mutation.mutate(),
    clear: (): void => mutation.reset(),
  };
}

/** El botón del redactor. Deshabilitado mientras se prepara la sugerencia. */
export function SuggestButton({ s, className = '' }: { s: ReturnType<typeof useReplySuggestion>; className?: string }) {
  if (!s.available) return null;
  return (
    <Button aria-label="Sugerir respuesta" title="La IA prepara un borrador que tú revisas y envías" loading={s.pending} onClick={s.run} className={className}>
      <span className="inline-flex items-center gap-1.5"><Icon name="bot" size={16} aria-hidden="true" />Sugerir</span>
    </Button>
  );
}

/**
 * La sugerencia a la vista, sobre el redactor: el borrador, con «Usar» (lo pone en el redactor sin enviarlo; si ya hay texto, pregunta si reemplazarlo o agregarlo), «Regenerar» y «Descartar». Rotulada
 * «Sugerencia de IA, revísala»: nunca se envía sola. Los errores (sin créditos, límite del día, nada que contestar…) se dicen con su motivo.
 */
export function SuggestionCard({ s, hasText, onUse }: { s: ReturnType<typeof useReplySuggestion>; hasText: boolean; onUse: (text: string, mode: 'replace' | 'append') => void }) {
  if (s.pending && !s.draft) {
    return (
      <div role="status" aria-label="Preparando la sugerencia" className="flex items-center gap-2 rounded-xl border border-line bg-surface2 px-3 py-2 text-[12.5px] text-muted">
        <Spinner label="Preparando la sugerencia" />
        <span>La IA está preparando un borrador…</span>
      </div>
    );
  }
  if (s.error) {
    return (
      <div className="grid gap-1">
        <Alert>{s.error}</Alert>
        <div><Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={s.clear}>Cerrar</Button></div>
      </div>
    );
  }
  const d = s.draft;
  if (!d) return null;
  const use = (mode: 'replace' | 'append'): void => { onUse(d.text, mode); s.clear(); };
  return (
    <section aria-label="Sugerencia de IA" className="grid gap-2 rounded-xl border border-accent bg-accent-soft px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-accent"><Icon name="bot" size={14} aria-hidden="true" />Sugerencia de IA · revísala antes de enviar</p>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] text-fg">{d.text}</p>
      <div className="flex flex-wrap items-center gap-2">
        {hasText ? (
          <>
            <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => use('replace')}>Reemplazar lo que escribí</Button>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => use('append')}>Agregar al final</Button>
          </>
        ) : (
          <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => use('replace')}>Usar</Button>
        )}
        <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={s.pending} onClick={s.run}>Regenerar</Button>
        <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={s.clear}>Descartar</Button>
        <span className="ml-auto text-[11.5px] text-muted">{d.credits_used} {d.credits_used === 1 ? 'crédito' : 'créditos'} · quedan {d.remaining_today} hoy</span>
      </div>
    </section>
  );
}
