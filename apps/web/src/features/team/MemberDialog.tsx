import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { initials, shortDateTime } from '../../lib/format';
import type { PermissionOverrides, TeamMember, TeamMemberFull, TeamRole, WeekHours } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { cloneWeek, defaultWeek, sameWeek, summarizeWeek, validateWeek } from '../sla/hours';
import { HoursEditor } from '../sla/HoursEditor';
import { useQueues } from '../queues/useQueues';
import { LeaveDialog } from './LeaveDialog';
import { PermissionsEditor } from './PermissionsEditor';
import { overrideCount, sameOverrides } from './permissions';
import { usePermissionCatalog, useReactivateMember, useRevokeSessions, useSetDepartments, useSetHours, useSetPermissions, useSetRole, useTeamMember } from './useTeam';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] text-fg';
const TABS = [['general', 'General'], ['permissions', 'Permisos'], ['access', 'Acceso']] as const;
type Tab = (typeof TABS)[number][0];

function General({ m }: { m: TeamMemberFull }) {
  const queues = useQueues();
  const setRole = useSetRole(m.user_id);
  const setDepts = useSetDepartments(m.user_id);
  const setHours = useSetHours(m.user_id);
  const [role, setRoleDraft] = useState<TeamRole>(m.role);
  const [depts, setDepts_] = useState<string[]>(m.departments.map((d) => d.id));
  const [ownHours, setOwnHours] = useState(m.hours !== null);
  const [week, setWeek] = useState<WeekHours>(m.hours ? cloneWeek(m.hours) : defaultWeek());
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const active = m.status === 'active';

  async function save() {
    setNote(undefined);
    setError(undefined);
    const deptsChanged = [...depts].sort().join() !== m.departments.map((d) => d.id).sort().join();
    const next = ownHours ? week : null;
    const hoursChanged = !sameWeek(next, m.hours);
    if (next) {
      const problem = validateWeek(next);
      if (problem) return setError(problem);
    }
    try {
      let changed = false;
      if (role !== m.role) { await setRole.mutateAsync(role); changed = true; }
      if (deptsChanged) { await setDepts.mutateAsync(depts); changed = true; }
      if (hoursChanged) { await setHours.mutateAsync(next); changed = true; }
      setNote(changed ? 'Cambios guardados.' : 'No había cambios que guardar.');
    } catch (e) {
      setError(friendlyError(e, 'No pudimos guardar los cambios.'));
    }
  }

  const busy = setRole.isPending || setDepts.isPending || setHours.isPending;
  return (
    <div className="grid gap-4">
      <section className="grid gap-1.5">
        <label htmlFor="member-role" className="text-[12.5px] font-semibold">Rol</label>
        <select id="member-role" className={selectCls} value={role} disabled={!active} onChange={(e) => setRoleDraft(e.target.value as TeamRole)}>
          <option value="advisor">Asesor</option>
          <option value="client_admin">Administrador</option>
        </select>
        <p className="text-[12.5px] text-muted">
          {role === 'client_admin' ? 'Administra toda la empresa y ve a todos.' : 'Atiende a sus clientes: ve solo lo suyo y lo que le comparten.'}
          {role !== m.role ? ' Al cambiar de rol se reinician sus permisos ajustados.' : ''}
        </p>
      </section>

      <fieldset className="grid gap-1.5" disabled={!active}>
        <legend className="text-[12.5px] font-semibold">Departamentos</legend>
        {(queues.data?.items ?? []).length === 0 ? <p className="text-[12.5px] text-muted">Aún no hay departamentos.</p> : null}
        <div className="flex flex-wrap gap-2">
          {(queues.data?.items ?? []).map((q) => (
            <label key={q.id} className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px]">
              <input type="checkbox" checked={depts.includes(q.id)} onChange={(e) => setDepts_(e.target.checked ? [...depts, q.id] : depts.filter((x) => x !== q.id))} />
              <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: q.color }} />
              {q.name}
            </label>
          ))}
        </div>
      </fieldset>

      <section className="grid gap-2 rounded-2xl border border-line p-4" aria-label="Horario laboral">
        <label className="flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" aria-label="Esta persona tiene su propio horario" checked={ownHours} disabled={!active} onChange={(e) => setOwnHours(e.target.checked)} className="mt-1" />
          <span>
            <b>Esta persona tiene su propio horario</b>
            <span className="block text-[12px] text-muted">
              {ownHours ? 'Fuera de su horario no recibe conversaciones nuevas del reparto automático (los feriados de la empresa también cuentan).' : 'Sin horario propio está disponible siempre para el reparto.'}
              {m.hours ? ` Guardado: ${summarizeWeek(m.hours)}.` : ''}
            </span>
          </span>
        </label>
        {ownHours ? <HoursEditor value={week} onChange={setWeek} /> : null}
      </section>

      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
      {active ? <div className="flex justify-end"><Button variant="primary" onClick={() => void save()} loading={busy}>Guardar cambios</Button></div> : null}
    </div>
  );
}

