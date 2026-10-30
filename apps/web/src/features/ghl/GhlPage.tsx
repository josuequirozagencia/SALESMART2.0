import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useQueues } from '../queues/useQueues';
import { useDisconnectGhl, useGhlConnection, useGhlChannel, useGhlEvents, useGhlOutbox, useIssueGhlSecret, useRetryGhlOutbox, useSaveGhl, useSaveGhlChannel, useTestGhl, type GhlConnection, type GhlEvent, type GhlEventFilter, type GhlEventOutcome, type GhlEventStatus, type GhlReplyType, type GhlOutboxFilter, type GhlOutboxItem, type GhlOutboxStatus, type GhlStatus, type GhlWebhookIssued } from './useGhl';

const STATUS: Record<GhlStatus, { label: string; kind: PillKind }> = {
  active: { label: 'Conectada', kind: 'ok' },
  needs_reconnect: { label: 'Requiere reconexión', kind: 'crit' },
  disconnected: { label: 'Desconectada', kind: 'muted' },
};
const LOCATION = /^[A-Za-z0-9]{8,64}$/;
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
const EVENT_STATUS: Record<GhlEventStatus, { label: string; kind: PillKind }> = {
  pending: { label: 'Pendiente', kind: 'info' },
  done: { label: 'Procesado', kind: 'ok' },
  skipped: { label: 'Omitido', kind: 'muted' },
  failed: { label: 'Falló', kind: 'crit' },
};
const OUTBOX_STATUS: Record<GhlOutboxStatus, { label: string; kind: PillKind }> = {
  pending: { label: 'Pendiente', kind: 'info' },
  done: { label: 'Enviado', kind: 'ok' },
  skipped: { label: 'Omitido', kind: 'muted' },
  failed: { label: 'Falló', kind: 'crit' },
};
const REPLY_TYPES: ReadonlyArray<{ value: GhlReplyType; label: string }> = [
  { value: 'SMS', label: 'SMS' },
  { value: 'WhatsApp', label: 'WhatsApp (el de GoHighLevel)' },
  { value: 'IG', label: 'Instagram' },
  { value: 'FB', label: 'Facebook' },
  { value: 'Live_Chat', label: 'Chat en vivo' },
];
const OP_LABEL: Record<GhlOutboxItem['op'], string> = { tag_add: 'Agregar', tag_remove: 'Quitar', tag_delete: 'Eliminar en GoHighLevel' };
const OUTCOME: Record<GhlEventOutcome, string> = { contact_created: 'Contacto creado', contact_linked: 'Vinculado a un contacto existente', contact_updated: 'Contacto completado', contact_unchanged: 'Sin cambios', message_received: 'Mensaje recibido' };
const TYPE_LABEL: Record<GhlEvent['type'], string> = { contact: 'Contacto', message_in: 'Mensaje entrante' };
const MESSAGE_EXAMPLE = `{
  "event": "message_in",
  "contact_id": "{{contact.id}}",
  "full_name": "{{contact.name}}",
  "phone": "{{contact.phone}}",
  "message": "{{message.body}}",
  "message_type": "SMS",
  "message_id": "{{message.id}}"
}`;
const EXAMPLE = `{
  "contact_id": "{{contact.id}}",
  "full_name": "{{contact.name}}",
  "phone": "{{contact.phone}}",
  "email": "{{contact.email}}"
}`;

/** El motivo que dio GoHighLevel (viaja como detalle de la validación) o, si no hay, el aviso genérico. */
const ghlReason = (e: unknown, fallback: string): string => (e instanceof ApiError && e.details[0]?.message ? e.details[0].message : friendlyError(e, fallback));

