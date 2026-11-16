import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import type { AccessResetResult, TeamMember } from '../../lib/types';
import { Alert, Button, Field, PasswordInput } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useResetAccess } from './useTeam';

export const REASON_MIN = 10;
export const REASON_MAX = 300;

/**
 * Restablecer el acceso de una persona (ADR-71). Explica en español qué pasa (se cierran sus sesiones, su contraseña actual deja de servir y recibe un enlace EN SU correo; nadie más ve el enlace),
 * pide el motivo (obligatorio cuando actúa la agencia o el Súper Admin) y la contraseña de quien lo hace. Los controles de verdad están en el servidor.
 */
export function ResetAccessDialog({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const { state } = useSession();
  // Cuando actúa la agencia o el Súper Admin el motivo es obligatorio (el servidor lo exige igual)
  const required = state.status === 'authed' && state.me.acting_as !== null;
  const reset = useResetAccess(member.user_id);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<AccessResetResult>();
  const trimmed = reason.trim();
  const reasonError = trimmed.length === 0 ? (required ? `Escribe el motivo (al menos ${REASON_MIN} caracteres).` : undefined) : trimmed.length < REASON_MIN ? `El motivo debe tener al menos ${REASON_MIN} caracteres.` : trimmed.length > REASON_MAX ? `El motivo no puede pasar de ${REASON_MAX} caracteres.` : undefined;
  const [touched, setTouched] = useState(false);

  function submit() {
    setTouched(true);
    setError(undefined);
    if (reasonError || password === '') return;
    reset.mutate({ current_password: password, ...(trimmed ? { reason: trimmed } : {}) }, { onSuccess: (r) => setDone(r), onError: (e) => setError(friendlyError(e, 'No pudimos restablecer el acceso.')) });
  }

  if (done) {
    return (
      <Modal title="Acceso restablecido" onClose={onClose}>
        <div className="grid gap-3">
          {done.mail_sent ? (
            <Alert kind="ok">{`Cerramos ${done.sessions_revoked === 1 ? 'su sesión abierta' : `sus ${done.sessions_revoked} sesiones abiertas`} y enviamos el enlace a ${done.email_hint}.`}</Alert>
          ) : (
            <Alert>{`Cerramos sus sesiones y su contraseña actual ya no sirve, pero el correo con el enlace NO salió. Vuelve a intentarlo para que ${member.name} pueda entrar.`}</Alert>
          )}
          <p className="text-[13px] text-muted">{member.name} elige una contraseña nueva con ese enlace (funciona una sola vez). {done.notified > 0 ? `Avisamos a ${done.notified === 1 ? 'otro administrador' : `${done.notified} administradores`} de la empresa.` : ''}</p>
          <div className="flex justify-end gap-2">
            {!done.mail_sent ? <Button onClick={() => { setDone(undefined); setPassword(''); }}>Volver a intentarlo</Button> : null}
            <Button variant="primary" onClick={onClose}>Listo</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Restablecer el acceso de ${member.name}`} onClose={onClose}>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className="grid gap-1 rounded-xl bg-surface2 p-3 text-[13px]">
          <b>Qué va a pasar</b>
          <ul className="ml-4 list-disc text-muted">
            <li>Se cierran todas sus sesiones, en todos sus dispositivos.</li>
            <li>Su contraseña actual deja de servir hasta que cree una nueva.</li>
            <li>Recibe un enlace en su correo ({member.email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}). Solo ella o él lo ve: tú no recibes el enlace ni eliges su contraseña.</li>
            {required ? <li>Se avisa por correo a los administradores de la empresa y queda registrado con tu nombre.</li> : null}
          </ul>
        </div>
        <Field label="Motivo" required={required} hint={required ? `Obligatorio: queda en el registro y se le muestra a la persona y a los administradores (${REASON_MIN} a ${REASON_MAX} caracteres).` : 'Opcional. Si lo escribes, se le muestra a la persona.'} error={touched ? reasonError : undefined}>
          {(p) => <textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX + 50} rows={3} className="w-full rounded-[11px] border border-line-strong bg-surface px-3 py-[11px] text-[14px] font-normal text-fg aria-[invalid=true]:border-crit" />}
        </Field>
        <Field label="Tu contraseña" required hint="La pedimos para confirmar que eres tú." error={touched && password === '' ? 'Escribe tu contraseña.' : undefined}>
          {(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="danger" loading={reset.isPending}>Restablecer acceso</Button>
        </div>
      </form>
    </Modal>
  );
}
