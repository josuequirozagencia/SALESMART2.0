import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { STATE_KIND, STATE_LABEL } from './labels';
import { fetchEligibleIds, useAudienceList, type AudienceState, type CampaignAudience } from './useCampaigns';

/**
 * La lista de destinatarios del prototipo: cada contacto de la base elegida con una casilla para desmarcarlo a mano, y «Todos» / «Ninguno». Quien tiene la baja («No contactar»), no tiene
 * teléfono o no dio su consentimiento aparece con su motivo y NO se puede marcar. Lo desmarcado a mano se guarda en la campaña (`excluded_contact_ids`); la lista se pide sin esas exclusiones
 * (para no volver a pedirla con cada casilla) y se aplican aquí en pantalla.
 */
export function RecipientsPicker({ audience, includeUnknown, excluded, onExcluded }: { audience: Pick<CampaignAudience, 'source' | 'list_id'>; includeUnknown: boolean; excluded: ReadonlySet<string>; onExcluded: (next: Set<string>) => void }) {
  const q = useAudienceList(audience, includeUnknown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);
  const total = q.data?.pages[0]?.total ?? 0;
  const stateOf = (id: string, base: AudienceState): AudienceState => (base === 'eligible' && excluded.has(id) ? 'excluded' : base);

  const none = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      onExcluded(new Set([...excluded, ...(await fetchEligibleIds(audience, includeUnknown))]));
    } catch (e) {
      setError(friendlyError(e, 'No pudimos desmarcar a todos.'));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string): void => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onExcluded(next);
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">{q.isPending ? 'Calculando…' : `${total} ${total === 1 ? 'contacto' : 'contactos'} en esta base`}</span>
        <span className="flex-1" />
        <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => onExcluded(new Set())} disabled={excluded.size === 0}>Todos</Button>
        <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={busy} onClick={() => void none()} disabled={total === 0}>Ninguno</Button>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los destinatarios.')}</Alert> : null}
      <div role="group" aria-label="Destinatarios" className="max-h-[220px] overflow-auto rounded-[10px] border border-line">
        {q.isPending ? <div className="grid place-items-center p-5 text-muted"><Spinner label="Cargando destinatarios" /></div> : null}
        {q.isSuccess && items.length === 0 ? <p className="p-4 text-[13px] text-muted">No hay contactos en esta base.</p> : null}
        {items.map((i) => {
          const state = stateOf(i.id, i.state);
          const locked = i.state !== 'eligible';
          const checked = state === 'eligible';
          return (
            <label key={i.id} className={`flex min-h-11 items-center gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0 ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface2'}`}>
              <input type="checkbox" className="size-[18px] shrink-0 accent-[var(--accent)]" checked={checked} disabled={locked} onChange={() => toggle(i.id)} aria-label={`${i.name}: ${STATE_LABEL[state]}`} />
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[13.5px]">{i.name}</b>
                <span className="block truncate text-[12px] text-muted">{i.phone ?? 'Sin teléfono'}</span>
              </span>
              {state === 'eligible' ? null : <Pill kind={STATE_KIND[state]}>{STATE_LABEL[state]}</Pill>}
            </label>
          );
        })}
        {q.hasNextPage ? (
          <div className="grid place-items-center p-2">
            <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
