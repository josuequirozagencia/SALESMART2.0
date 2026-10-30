import { useEffect, useRef, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill, type PillKind } from '../../ui/Pill';
import { useQueues } from '../queues/useQueues';
import { useQrChannels, useQrMutations, useQrStatus, type QrChannel, type QrState } from './useQrChannels';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
/** Un QR sin escanear caduca; tras tantas renovaciones seguidas Evolution deja de generarlos y hay que empezar de nuevo. */
const MAX_AUTO_QR = 5;

export const QR_STATE: Record<QrState, { kind: PillKind; label: string }> = {
  created: { kind: 'muted', label: 'Sin vincular' },
  connecting: { kind: 'info', label: 'Conectando…' },
  open: { kind: 'ok', label: 'Conectado' },
  logged_out: { kind: 'crit', label: 'Desconectado' },
  closed: { kind: 'crit', label: 'Sesión caída' },
};

/** El aviso de riesgo del canal NO OFICIAL: se muestra antes de crear y se deja a la vista. */
export function RiskNotice() {
  return (
    <Alert kind="info">
      <b>Canal no oficial.</b> WhatsApp por QR no usa la API oficial de Meta: WhatsApp puede <b>bloquear el número</b> si envía mucho o de golpe. Usa un número que puedas perder, déjalo <b>calentar</b> (pocos mensajes los primeros días) y no lo uses para envíos masivos. Si la sesión se cae, los mensajes esperan y salen al volver a escanear el QR.
    </Alert>
  );
}

/** Vincular el teléfono: muestra el QR con su cuenta regresiva, lo renueva solo y avisa cuando WhatsApp queda conectado. */
function PairDialog({ channel, onClose }: { channel: QrChannel; onClose: () => void }) {
  const m = useQrMutations();
  const [qr, setQr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [renewals, setRenewals] = useState(0);
  const [error, setError] = useState<string>();
  const status = useQrStatus(channel.id, 3000);
  const state = status.data?.state ?? channel.state;
  const renewRef = useRef<() => void>(() => undefined);
  const started = useRef(false);

  const renew = (): void => {
    setError(undefined);
    m.code.mutate(channel.id, {
      onSuccess: (r) => { setQr(r.qr); setLeft(r.expires_in); setRenewals((n) => n + 1); },
      onError: (e) => setError(friendlyError(e, 'No pudimos generar el QR.')),
    });
  };
  useEffect(() => {
    renewRef.current = renew; // siempre la versión más reciente (la que ve el estado actual)
  });
  // El primer QR sale al abrir; después se renueva solo cuando se agota la cuenta regresiva (hasta el límite)
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    renewRef.current();
  }, []);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const canRenew = left === 0 && qr !== null && state !== 'open' && renewals < MAX_AUTO_QR && !m.code.isPending;
  useEffect(() => {
    if (canRenew) renewRef.current();
  }, [canRenew]);

  const exhausted = qr !== null && left === 0 && renewals >= MAX_AUTO_QR && state !== 'open';
  return (
    <Modal title={`Vincular «${channel.name}»`} onClose={onClose}>
      <div className="grid gap-3">
        {state === 'open' ? (
          <Alert kind="ok">¡Conectado! {status.data?.phone ?? channel.phone ?? ''}{status.data?.profile_name ? ` · ${status.data.profile_name}` : ''}. Ya puedes recibir y enviar mensajes por este número.</Alert>
        ) : (
          <>
            <ol className="grid list-decimal gap-1 pl-5 text-[13px] text-muted">
              <li>Abre WhatsApp (o WhatsApp Business) en el teléfono del chip.</li>
              <li>Ve a <b>Ajustes › Dispositivos vinculados › Vincular un dispositivo</b>.</li>
              <li>Escanea este código. Caduca en unos segundos y se renueva solo.</li>
            </ol>
            <div className="grid place-items-center gap-2 rounded-xl border border-line bg-white p-4">
              {qr ? <img src={qr} alt="Código QR para vincular WhatsApp" width={240} height={240} className="h-60 w-60" /> : m.code.isPending ? <Spinner label="Generando el QR" /> : <span className="py-10 text-[13px] text-muted">Sin código todavía</span>}
              {qr && left > 0 ? <span role="timer" className="text-[12.5px] text-muted">Caduca en {left} s</span> : null}
            </div>
            {exhausted ? <Alert kind="info">Se agotaron los códigos sin escanearse. Genera uno nuevo cuando tengas el teléfono listo.</Alert> : null}
            <div><Button onClick={() => { setRenewals(0); renew(); }} loading={m.code.isPending}>Generar otro QR</Button></div>
          </>
        )}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end"><Button onClick={onClose}>{state === 'open' ? 'Listo' : 'Cerrar'}</Button></div>
      </div>
    </Modal>
  );
}