/** Conexión: Location y token de la integración privada (se guarda cifrado y nunca se vuelve a mostrar). */
function ConnectionForm({ s }: { s: GhlConnection }) {
  const save = useSaveGhl();
  const test = useTestGhl();
  const disconnect = useDisconnectGhl();
  const [location, setLocation] = useState(s.location_id ?? '');
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'location' | 'token', string>>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  // Sin un token guardado que sirva, o con otra Location, hay que pegar el token
  const tokenRequired = s.status !== 'active' || location.trim() !== s.location_id;

  const submit = (): void => {
    const e: typeof errors = {};
    if (!LOCATION.test(location.trim())) e.location = 'El Location ID son solo letras y números (de 8 a 64)';
    if (tokenRequired && token.trim().length < 20) e.token = s.status === 'needs_reconnect' ? 'El token guardado ya no sirve: pega uno nuevo' : 'Pega el token de la integración privada';
    setErrors(e);
    setError(undefined);
    setNotice(undefined);
    if (Object.keys(e).length > 0) return;
    save.mutate(
      { location_id: location.trim(), ...(token.trim() ? { access_token: token.trim() } : {}) },
      { onSuccess: () => { setToken(''); setNotice(token.trim() ? 'Conexión guardada: GoHighLevel aceptó el token.' : 'Cambios guardados.'); }, onError: (err) => setError(ghlReason(err, 'No se pudo guardar la conexión')) },
    );
  };

  const st = s.status ? STATUS[s.status] : null;
  return (
    <section aria-label="Conexión con GoHighLevel" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <b className="text-[15px]">Conexión con GoHighLevel</b>
          <p className="max-w-[680px] text-[12.5px] text-muted">Crea una integración privada en tu subcuenta (Configuración › Integraciones privadas) con permisos de contactos, conversaciones y workflows, y pega aquí su token y el Location ID. El token se guarda cifrado y no se vuelve a mostrar.</p>
        </div>
        {st ? <Pill kind={st.kind}>{st.label}</Pill> : null}
      </div>
      {!s.available ? <Alert>El servidor aún no puede conectarse con GoHighLevel (falta el cifrado de credenciales o el adaptador). Avisa a soporte.</Alert> : null}
      {s.status === 'needs_reconnect' ? <Alert>GoHighLevel rechazó el token{s.last_error ? `: ${s.last_error}` : ''}. Pega uno nuevo para reconectar; mientras tanto no se envía nada a GoHighLevel.</Alert> : null}
      {s.status === 'active' && s.last_error ? <Alert kind="info">{s.last_error}</Alert> : null}
      {s.status === 'disconnected' ? <p className="text-[13px] text-muted">Desconectada: el token fue borrado. Pega uno para volver a conectar.</p> : null}
      {s.configured && s.status !== 'disconnected' ? <p className="text-[12.5px] text-muted">Token guardado: <span className="font-mono">••••{s.token_last4}</span>{s.last_check_at ? ` · última comprobación ${shortDateTime(s.last_check_at)}` : ''}</p> : null}

      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Location ID" error={errors.location} hint="Lo ves en la dirección de tu subcuenta, o en Configuración › Perfil de la empresa.">{(f) => <Input {...f} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="ve9EPM428h8vShlRW1KT" />}</Field>
        <Field label={tokenRequired ? 'Token de la integración privada' : 'Token (déjalo vacío para conservar el guardado)'} error={errors.token}>{(f) => <Input {...f} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {test.isSuccess ? <Alert kind="ok">Conexión correcta{test.data.location_name ? `: «${test.data.location_name}»` : ''}.</Alert> : null}
      {test.isError ? <Alert>{ghlReason(test.error, 'No se pudo comprobar la conexión')}</Alert> : null}
      {disconnect.isError ? <Alert>{friendlyError(disconnect.error, 'No se pudo desconectar')}</Alert> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {s.configured && s.status !== 'disconnected' ? (
          confirm ? (
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              ¿Desconectar y borrar el token?
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={disconnect.isPending} onClick={() => disconnect.mutate(undefined, { onSettled: () => setConfirm(false) })}>Sí, desconectar</Button>
              <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
            </span>
          ) : <Button onClick={() => setConfirm(true)}>Desconectar</Button>
        ) : null}
        {s.configured && s.status !== 'disconnected' ? <Button loading={test.isPending} onClick={() => { setNotice(undefined); test.reset(); test.mutate(); }}>Probar conexión</Button> : null}
        <Button variant="primary" loading={save.isPending} disabled={!s.available} onClick={submit}>{s.status === 'needs_reconnect' || s.status === 'disconnected' ? 'Reconectar' : 'Guardar'}</Button>
      </div>
    </section>
  );
}

/** Punto de entrada del Workflow de GoHighLevel: la URL se ve siempre; el secreto solo al generarlo o rotarlo. */
function WebhookSection({ s }: { s: GhlConnection }) {
  const issue = useIssueGhlSecret();
  const [issued, setIssued] = useState<GhlWebhookIssued>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const full = (path: string): string => `${window.location.origin}${path}`;
  const generate = (): void => {
    setError(undefined);
    issue.mutate(undefined, { onSuccess: (r) => { setIssued(r); setConfirm(false); }, onError: (e) => { setConfirm(false); setError(friendlyError(e, 'No pudimos generar el punto de entrada.')); } });
  };

  if (issued) {
    return (
      <section aria-label="Datos del punto de entrada" className="grid gap-3 rounded-2xl border border-accent bg-accent-soft p-4">
        <Alert kind="info">Guarda el secreto ahora: <b>no se volverá a mostrar</b>. Si lo pierdes, genera uno nuevo (el anterior dejará de funcionar).</Alert>
        <CopyField label="URL del punto de entrada" value={full(issued.path)} />
        <CopyField label="Secreto" value={issued.secret} />
        <div><Button variant="primary" onClick={() => setIssued(undefined)}>Ya lo guardé</Button></div>
      </section>
    );
  }
  const hook = s.webhook;
  return (
    <section aria-label="Punto de entrada del Workflow" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <b className="text-[15px]">Punto de entrada para tus Workflows</b>
        <p className="max-w-[680px] text-[12.5px] text-muted">GoHighLevel avisa a Sales Smart desde una acción «Webhook» de un Workflow: es un paso manual por cada flujo (con un token privado GoHighLevel no crea suscripciones solo).</p>
      </div>
      {hook.configured && hook.path ? (
        <>
          <p className="text-[13.5px]"><b>Punto de entrada activo.</b> Creado el {shortDateTime(hook.created_at!)}{hook.rotated_at ? <>; secreto regenerado el {shortDateTime(hook.rotated_at)}</> : null}. {hook.last_used_at ? <>Último aviso recibido el {shortDateTime(hook.last_used_at)}.</> : 'Aún no ha recibido ningún aviso.'}</p>
          <CopyField label="URL del punto de entrada" value={full(hook.path)} />
          {confirm ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span>¿Regenerar el secreto? El actual dejará de funcionar y tendrás que actualizarlo en tus Workflows.</span>
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={issue.isPending} onClick={generate}>Sí, regenerar</Button>
              <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
            </div>
          ) : <div><Button onClick={() => setConfirm(true)}>Regenerar secreto</Button></div>}
        </>
      ) : (
        <>
          <p className="text-[13.5px]">Aún no hay un punto de entrada. Genera uno para conectar tus Workflows.</p>
          <div><Button variant="primary" loading={issue.isPending} onClick={generate}>Generar punto de entrada</Button></div>
        </>
      )}
      {error ? <Alert>{error}</Alert> : null}
      <p className="text-[12.5px] text-muted">Pega la URL en la acción «Webhook» (método POST) y agrega la cabecera <code className="rounded bg-surface2 px-1">X-Webhook-Secret</code> con el secreto. Los datos que Sales Smart usa se describen abajo.</p>
    </section>
  );
}

/** El canal «GoHighLevel» del Inbox: a qué cola van las conversaciones nuevas y por qué canal de GHL se responde cuando el aviso no lo dice. */
function ChannelSection() {
  const ch = useGhlChannel(true);
  const queues = useQueues();
  const save = useSaveGhlChannel();
  const [queue, setQueue] = useState<string | null>(null);
  const [type, setType] = useState<GhlReplyType | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const data = ch.data;
  // Los valores del formulario parten de lo guardado y se vuelven a leer solo cuando cambia lo guardado
  const savedQueue = data?.queue?.id ?? null;
  const savedType = data?.default_type ?? null;
  const [seen, setSeen] = useState<string>('');
  const key = `${savedQueue ?? ''}|${savedType ?? ''}`;
  if (data && seen !== key) {
    setSeen(key);
    setQueue(savedQueue);
    setType(savedType);
  }
  if (!data?.configured) return null;
  const submit = (): void => {
    setError(undefined);
    setNotice(undefined);
    save.mutate({ queue_id: queue, default_type: type }, { onSuccess: () => setNotice('Cambios guardados.'), onError: (e) => setError(friendlyError(e, 'No se pudo guardar')) });
  };
  return (
    <section aria-label="Canal de mensajes" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <b className="text-[15px]">Mensajes de GoHighLevel en el Inbox</b>
        <p className="max-w-[680px] text-[12.5px] text-muted">Los mensajes que lleguen por tus Workflows aparecen en el Inbox como el canal «GoHighLevel», con el mismo reparto, horarios y permisos que WhatsApp. Por ahora solo texto.</p>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Departamento de las conversaciones nuevas" hint="Sin departamento, las conversaciones quedan «sin asignar» hasta que alguien las tome.">
          {(f) => (
            <select {...f} value={queue ?? ''} onChange={(e) => setQueue(e.target.value === '' ? null : e.target.value)} className={`${selectCls} w-full`}>
              <option value="">Sin departamento</option>
              {(queues.data?.items ?? []).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Responder por, si el aviso no dice el canal" hint="Normalmente se responde por el mismo canal por el que escribió el cliente.">
          {(f) => (
            <select {...f} value={type ?? ''} onChange={(e) => setType(e.target.value === '' ? null : (e.target.value as GhlReplyType))} className={`${selectCls} w-full`}>
              <option value="">Ninguno (avisar que falta)</option>
              {REPLY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          )}
        </Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={submit}>Guardar canal</Button></div>
    </section>
  );
}

/** Cómo armar la acción «Webhook» del Workflow de GoHighLevel. */
function HowTo() {
  return (
    <section aria-label="Cómo conectarlo" className="grid gap-2 rounded-2xl border border-line bg-surface p-4 text-[13.5px]">
      <h2 className="text-[15px] font-bold">Cómo conectarlo en GoHighLevel</h2>
      <ol className="grid list-decimal gap-1 pl-5">
        <li>En el Workflow que quieras (por ejemplo, cuando se crea o cambia un contacto), agrega la acción «Webhook» con método POST.</li>
        <li>Pega la URL del punto de entrada y agrega la cabecera <code className="rounded bg-surface2 px-1">X-Webhook-Secret</code> con el secreto.</li>
        <li>En «Custom Data» (o en el cuerpo) envía estos campos; los que falten se ignoran y el resto de lo que mande GoHighLevel no se guarda:</li>
      </ol>
      <pre className="overflow-x-auto rounded-xl bg-surface2 p-3 text-[12.5px]">{EXAMPLE}</pre>
      <p className="text-muted">Obligatorio solo <code className="rounded bg-surface2 px-1">contact_id</code>. Para crear un contacto nuevo hace falta el teléfono en formato internacional (+593…); si el teléfono ya existe, se vincula sin tocar el nombre ni el responsable, y solo se completa el correo si estaba vacío. Opcional: <code className="rounded bg-surface2 px-1">event_id</code> (evita procesar dos veces el mismo aviso) y <code className="rounded bg-surface2 px-1">location.id</code> (debe ser la Location conectada). <b>Etiquetas:</b> si el cuerpo trae <code className="rounded bg-surface2 px-1">tags</code> (la lista completa de etiquetas del contacto en GoHighLevel), Sales Smart agrega y quita las que existen aquí con el mismo nombre (sin distinguir mayúsculas); las del sistema (Lead, Cita agendada y Venta) nunca se tocan. Las etiquetas que pones o quitas aquí también se envían a GoHighLevel, y si borras una etiqueta aquí se elimina también en GoHighLevel (la integración necesita el permiso de leer y escribir etiquetas de la Location, además del de contactos). </p>
      <p className="text-[12.5px] text-muted"><b>Mensajes:</b> para que lo que escribe el cliente llegue a la bandeja, crea otro Workflow con el disparador «Customer Replied» (o el que uses) y la misma acción «Webhook», con este cuerpo (ajusta <code className="rounded bg-surface2 px-1">message_type</code> al canal: SMS, WhatsApp, Instagram, Facebook o Live Chat). Las respuestas salen por el mismo canal por el que escribió el cliente.</p>
      <pre className="overflow-x-auto rounded-xl bg-surface2 p-3 text-[12.5px]">{MESSAGE_EXAMPLE}</pre>
    </section>
  );
}

/** Avisos que llegaron del Workflow: su estado, qué se hizo y por qué se omitieron. Se actualiza solo. */
function EventsPanel() {
  const [status, setStatus] = useState<GhlEventFilter>('');
  const [limit, setLimit] = useState(30);
  const q = useGhlEvents(status, limit);
  const items = q.data?.items ?? [];
  return (
    <section aria-label="Avisos recibidos" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-[15px]">Avisos recibidos</b>
        <label className="flex items-center gap-2 text-[13px]">Estado
          <select value={status} onChange={(e) => { setStatus(e.target.value as GhlEventFilter); setLimit(30); }} className={selectCls}>
            <option value="">Todos</option>
            {Object.entries(EVENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>
      {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando avisos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudieron cargar los avisos')}</Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-4 text-center text-[13px] text-muted">Todavía no ha llegado ningún aviso. Aparecen cuando un Workflow de GoHighLevel llama al punto de entrada.</p> : null}
      {items.length > 0 ? (
        <ul className="grid gap-2" aria-label="Avisos">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13px]">
              <span className="min-w-0">
                <b>{TYPE_LABEL[e.type]}</b> · {e.contact?.name ?? <span className="font-mono text-[12px]">{e.ghl_contact_id}</span>} <span className="text-muted">· {shortDateTime(e.received_at)}</span>
                {e.outcome ? <span className="block text-[12px] text-muted">{OUTCOME[e.outcome]}</span> : null}
                {e.note ? <span className="block text-[12px] text-muted">{e.note}</span> : null}
                {e.status === 'pending' && e.attempts > 0 ? <span className="block text-[12px] text-muted">{e.attempts} intento(s); se reintenta solo</span> : null}
                {e.status === 'failed' ? <span className="block text-[12px] text-crit">No se pudo procesar tras {e.attempts} intentos{e.last_error ? ` (${e.last_error})` : ''}</span> : null}
              </span>
              <Pill kind={EVENT_STATUS[e.status].kind}>{EVENT_STATUS[e.status].label}</Pill>
            </li>
          ))}
        </ul>
      ) : null}
      {q.data?.next_cursor ? <div className="grid place-items-center"><Button className={SMALL} onClick={() => setLimit(Math.min(limit + 30, 50))} disabled={limit >= 50}>Ver más</Button></div> : null}
    </section>
  );
}

/** Etiquetas que se pusieron o quitaron aquí y que GoHighLevel debe reflejar: estado de cada envío y reintento de los que fallaron. */
function OutboxPanel() {
  const [status, setStatus] = useState<GhlOutboxFilter>('');
  const [limit, setLimit] = useState(30);
  const q = useGhlOutbox(status, limit);
  const retry = useRetryGhlOutbox();
  const [error, setError] = useState<string>();
  const items: GhlOutboxItem[] = q.data?.items ?? [];
  const failed = q.data?.counts['failed'] ?? 0;
  return (
    <section aria-label="Etiquetas enviadas a GoHighLevel" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-[15px]">Etiquetas enviadas a GoHighLevel</b>
        <label className="flex items-center gap-2 text-[13px]">Estado
          <select value={status} onChange={(e) => { setStatus(e.target.value as GhlOutboxFilter); setLimit(30); }} className={selectCls}>
            <option value="">Todos</option>
            {Object.entries(OUTBOX_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>
      {failed > 0 ? <Alert>{failed} cambio(s) de etiqueta no se pudieron enviar: revisa el motivo y reintenta.</Alert> : null}
      {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando etiquetas enviadas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudieron cargar las etiquetas enviadas')}</Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-4 text-center text-[13px] text-muted">Todavía no se ha enviado ninguna etiqueta. Aparecen cuando pones o quitas una etiqueta a un contacto.</p> : null}
      {items.length > 0 ? (
        <ul className="grid gap-2" aria-label="Etiquetas enviadas">
          {items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13px]">
              <span className="min-w-0">
                <b>{OP_LABEL[o.op]} «{o.tag}»</b>{o.op === 'tag_delete' ? null : <> · {o.contact?.name ?? 'Contacto'}</>} <span className="text-muted">· {shortDateTime(o.created_at)}</span>
                {o.note ? <span className="block text-[12px] text-muted">{o.note}</span> : null}
                {o.status === 'pending' && o.attempts > 0 ? <span className="block text-[12px] text-muted">{o.attempts} intento(s); se reintenta solo</span> : null}
                {o.status === 'failed' && o.last_error ? <span className="block text-[12px] text-crit">{o.last_error}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <Pill kind={OUTBOX_STATUS[o.status].kind}>{OUTBOX_STATUS[o.status].label}</Pill>
                {o.can_retry ? <Button className={SMALL} aria-label={`Reintentar ${OP_LABEL[o.op].toLowerCase()} «${o.tag}»`} loading={retry.isPending && retry.variables === o.id} onClick={() => { setError(undefined); retry.mutate(o.id, { onError: (err) => setError(friendlyError(err, 'No se pudo reintentar')) }); }}>Reintentar</Button> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {q.data?.next_cursor ? <div className="grid place-items-center"><Button className={SMALL} onClick={() => setLimit(Math.min(limit + 30, 50))} disabled={limit >= 50}>Ver más</Button></div> : null}
    </section>
  );
}

/** Configuración › GoHighLevel (M7.1, ADR-52/ADR-05): la conexión de la empresa con su subcuenta. Solo el administrador de la empresa. */
export function GhlPage() {
  const q = useGhlConnection();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.data ? <ConnectionForm s={q.data} /> : null}
      {q.data ? <WebhookSection s={q.data} /> : null}
      {q.data?.configured && q.data.status !== 'disconnected' ? <ChannelSection /> : null}
      {q.data ? <HowTo /> : null}
      {q.data?.webhook.configured ? <EventsPanel /> : null}
      {q.data?.configured && q.data.status !== 'disconnected' ? <OutboxPanel /> : null}
    </div>
  );
}
