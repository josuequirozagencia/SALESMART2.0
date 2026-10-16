import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { durationLabel, shortDateTime } from '../../lib/format';
import type { AccessEndReason, AccessSession } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { NO_ACCESS_FILTERS, useAccessSessions, type AccessFilters } from './useAccessSessions';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';

const END_LABEL: Record<AccessEndReason, string> = {
  switch: 'Pasó a otra cuenta',
  return: 'Volvió a su cuenta',
  access_removed: 'Se le quitó el acceso',
  session_ended: 'Cerró o venció su sesión',
};

function Row({ a }: { a: AccessSession }) {
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_150px_minmax(0,1fr)] min-[900px]:items-center">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{a.actor.name ?? a.actor.email}</b>
        <span className="block truncate text-[12px] text-muted">{a.actor.name ? `${a.actor.email} · ` : ''}{a.actor_role === 'super_admin' ? 'Súper Admin' : 'Agencia'}</span>
      </div>
      <div className="min-w-0">
        <span className="block truncate text-[13.5px]">Entró a <b>{a.organization.name}</b></span>
        <span className="block text-[12px] text-muted">{a.organization.kind === 'agency' ? 'Agencia' : 'Empresa'}</span>
      </div>
      <div className="text-[12.5px]">
        <span className="block">{shortDateTime(a.started_at)}</span>
        <span className="block text-muted">{a.open ? 'Dentro ahora' : durationLabel(a.duration_seconds)}</span>
      </div>
      <div className="text-[12.5px]">
        {a.open ? <Pill kind="ok">Dentro ahora</Pill> : <span className="text-muted">{a.end_reason ? END_LABEL[a.end_reason] : 'Terminó'}{a.ended_at ? ` · ${shortDateTime(a.ended_at)}` : ''}</span>}
      </div>
    </li>
  );
}

/**
 * «Accesos» (ADR-22): quién entró a qué cuenta de cliente o de agencia, cuándo y cuánto tiempo. SOLO el Súper Admin lo ve (el servidor lo exige).
 * Es el historial de entradas y salidas; lo que se hizo dentro de la cuenta queda marcado «actuando como» en la auditoría del cliente.
 */
export function AccessPage() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<AccessFilters>(NO_ACCESS_FILTERS);
  const q = useAccessSessions(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const filtered = Boolean(filters.q || filters.actorRole || filters.open);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Entradas del Súper Admin y de las agencias a otras cuentas. Solo tú puedes ver este historial.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Persona o cuenta" className={`${selectCls} font-normal`} />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Quién entró
          <select value={filters.actorRole} onChange={(e) => setFilters((f) => ({ ...f, actorRole: e.target.value as AccessFilters['actorRole'] }))} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="super_admin">Súper Admin</option><option value="agency">Agencias</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" checked={filters.open} onChange={(e) => setFilters((f) => ({ ...f, open: e.target.checked }))} />
          <span>Solo los que siguen dentro</span>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters(NO_ACCESS_FILTERS); }}>Limpiar filtros</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando accesos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los accesos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">{filtered ? 'Ningún acceso coincide con los filtros.' : 'Todavía nadie ha entrado a otra cuenta.'}</p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-3" aria-label="Accesos">{items.map((a) => <Row key={a.id} a={a} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
    </div>
  );
}