function Permissions({ m }: { m: TeamMemberFull }) {
  const catalog = usePermissionCatalog();
  const save = useSetPermissions(m.user_id);
  const [draft, setDraft] = useState<PermissionOverrides>(m.overrides);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const changed = !sameOverrides(draft, m.overrides);
  const active = m.status === 'active';

  function run(next: PermissionOverrides, done: string) {
    setNote(undefined);
    setError(undefined);
    save.mutate(next, {
      onSuccess: (r) => { setDraft(r.overrides); setNote(done); },
      onError: (e) => setError(friendlyError(e, 'No pudimos guardar los permisos.')),
    });
  }

  if (catalog.isPending) return <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando permisos" /></div>;
  if (catalog.isError) return <Alert>{friendlyError(catalog.error, 'No pudimos cargar el catálogo de permisos.')}</Alert>;
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">
        Parte de lo que trae el rol de {m.name.split(' ')[0]} ({m.role === 'client_admin' ? 'Administrador' : 'Asesor'}). Puedes activar o quitar funciones; los cambios rigen de inmediato.
        {m.role === 'advisor' ? ' Un asesor siempre ve solo lo suyo: las funciones de «Toda la empresa» no se le pueden conceder.' : ''}
      </p>
      <PermissionsEditor role={m.role} catalog={catalog.data} value={draft} onChange={setDraft} disabled={!active} />
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="link" disabled={overrideCount(draft) === 0 && overrideCount(m.overrides) === 0} onClick={() => run({ grant: [], deny: [] }, 'Volvió a la plantilla del rol.')}>Restablecer a la plantilla del rol</Button>
          <Button variant="primary" disabled={!changed} loading={save.isPending} onClick={() => run(draft, 'Permisos guardados.')}>Guardar permisos</Button>
        </div>
      ) : null}
    </div>
  );
}

