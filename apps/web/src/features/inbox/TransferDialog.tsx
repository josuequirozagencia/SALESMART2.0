import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { ROLE_LABEL } from '../../lib/format';
import type { Conversation, PersonOption, TransferResult } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useRevoke, useShare, useTransfer, useTransferOptions } from './useInbox';

type Mode = 'transfer' | 'share';
type Permission = 'reply' | 'view';

const PERMISSION_LABEL: Record<Permission, string> = { reply: 'Puede responder', view: 'Solo ver y dejar notas' };
const KEEP_LABEL: Record<'none' | Permission, string> = { none: 'Dejar de participar', reply: 'Seguir como colaborador: puede responder', view: 'Seguir como colaborador: solo ver y dejar notas' };

function Person({ p, checked, disabled, hint, onPick, name }: { p: PersonOption; checked: boolean; disabled: boolean; hint: string | null; onPick: () => void; name: string }) {
  return (
    <label className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 ${checked ? 'border-accent bg-accent-soft' : 'border-line'} ${disabled ? 'opacity-55' : 'cursor-pointer hover:bg-surface2'}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} aria-label={p.name} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-[13.5px] font-semibold">{p.name}{p.is_self ? ' (tú)' : ''}</span>
        <span className="text-[12px] text-muted">{ROLE_LABEL[p.role] ?? p.role} · {p.open_count === 1 ? '1 conversación abierta' : `${p.open_count} conversaciones abiertas`}</span>
      </span>
      {p.in_queue === true ? <Pill kind="ok">En el departamento</Pill> : null}
      {p.in_queue === false ? <Pill kind="warn">Fuera del departamento</Pill> : null}
      {hint ? <Pill kind="muted">{hint}</Pill> : null}
    </label>
  );
}

/**
 * «Transferir» (cambia el dueño: la otra persona debe aceptar) o «Compartir» (da acceso sin cambiar el dueño) una conversación (M5.5, ADR-14; F10). El selector muestra
 * la carga de cada persona y si está en la cola de la conversación (advertencia, no bloqueo). También lista quién tiene acceso y permite quitarlo.
 */
