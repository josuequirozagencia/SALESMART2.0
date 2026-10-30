import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { InviteResult, PermissionOverrides, TeamRole } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Modal } from '../../ui/Modal';
import { useQueues } from '../queues/useQueues';
import { PermissionsEditor } from './PermissionsEditor';
import { overrideCount } from './permissions';
import { useInviteMember, usePermissionCatalog } from './useTeam';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] text-fg';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invitar a una persona al equipo (M10.4, ADR-56 B3): correo, rol, departamentos y, si se quiere, ajustes de permisos que se aplican cuando acepte. El enlace solo se muestra si el
 * correo no pudo salir (el servidor lo devuelve únicamente en ese caso).
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const invite = useInviteMember();
  const catalog = usePermissionCatalog();
  const queues = useQueues();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('advisor');
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [overrides, setOverrides] = useState<PermissionOverrides>({ grant: [], deny: [] });
  const [error, setError] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const [result, setResult] = useState<InviteResult>();
  const items = queues.data?.items ?? [];

  function changeRole(next: TeamRole) {
    setRole(next);
    setOverrides({ grant: [], deny: [] }); // los ajustes son de la plantilla de cada rol
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const clean = email.trim();
    if (!EMAIL.test(clean)) return setEmailError('Escribe un correo válido.');
    setEmailError(undefined);
    invite.mutate(
      { email: clean, role, ...(custom && overrideCount(overrides) > 0 ? { permissions: overrides } : {}), ...(queueIds.length > 0 ? { queue_ids: queueIds } : {}) },
      { onSuccess: setResult, onError: (err) => setError(friendlyError(err, 'No pudimos enviar la invitación.')) },
    );
  }

  if (result) {
    const sent = result.delivery === 'sent';
    return (
      <Modal title={sent ? 'Invitación enviada' : 'Invitación creada'} onClose={onClose}>
        {sent ? (
          <p className="text-[13.5px]">Enviamos un correo a <b>{result.email}</b> con el enlace para unirse. Vence en 7 días; puedes reenviarla desde la lista de invitaciones.</p>
        ) : (
          <>
            <Alert kind="info">No pudimos enviar el correo. Comparte este enlace con la persona por otro medio; vence en 7 días.</Alert>
            {result.invite_url ? <CopyField label="Enlace de invitación" value={result.invite_url} /> : null}
          </>
        )}
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }

  return (
    <Modal title="Invitar al equipo" onClose={onClose} xl>
      <form aria-label="Invitar al equipo" onSubmit={submit} noValidate className="grid gap-3">
        <Field label="Correo" error={emailError} required>
          {(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@empresa.com" />}
        </Field>
        <Field label="Rol" hint={catalog.data?.roles.find((r) => r.id === role)?.description ?? ''}>
          {(p) => (
            <select {...p} className={selectCls} value={role} onChange={(e) => changeRole(e.target.value as TeamRole)}>
              <option value="advisor">Asesor</option>
              <option value="client_admin">Administrador</option>
            </select>
          )}
        </Field>
        {items.length > 0 ? (
          <fieldset className="grid gap-1.5">
            <legend className="text-[12.5px] font-semibold">Departamentos (opcional)</legend>
            <div className="flex flex-wrap gap-2">
              {items.map((q) => (
                <label key={q.id} className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px]">
                  <input type="checkbox" checked={queueIds.includes(q.id)} onChange={(e) => setQueueIds(e.target.checked ? [...queueIds, q.id] : queueIds.filter((x) => x !== q.id))} />
                  <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: q.color }} />
                  {q.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" className="mt-1" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
          <span><b>Ajustar sus permisos desde el inicio</b><span className="block text-[12px] text-muted">Por omisión recibe los de su rol. Siempre puedes cambiarlos después.</span></span>
        </label>
        {custom && catalog.data ? <PermissionsEditor role={role} catalog={catalog.data} value={overrides} onChange={setOverrides} /> : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" loading={invite.isPending}>Enviar invitación</Button>
        </div>
      </form>
    </Modal>
  );
}