function Access({ m, people, isSelf, onClose }: { m: TeamMemberFull; people: TeamMember[]; isSelf: boolean; onClose: () => void }) {
  const revoke = useRevokeSessions(m.user_id);
  const reactivate = useReactivateMember(m.user_id);
  const [leave, setLeave] = useState<'deactivate' | 'remove'>();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const active = m.status === 'active';

  return (
    <div className="grid gap-3">
      {isSelf ? <Alert kind="info">Esta es tu propia cuenta: para desactivarte o quitarte, pídeselo a otro administrador.</Alert> : null}
      {active ? (
        <section className="grid gap-1.5 rounded-2xl border border-line p-4">
          <b className="text-[13.5px]">Cerrar sesiones</b>
          <p className="text-[12.5px] text-muted">La saca de todos sus dispositivos ahora mismo. Podrá volver a entrar con su contraseña.</p>
          <div>
            <Button loading={revoke.isPending} onClick={() => { setNote(undefined); setError(undefined); revoke.mutate(undefined, { onSuccess: (r) => setNote(r.sessions_revoked === 0 ? 'No tenía sesiones abiertas.' : `Se cerraron ${r.sessions_revoked} ${r.sessions_revoked === 1 ? 'sesión' : 'sesiones'}.`), onError: (e) => setError(friendlyError(e)) }); }}>Cerrar todas sus sesiones</Button>
          </div>
        </section>
      ) : null}
      {active && !isSelf ? (
        <section className="grid gap-1.5 rounded-2xl border border-line p-4">
          <b className="text-[13.5px]">Desactivar o quitar del equipo</b>
          <p className="text-[12.5px] text-muted">Desactivar se puede deshacer. Quitar es definitivo: solo vuelve con una invitación nueva.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => setLeave('deactivate')}>Desactivar</Button>
            <Button variant="danger" onClick={() => setLeave('remove')}>Quitar del equipo</Button>
          </div>
        </section>
      ) : null}
      {!active ? (
        <section className="grid gap-1.5 rounded-2xl border border-line p-4">
          <b className="text-[13.5px]">Persona desactivada</b>
          <p className="text-[12.5px] text-muted">Vuelve con el mismo rol y los mismos permisos. Las conversaciones que se transfirieron no regresan.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={reactivate.isPending} onClick={() => { setError(undefined); reactivate.mutate(undefined, { onSuccess: () => setNote('Reactivada.'), onError: (e) => setError(friendlyError(e, 'No pudimos reactivarla.')) }); }}>Reactivar</Button>
            <Button variant="danger" onClick={() => setLeave('remove')}>Quitar del equipo</Button>
          </div>
        </section>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
      {leave ? (
        <LeaveDialog
          member={m}
          kind={leave}
          people={people}
          openConversations={m.open_conversations}
          onClose={() => setLeave(undefined)}
          onDone={() => { setLeave(undefined); onClose(); }}
        />
      ) : null}
    </div>
  );
}

/** Ficha de una persona del equipo (M10.4, ADR-56 B3): rol, departamentos, horario, permisos y acceso. */
export function MemberDialog({ userId, people, selfId, onClose }: { userId: string; people: TeamMember[]; selfId: string; onClose: () => void }) {
  const q = useTeamMember(userId);
  const [tab, setTab] = useState<Tab>('general');
  const m = q.data;
  return (
    <Modal title={m ? m.name : 'Persona del equipo'} onClose={onClose} xl>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No encontramos a esa persona.')}</Alert> : null}
      {m ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-accent-soft text-[14px] font-bold text-accent">{initials(m.name)}</span>
            <div className="grid min-w-0">
              <span className="truncate text-[13.5px]">{m.email}{m.phone ? ` · ${m.phone}` : ''}</span>
              <span className="text-[12px] text-muted">{m.last_access_at ? `Último acceso: ${shortDateTime(m.last_access_at)}` : 'Aún no ha entrado'}</span>
            </div>
            <Pill kind={m.status === 'active' ? 'ok' : 'muted'}>{m.status === 'active' ? 'Activo' : 'Desactivado'}</Pill>
            {m.custom_permissions ? <Pill kind="accent">Permisos personalizados</Pill> : null}
          </div>
          <div role="tablist" aria-label="Secciones de la persona" className="flex gap-1 border-b border-line">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-semibold ${tab === id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg'}`}>{label}</button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto pr-1" role="tabpanel" aria-label={TABS.find((t) => t[0] === tab)![1]}>
            {tab === 'general' ? <General key={m.user_id} m={m} /> : null}
            {tab === 'permissions' ? <Permissions key={m.user_id + m.role} m={m} /> : null}
            {tab === 'access' ? <Access m={m} people={people} isSelf={m.user_id === selfId} onClose={onClose} /> : null}
          </div>
          <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
        </div>
      ) : null}
    </Modal>
  );
}
