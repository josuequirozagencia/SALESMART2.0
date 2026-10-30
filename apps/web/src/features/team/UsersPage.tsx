import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { initials, shortDateTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { InviteResult, TeamInvitation, TeamMember } from '../../lib/types';
import { Alert, Button, Input, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { InviteDialog } from './InviteDialog';
import { MemberDialog } from './MemberDialog';
import { useCancelInvitation, useResendInvitation, useTeam } from './useTeam';

const ROLE_LABEL = { client_admin: 'Administrador', advisor: 'Asesor' } as const;
type Filter = 'all' | 'active' | 'deactivated';
const FILTERS: Array<[Filter, string]> = [['all', 'Todos'], ['active', 'Activos'], ['deactivated', 'Desactivados']];

function MemberRow({ m, onOpen }: { m: TeamMember; onOpen: () => void }) {
  return (
    <li>
      <button type="button" aria-label={`Abrir a ${m.name}`} onClick={onOpen} className="grid w-full gap-1.5 rounded-2xl border border-line bg-surface p-3 text-left transition hover:border-accent sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center sm:gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-bold text-accent">{initials(m.name)}</span>
          <span className="grid min-w-0">
            <b className="truncate text-[14px]">{m.name}</b>
            <span className="truncate text-[12.5px] text-muted">{m.email}</span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill kind={m.role === 'client_admin' ? 'accent' : 'info'}>{ROLE_LABEL[m.role]}</Pill>
          <Pill kind={m.status === 'active' ? 'ok' : 'muted'}>{m.status === 'active' ? 'Activo' : 'Desactivado'}</Pill>
          {m.custom_permissions ? <Pill kind="warn">Permisos personalizados</Pill> : null}
        </span>
        <span className="grid gap-1 text-[12.5px] text-muted">
          <span className="flex flex-wrap gap-1.5">
            {m.departments.length === 0 ? <span>Sin departamento</span> : m.departments.map((d) => (
              <span key={d.id} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5"><span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: d.color }} />{d.name}</span>
            ))}
          </span>
          <span>{m.last_access_at ? `Último acceso: ${shortDateTime(m.last_access_at)}` : 'Aún no ha entrado'}</span>
        </span>
      </button>
    </li>
  );
}

function InvitationRow({ inv }: { inv: TeamInvitation }) {
  const resend = useResendInvitation();
  const cancel = useCancelInvitation();
  const [result, setResult] = useState<InviteResult>();
  const [error, setError] = useState<string>();
  return (
    <li className="grid gap-2 rounded-2xl border border-dashed border-line p-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-center">
      <span className="grid min-w-0">
        <b className="truncate text-[14px]">{inv.email}</b>
        <span className="text-[12.5px] text-muted">{inv.expired ? 'Venció' : `Vence el ${shortDateTime(inv.expires_at)}`} · enviada {inv.sent_count} {inv.sent_count === 1 ? 'vez' : 'veces'}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Pill kind="warn">{inv.expired ? 'Invitación vencida' : 'Invitado'}</Pill>
        <Pill kind={inv.role === 'client_admin' ? 'accent' : 'info'}>{ROLE_LABEL[inv.role]}</Pill>
      </span>
      <span className="flex flex-wrap gap-2">
        <Button aria-label={`Reenviar la invitación a ${inv.email}`} loading={resend.isPending} onClick={() => { setError(undefined); resend.mutate(inv.id, { onSuccess: setResult, onError: (e) => setError(friendlyError(e, 'No pudimos reenviarla.')) }); }}>Reenviar</Button>
        <Button variant="danger" aria-label={`Cancelar la invitación a ${inv.email}`} loading={cancel.isPending} onClick={() => { setError(undefined); cancel.mutate(inv.id, { onError: (e) => setError(friendlyError(e, 'No pudimos cancelarla.')) }); }}>Cancelar</Button>
      </span>
      {error ? <span role="alert" className="text-[12.5px] font-medium text-crit sm:col-span-3">{error}</span> : null}
      {result ? (
        <Modal title={result.delivery === 'sent' ? 'Invitación reenviada' : 'Enlace de invitación'} onClose={() => setResult(undefined)}>
          {result.delivery === 'sent' ? <p className="text-[13.5px]">Enviamos de nuevo el correo a <b>{result.email}</b>. El enlace anterior dejó de valer.</p> : (
            <>
              <Alert kind="info">No pudimos enviar el correo. Comparte este enlace por otro medio.</Alert>
              {result.invite_url ? <CopyField label="Enlace de invitación" value={result.invite_url} /> : null}
            </>
          )}
          <div className="flex justify-end"><Button variant="primary" onClick={() => setResult(undefined)}>Listo</Button></div>
        </Modal>
      ) : null}
    </li>
  );
}

/**
 * Equipo › Usuarios (M10.4, ADR-56 B3). Solo `users.manage` (el administrador): ver al equipo, invitar, cambiar el rol, los departamentos, el horario y los permisos de cada persona,
 * cerrar sesiones, desactivar y quitar. El servidor aplica todo (techo de permisos, último administrador, qué pasa con las conversaciones); esta pantalla solo lo captura.
 */
export function UsersPage() {
  const team = useTeam();
  const { state } = useSession();
  const selfId = state.status === 'authed' ? state.me.user.id : '';
  const [inviting, setInviting] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const items = useMemo(() => team.data?.items ?? [], [team.data]);
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((m) => (filter === 'all' || m.status === filter) && (term === '' || m.name.toLowerCase().includes(term) || m.email.toLowerCase().includes(term)));
  }, [items, filter, search]);
  const invitations = team.data?.invitations ?? [];

  return (
    <div className="grid gap-4">
      <h1 className="text-[22px] font-bold">Usuarios</h1>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[680px] text-[13.5px] text-muted">
          Las personas de tu empresa. Un asesor ve solo lo suyo; puedes ajustar sus funciones, sus departamentos y su horario. Quien necesite ver todo es administrador.
        </p>
        {team.isSuccess ? <Button variant="primary" onClick={() => setInviting(true)}>Invitar persona</Button> : null}
      </div>

      {team.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando usuarios" /></div> : null}
      {team.isError ? <Alert>{friendlyError(team.error, 'Solo el administrador de la empresa puede ver y cambiar a los usuarios.')} <Button variant="link" onClick={() => void team.refetch()}>Reintentar</Button></Alert> : null}

      {team.isSuccess ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full sm:w-[280px]"><Input aria-label="Buscar usuarios" type="search" placeholder="Buscar por nombre o correo" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <div role="group" aria-label="Estado" className="flex gap-1">
              {FILTERS.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`rounded-full border px-3 py-1.5 text-[13px] font-semibold ${filter === id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{label}</button>
              ))}
            </div>
          </div>

          {invitations.length > 0 ? (
            <section className="grid gap-2" aria-label="Invitaciones pendientes">
              <h2 className="text-[14px] font-semibold">Invitaciones pendientes</h2>
              <ul className="grid gap-2">{invitations.map((i) => <InvitationRow key={i.id} inv={i} />)}</ul>
            </section>
          ) : null}

          <section className="grid gap-2" aria-label="Equipo">
            {shown.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[13.5px] text-muted">{items.length === 0 ? 'Aún no hay personas en el equipo.' : 'Nadie coincide con ese filtro.'}</p>
            ) : (
              <ul aria-label="Personas del equipo" className="grid gap-2">{shown.map((m) => <MemberRow key={m.user_id} m={m} onOpen={() => setOpenId(m.user_id)} />)}</ul>
            )}
          </section>
        </>
      ) : null}

      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
      {openId ? <MemberDialog key={openId} userId={openId} people={items} selfId={selfId} onClose={() => setOpenId(undefined)} /> : null}
    </div>
  );
}