/** Crear la conexión: nombre, cola y el aviso de riesgo (hay que aceptarlo). Al crearla pasa a vincular el teléfono. */
function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: QrChannel) => void }) {
  const m = useQrMutations();
  const queues = useQueues();
  const [name, setName] = useState('');
  const [queue, setQueue] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name.trim() === '') return setError('Escribe un nombre para la conexión.');
    if (!ack) return setError('Confirma que entiendes el riesgo de un canal no oficial.');
    setError(undefined);
    m.create.mutate({ name: name.trim(), queue_id: queue === '' ? null : queue }, { onSuccess: onCreated, onError: (e2) => setError(friendlyError(e2, 'No pudimos crear la conexión.')) });
  };
  return (
    <Modal title="Conectar WhatsApp por QR" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3">
        <RiskNotice />
        <Field label="Nombre" required hint="Solo lo ves tú, por ejemplo «Chip de ventas».">{(f) => <Input {...f} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Departamento por defecto (opcional)" hint="A dónde van las conversaciones nuevas de este número.">
          {(f) => (
            <select {...f} className={selectCls} value={queue} onChange={(e) => setQueue(e.target.value)}>
              <option value="">Sin departamento</option>
              {(queues.data?.items ?? []).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          )}
        </Field>
        <label className="inline-flex items-start gap-2 text-[13.5px] font-semibold"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />Entiendo que es un canal no oficial y que WhatsApp podría bloquear el número.</label>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" loading={m.create.isPending}>Crear y mostrar el QR</Button></div>
      </form>
    </Modal>
  );
}

function QrCard({ c, queueName, onPair, onError }: { c: QrChannel; queueName: string | null; onPair: () => void; onError: (m: string | undefined) => void }) {
  const m = useQrMutations();
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null);
  const pill = QR_STATE[c.state];
  const down = c.state === 'logged_out' || c.state === 'closed';
  const fail = (fallback: string) => (e: unknown) => { setConfirm(null); onError(friendlyError(e, fallback)); };
  return (
    <li aria-label={c.name} className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold">{c.name}<span className="rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">No oficial</span></span>
          <span className="text-[13px] text-muted">WhatsApp por QR · {c.phone ?? 'sin teléfono vinculado'}{c.profile_name ? ` · ${c.profile_name}` : ''}</span>
        </div>
        <Pill kind={pill.kind}>{pill.label}</Pill>
      </div>
      {down ? <Alert>{c.last_error ?? 'La sesión de WhatsApp está caída.'}{c.down_since ? ` Desde ${shortDateTime(c.down_since)}.` : ''} Los mensajes que escribas esperan y salen cuando vuelvas a escanear el QR.</Alert> : null}
      <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
        <div className="flex gap-1.5"><dt className="text-muted">Departamento</dt><dd>{queueName ?? 'sin departamento'}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Último aviso</dt><dd>{c.last_event_at ? shortDateTime(c.last_event_at) : 'ninguno todavía'}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Calentamiento</dt><dd>Día {c.warmup.day}: hasta {c.warmup.daily_limit} mensajes al día</dd></div>
      </dl>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>{confirm === 'remove' ? `¿Borrar «${c.name}»? Se cierra la sesión y se borra la instancia; las conversaciones se conservan.` : `¿Cerrar la sesión de «${c.name}»? El teléfono queda desvinculado.`}</span>
          <Button variant="danger" className={SMALL} loading={m.remove.isPending || m.disconnect.isPending} onClick={() => { onError(undefined); (confirm === 'remove' ? m.remove : m.disconnect).mutate(c.id, { onSuccess: () => setConfirm(null), onError: fail('No pudimos completar la acción.') }); }}>Sí</Button>
          <Button className={SMALL} onClick={() => setConfirm(null)}>No</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button className={SMALL} variant={down || c.state === 'created' ? 'primary' : 'secondary'} aria-label={`${c.state === 'open' ? 'Ver' : 'Vincular'} ${c.name}`} onClick={onPair}>{c.state === 'open' ? 'Ver estado' : 'Vincular con QR'}</Button>
          {c.state === 'open' ? <Button className={SMALL} aria-label={`Cerrar sesión de ${c.name}`} onClick={() => setConfirm('disconnect')}>Cerrar sesión</Button> : null}
          <Button className={SMALL} aria-label={`Borrar ${c.name}`} onClick={() => setConfirm('remove')}>Borrar</Button>
        </div>
      )}
    </li>
  );
}

/** Configuración › Conexiones › «WhatsApp por QR» (M9.6, ADR-54/ADR-31): conexiones NO oficiales por QR, con su estado de sesión, calentamiento y aviso de riesgo. */
export function QrSection() {
  const q = useQrChannels();
  const queues = useQueues();
  const queueName = (id: string | null): string | null => (id ? (queues.data?.items.find((x) => x.id === id)?.name ?? null) : null);
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<QrChannel | null>(null);
  const [error, setError] = useState<string>();
  const items = q.data?.items ?? [];
  return (
    <section aria-label="WhatsApp por QR" className="grid gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-[18px] font-bold">WhatsApp por QR <span className="ml-1 rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">No oficial</span></h2>
          <p className="max-w-[680px] text-[13px] text-muted">Vincula un número escaneando un código QR, sin la API de Meta. Útil para números pequeños o de prueba; tiene riesgo de bloqueo y límites de envío.</p>
        </div>
        {q.isSuccess ? <Button disabled={!q.data.available || items.length >= q.data.limits.max_channels} onClick={() => setCreating(true)}>Conectar por QR</Button> : null}
      </div>
      {q.isPending ? <Spinner label="Cargando conexiones por QR" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar las conexiones.')}</Alert> : null}
      {q.isSuccess && !q.data.available ? <Alert kind="info">WhatsApp por QR no está disponible: el administrador de la plataforma debe configurar Evolution en Proveedores.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {q.isSuccess && q.data.available && items.length === 0 ? <p className="text-[13px] text-muted">Aún no hay conexiones por QR.</p> : null}
      {items.length > 0 ? <ul aria-label="Conexiones por QR" className="grid gap-3">{items.map((c) => <QrCard key={c.id} c={c} queueName={queueName(c.queue_id)} onPair={() => setPairing(c)} onError={setError} />)}</ul> : null}
      {creating ? <CreateDialog onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setPairing(c); }} /> : null}
      {pairing ? <PairDialog channel={pairing} onClose={() => setPairing(null)} /> : null}
    </section>
  );
}
