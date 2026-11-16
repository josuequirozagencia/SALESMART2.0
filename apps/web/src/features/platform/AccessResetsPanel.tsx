import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { AccessResetItem } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { NO_RESET_FILTERS, useAccessResets, type ResetFilters } from './useAccessResets';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const ROLE_LABEL: Record<AccessResetItem['actor_role'], string> = { client_admin: 'Administrador del cliente', agency: 'Agencia', super_admin: 'Plataforma' };

function Row({ r }: { r: AccessResetItem }) {
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_150px_minmax(0,1.3fr)] min-[900px]:items-start">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{r.actor.name ?? r.actor.email}</b>
        <span className="block truncate text-[12px] text-muted">{ROLE_LABEL[r.actor_role]}{r.actor_org ? ` · ${r.actor_org.name}` : ''}</span>
      </div>
      <div className="min-w-0">
        <span className="block truncate text-[13.5px]">Restableció a <b>{r.target.name ?? r.target.email_hint}</b></span>
        <span className="block truncate text-[12px] text-muted">{r.target.email_hint} · {r.organization ? r.organization.name : 'Varias empresas / plataforma'}</span>
      </div>
      <div className="text-[12.5px]">
        <span className="block">{shortDateTime(r.created_at)}</span>
        <span className="block text-muted">{r.sessions_revoked === 1 ? '1 sesión cerrada' : `${r.sessions_revoked} sesiones cerradas`}</span>
      </div>
      <div className="grid gap-1 text-[12.5px]">
        <span>{r.reason ? `Motivo: ${r.reason}` : <span className="text-muted">Sin motivo</span>}</span>
        <span>{r.mail_sent ? <Pill kind="ok">Correo enviado</Pill> : <Pill kind="warn">El correo no salió</Pill>}</span>
      </div>
    </li>
  );
}

/** Restablecimientos de acceso (ADR-71): quién lo hizo, a quién, de qué empresa y con qué motivo. SOLO el Súper Admin lo ve (el servidor lo exige). */
export function AccessResetsPanel() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<ResetFilters>(NO_RESET_FILTERS);
  const q = useAccessResets(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const filtered = Boolean(filters.q || filters.actorRole);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Cada vez que alguien restablece el acceso de otra persona queda aquí, con su motivo. La empresa también lo ve en Equipo › Usuarios.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Persona o empresa" className={`${selectCls} font-normal`} />
        </label>
        <label className="grid gap-1 text-[12px] font-semibold">Quién lo hizo
          <select value={filters.actorRole} onChange={(e) => setFilters((f) => ({ ...f, actorRole: e.target.value as ResetFilters['actorRole'] }))} className={`${selectCls} font-normal`}>
            <option value="">Todos</option><option value="client_admin">Administrador del cliente</option><option value="agency">Agencias</option><option value="super_admin">Plataforma</option>
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters(NO_RESET_FILTERS); }}>Limpiar filtros</Button> : null}
      </div>
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando restablecimientos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los restablecimientos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">{filtered ? 'Ningún restablecimiento coincide con los filtros.' : 'Todavía nadie ha restablecido el acceso de otra persona.'}</p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-3" aria-label="Restablecimientos de acceso">{items.map((r) => <Row key={r.id} r={r} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
    </div>
  );
}
