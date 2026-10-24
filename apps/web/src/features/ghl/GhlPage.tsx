import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useDisconnectGhl, useGhlConnection, useIssueGhlSecret, useSaveGhl, useTestGhl, type GhlConnection, type GhlStatus, type GhlWebhookIssued } from './useGhl';

const STATUS: Record<GhlStatus, { label: string; kind: PillKind }> = {
  active: { label: 'Conectada', kind: 'ok' },
  needs_reconnect: { label: 'Requiere reconexión', kind: 'crit' },
  disconnected: { label: 'Desconectada', kind: 'muted' },
};
const LOCATION = /^[A-Za-z0-9]{8,64}$/;

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
      <p className="text-[12.5px] text-muted">Pega la URL en la acción «Webhook» (método POST) y agrega la cabecera <code className="rounded bg-surface2 px-1">X-Webhook-Secret</code> con el secreto. Los avisos que entiende Sales Smart llegan en las siguientes versiones: por ahora solo queda lista la conexión.</p>
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
    </div>
  );
}
