import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import type { Company } from '../../lib/types';
import { Alert, Button, Field, Input, PasswordInput, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useDeleteCompany, useDeletionPreview } from './useCompanies';

const REASON_MIN = 10;
const REASON_MAX = 300;

/**
 * Eliminar una empresa (ADR-59 #1 y #13): resume lo que se perdería, explica la ventana de 7 días y pide los tres datos de confirmación (contraseña, nombre exacto y motivo).
 * Una agencia con clientes no se puede eliminar: se muestra la lista y el botón no existe.
 */
export function DeleteCompanyDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const preview = useDeletionPreview(company.id);
  const del = useDeleteCompany();
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const blockers = preview.data?.blockers ?? [];
  const nameOk = name.trim() === company.name;
  const reasonLen = reason.trim().length;
  const ready = password.length > 0 && nameOk && reasonLen >= REASON_MIN && reasonLen <= REASON_MAX && blockers.length === 0;

  function confirm() {
    setError(undefined);
    del.mutate(
      { id: company.id, password, confirm_name: name.trim(), reason: reason.trim() },
      { onSuccess: (r) => setDone(r.purge_after), onError: (e) => { setPassword(''); setError(friendlyError(e, 'No pudimos eliminar la empresa.')); } },
    );
  }

  if (done) {
    return (
      <Modal title="Empresa eliminada" onClose={onClose}>
        <Alert kind="ok">{company.name} quedó eliminada. Nadie puede entrar y todo lo automático se detuvo. Se puede recuperar hasta el {shortDate(done)}; después se borra de forma definitiva.</Alert>
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }

  const f = preview.data?.footprint;
  return (
    <Modal title={`Eliminar ${company.name}`} onClose={onClose} wide>
      {preview.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Revisando la empresa" /></div> : null}
      {preview.isError ? <Alert>{friendlyError(preview.error, 'No pudimos revisar la empresa.')}</Alert> : null}
      {preview.data ? (
        <>
          <p className="text-[13px] text-muted">
            La empresa queda <b className="text-fg">Eliminada</b> durante {preview.data.window_days} días: nadie puede entrar, se cierran todas las sesiones y se detienen los mensajes, las automatizaciones, los agentes de IA y los eventos a Meta. Dentro de ese plazo se puede recuperar tal como estaba. Pasado el plazo, <b className="text-fg">todos sus datos se borran de forma definitiva</b>.
          </p>
          {f ? (
            <ul className="grid gap-1 rounded-[10px] border border-line bg-surface2 px-3 py-2 text-[13px]" aria-label="Lo que se perdería">
              <li>{preview.data.plan ? <>Plan: <b>{preview.data.plan}</b></> : 'Sin plan'}</li>
              <li><b>{f.users}</b> {f.users === 1 ? 'persona con acceso' : 'personas con acceso'}</li>
              {preview.data.kind === 'client' ? (
                <>
                  <li><b>{f.contacts}</b> {f.contacts === 1 ? 'contacto' : 'contactos'} y <b>{f.sales}</b> {f.sales === 1 ? 'venta' : 'ventas'}</li>
                  <li><b>{f.ai_credits}</b> créditos de IA sin usar (se pierden: no hay reembolso automático)</li>
                </>
              ) : (
                <li><b>{f.clients}</b> {f.clients === 1 ? 'cliente' : 'clientes'}</li>
              )}
            </ul>
          ) : null}
          {blockers.map((b) => (
            <Alert key={b.code}>
              Esta agencia todavía tiene clientes. Muévelos a otra agencia o elimínalos primero:
              <ul className="mt-1 list-disc pl-5">{b.clients.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
            </Alert>
          ))}
          {blockers.length === 0 ? (
            <>
              <Field label={`Escribe el nombre de la empresa: ${company.name}`} required>
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
              <Field label="Motivo" required hint={`Entre ${REASON_MIN} y ${REASON_MAX} caracteres. Queda en la auditoría de la plataforma.`}>
                {(p) => <Input {...p} value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <Field label="Tu contraseña" required>
                {(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
              </Field>
            </>
          ) : null}
        </>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        {blockers.length === 0 ? <Button variant="danger" disabled={!ready || !preview.data} loading={del.isPending} onClick={confirm}>Eliminar empresa</Button> : null}
      </div>
    </Modal>
  );
}