export function TransferDialog({ c, onClose, onTransferred }: { c: Conversation; onClose: () => void; onTransferred: (r: TransferResult) => void }) {
  const options = useTransferOptions(c.id, true);
  const transfer = useTransfer(c.id);
  const share = useShare(c.id);
  const revoke = useRevoke(c.id);
  const [mode, setMode] = useState<Mode>(c.can.transfer ? 'transfer' : 'share');
  const [pick, setPick] = useState('');
  const [keep, setKeep] = useState<'none' | Permission>('none');
  const [permission, setPermission] = useState<Permission>('reply');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();

  const people = options.data?.items ?? [];
  const chosen = people.find((p) => p.id === pick);
  const busy = transfer.isPending || share.isPending;
  const queueName = options.data?.queue?.name ?? null;
  const fail = (fallback: string) => (e: unknown) => setError(friendlyError(e, fallback));

  const submit = (): void => {
    if (!chosen) return;
    setError(undefined);
    const trimmed = note.trim();
    if (mode === 'transfer') {
      transfer.mutate({ to_user_id: chosen.id, ...(keep !== 'none' ? { keep_as: keep } : {}), ...(trimmed ? { note: trimmed } : {}) }, { onSuccess: onTransferred, onError: fail('No pudimos transferir la conversación.') });
    } else {
      share.mutate({ user_id: chosen.id, permission, ...(trimmed ? { note: trimmed } : {}) }, { onSuccess: onClose, onError: fail('No pudimos compartir la conversación.') });
    }
  };

  return (
    <Modal title="Transferir o compartir" onClose={onClose} wide>
      <div role="tablist" aria-label="Qué hacer" className="flex gap-1.5">
        {c.can.transfer ? <button type="button" role="tab" aria-selected={mode === 'transfer'} onClick={() => { setMode('transfer'); setError(undefined); }} className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${mode === 'transfer' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>Transferir</button> : null}
        {c.can.share ? <button type="button" role="tab" aria-selected={mode === 'share'} onClick={() => { setMode('share'); setError(undefined); }} className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${mode === 'share' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>Compartir</button> : null}
      </div>
      <p className="text-[12.5px] text-muted">
        {mode === 'transfer' ? 'La conversación (y el lead) pasa a la otra persona, que debe aceptarla. Con ella van el seguimiento y la comisión.' : 'La otra persona accede a la misma conversación sin cambiar quién la lleva: quien la tiene conserva el seguimiento y la comisión.'}
      </p>

      {options.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando personas" /></div> : null}
      {options.isError ? <Alert>{friendlyError(options.error, 'No pudimos cargar a las personas del equipo.')}</Alert> : null}
      {options.isSuccess ? (
        <fieldset className="grid max-h-[260px] gap-1.5 overflow-y-auto border-0 p-0">
          <legend className="mb-1 text-[12.5px] font-semibold">Persona</legend>
          {people.map((p) => {
            const already = mode === 'share' && p.collaborator !== null ? `Ya participa (${p.collaborator === 'reply' ? 'responde' : 've'})` : null;
            return <Person key={p.id} p={p} name="persona" checked={pick === p.id} disabled={p.is_owner} hint={p.is_owner ? 'Quien la tiene' : already} onPick={() => setPick(p.id)} />;
          })}
        </fieldset>
      ) : null}
      {chosen && chosen.in_queue === false && queueName ? <Alert kind="info">{chosen.name} no está en el departamento «{queueName}». Puedes continuar de todos modos.</Alert> : null}

      {mode === 'transfer' && c.owner ? (
        <fieldset className="grid gap-1 border-0 p-0">
          <legend className="mb-1 text-[12.5px] font-semibold">{c.my_access === 'owner' ? 'Después de transferir, tú' : `Después de transferir, ${c.owner.name}`}</legend>
          {(['none', 'reply', 'view'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-[13px]"><input type="radio" name="keep" checked={keep === k} onChange={() => setKeep(k)} />{KEEP_LABEL[k]}</label>
          ))}
        </fieldset>
      ) : null}
      {mode === 'share' ? (
        <fieldset className="grid gap-1 border-0 p-0">
          <legend className="mb-1 text-[12.5px] font-semibold">Permiso</legend>
          {(['reply', 'view'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-[13px]"><input type="radio" name="permission" checked={permission === k} onChange={() => setPermission(k)} />{PERMISSION_LABEL[k]}</label>
          ))}
        </fieldset>
      ) : null}

      <label className="grid gap-1 text-[12.5px] font-semibold">Nota (opcional)
        <textarea aria-label="Nota (opcional)" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Queda en el historial interno de la conversación" className="resize-none rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px] font-normal" />
      </label>

      {c.participants.length > 0 ? (
        <section aria-label="Quién tiene acceso" className="grid gap-1.5 rounded-xl border border-line p-2.5">
          <h3 className="text-[12.5px] font-semibold">Ya tienen acceso</h3>
          {c.participants.map((p) => (
            <div key={p.user.id} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{p.user.name} · <span className="text-muted">{PERMISSION_LABEL[p.permission]}</span></span>
              {c.can.share ? <Button variant="link" className="text-[12.5px]" aria-label={`Quitar el acceso de ${p.user.name}`} loading={revoke.isPending && revoke.variables === p.user.id} onClick={() => { setError(undefined); revoke.mutate(p.user.id, { onError: fail('No pudimos quitar el acceso.') }); }}>Quitar</Button> : null}
            </div>
          ))}
        </section>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!chosen} loading={busy} onClick={submit}>{mode === 'transfer' ? 'Transferir' : 'Compartir'}</Button>
      </div>
    </Modal>
  );
}
