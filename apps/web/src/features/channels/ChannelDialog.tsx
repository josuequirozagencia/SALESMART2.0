import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Channel } from '../../lib/types';
import { Alert, Button, Field, Input, PasswordInput } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useQueues } from '../queues/useQueues';
import { useConnectChannel, useUpdateChannel } from './useChannels';

const IDS = /^[0-9]{5,25}$/;
const TOKEN = /^[\x21-\x7E]{10,1000}$/;

/**
 * Conectar un número de WhatsApp oficial (sin `channel`) o editar una conexión (nombre y, si hace falta, un token nuevo). El servidor comprueba el token con Meta
 * antes de guardar: si Meta lo rechaza, el mensaje de aquí lo explica y no se guarda nada. El token se pega y NO se vuelve a mostrar.
 */
export function ChannelDialog({ channel, onClose }: { channel?: Channel; onClose: () => void }) {
  const [name, setName] = useState(channel?.name ?? '');
  const [waba, setWaba] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const [token, setToken] = useState('');
  const [queueId, setQueueId] = useState(channel?.queue_id ?? '');
  const queues = useQueues();
  const [errors, setErrors] = useState<Partial<Record<'name' | 'waba' | 'phone' | 'token', string>>>({});
  const [error, setError] = useState<string>();
  const connect = useConnectChannel();
  const update = useUpdateChannel();
  const editing = channel !== undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim(), w = waba.trim(), p = phoneId.trim(), t = token.trim();
    const next: typeof errors = {};
    if (n === '') next.name = 'Escribe un nombre para reconocer esta conexión';
    else if (n.length > 60) next.name = 'Usa como máximo 60 caracteres';
    if (!editing && !IDS.test(w)) next.waba = 'Son solo dígitos (entre 5 y 25). Cópialo de Meta tal cual';
    if (!editing && !IDS.test(p)) next.phone = 'Son solo dígitos (entre 5 y 25). Cópialo de Meta tal cual';
    if (!editing && !TOKEN.test(t)) next.token = 'Pega el token completo, sin espacios';
    if (editing && t !== '' && !TOKEN.test(t)) next.token = 'Pega el token completo, sin espacios';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setError(undefined);
    const h = { onSuccess: onClose, onError: (err: unknown) => setError(friendlyError(err, 'No pudimos guardar la conexión.')) };
    if (editing) {
      const input: { name?: string; access_token?: string; queue_id?: string | null } = {};
      if (n !== channel.name) input.name = n;
      if (queueId !== (channel.queue_id ?? '')) input.queue_id = queueId === '' ? null : queueId;
      if (t !== '') input.access_token = t;
      if (Object.keys(input).length === 0) return onClose();
      update.mutate({ id: channel.id, input }, h);
    } else {
      connect.mutate({ name: n, waba_id: w, phone_number_id: p, access_token: t, ...(queueId !== '' ? { queue_id: queueId } : {}) }, h);
    }
  }

  const title = editing ? 'Editar conexión' : 'Conectar un número de WhatsApp';
  const busy = connect.isPending || update.isPending;
  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={title}>
        <Field label="Nombre" error={errors.name} hint="Solo para que tu equipo la reconozca, por ejemplo «Ventas»." required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}
        </Field>
        {editing ? (
          <p className="rounded-[10px] bg-surface2 px-3 py-2 text-[12.5px] text-muted">Número: <b className="text-fg">{channel.display_phone ?? channel.phone_number_id}</b>. El número no se cambia; para usar otro, conéctalo como una conexión nueva.</p>
        ) : (
          <>
            <Field label="ID de la cuenta de WhatsApp Business (WABA ID)" error={errors.waba} required>
              {(p) => <Input {...p} value={waba} onChange={(e) => setWaba(e.target.value)} inputMode="numeric" autoComplete="off" />}
            </Field>
            <Field label="ID del número de teléfono (Phone number ID)" error={errors.phone} hint="No es el teléfono: es el identificador que Meta le da al número." required>
              {(p) => <Input {...p} value={phoneId} onChange={(e) => setPhoneId(e.target.value)} inputMode="numeric" autoComplete="off" />}
            </Field>
          </>
        )}
        <Field label={editing ? 'Token nuevo (opcional)' : 'Token de acceso permanente'} error={errors.token} hint={editing ? 'Déjalo vacío para conservar el actual. Se comprueba con Meta antes de guardarlo.' : 'Se guarda cifrado y no se vuelve a mostrar. Se comprueba con Meta antes de guardarlo.'} required={!editing}>
          {(p) => <PasswordInput {...p} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <Field label="Departamento por defecto" hint="Las conversaciones nuevas de este número van a este departamento, que decide el asesor. Sin departamento quedan «sin asignar».">
          {(p) => (
            <select {...p} value={queueId} onChange={(e) => setQueueId(e.target.value)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg">
              <option value="">Sin departamento</option>
              {(queues.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={busy}>{editing ? 'Guardar' : 'Conectar'}</Button>
        </div>
      </form>
    </Modal>
  );
}
