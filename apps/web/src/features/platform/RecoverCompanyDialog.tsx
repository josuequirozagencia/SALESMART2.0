import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import type { Company } from '../../lib/types';
import { Alert, Button, Field, PasswordInput } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useRecoverCompany } from './useCompanies';

/** Recuperar una empresa eliminada (ADR-59 #6): vuelve a su estado anterior; nadie recupera su sesión (cada quien entra de nuevo). Pide la contraseña del Súper Admin. */
export function RecoverCompanyDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const recover = useRecoverCompany();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  function confirm() {
    setError(undefined);
    recover.mutate({ id: company.id, password }, { onSuccess: () => setDone(true), onError: (e) => { setPassword(''); setError(friendlyError(e, 'No pudimos recuperar la empresa.')); } });
  }

  if (done) {
    return (
      <Modal title="Empresa recuperada" onClose={onClose}>
        <Alert kind="ok">{company.name} volvió a su estado anterior. Las personas deben iniciar sesión de nuevo y el dueño recibe un aviso por correo.</Alert>
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }
  return (
    <Modal title={`Recuperar ${company.name}`} onClose={onClose}>
      <p className="text-[13px] text-muted">
        {company.deletion ? <>Se borraría de forma definitiva el <b className="text-fg">{shortDate(company.deletion.purge_after)}</b>. </> : null}
        Al recuperarla vuelve exactamente a como estaba (si estaba suspendida, sigue suspendida). Lo que llegó mientras estuvo detenida se procesa, y lo que venció en ese tiempo y ya no debe salir tarde (recordatorios, mensajes programados, esperas y eventos a Meta viejos) se deja como omitido.
      </p>
      <Field label="Tu contraseña" required>
        {(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
      </Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={password.length === 0} loading={recover.isPending} onClick={confirm}>Recuperar empresa</Button>
      </div>
    </Modal>
  );
}
