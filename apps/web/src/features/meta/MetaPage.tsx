import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useMetaEvents, useMetaSettings, useRetryMetaEvent, useSaveMeta, useTestMeta, type EventStatusFilter, type MetaEvent, type MetaSettings } from './useMeta';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
const STATUS: Record<MetaEvent['status'], { label: string; kind: PillKind }> = {
  pending: { label: 'Pendiente', kind: 'info' },
  sent: { label: 'Enviado', kind: 'ok' },
  skipped: { label: 'Omitido', kind: 'muted' },
  blocked: { label: 'Bloqueado', kind: 'warn' },
  failed: { label: 'Falló', kind: 'crit' },
  expired: { label: 'Vencido', kind: 'muted' },
  cancelled: { label: 'Cancelado', kind: 'muted' },
};
const TYPE_LABEL: Record<MetaEvent['type'], string> = { Lead: 'Lead', Schedule: 'Cita (Schedule)', Purchase: 'Compra (Purchase)', SaleCanceled: 'Venta cancelada' };
const GRACE_CHOICES = [0, 15, 30, 60, 120, 360, 720, 1440];
const graceLabel = (m: number): string => (m === 0 ? 'Al instante' : m < 60 ? `${m} minutos` : m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hora' : 'horas'}` : `${m} minutos`);

/** El motivo que dio Meta (viaja como detalle de la validación) o, si no hay, el aviso genérico. */
const metaReason = (e: unknown, fallback: string): string => (e instanceof ApiError && e.details[0]?.message ? e.details[0].message : friendlyError(e, fallback));

/** Conexión con la API de Conversiones: dataset, token (se guarda cifrado y nunca se muestra), ventana de gracia del Purchase y código de «Eventos de prueba». */
function ConnectionForm({ s }: { s: MetaSettings }) {
  const save = useSaveMeta();
  const test = useTestMeta();
  const [dataset, setDataset] = useState(s.dataset_id ?? '');
  const [token, setToken] = useState('');
  const [grace, setGrace] = useState(s.grace_minutes);
  const [code, setCode] = useState(s.test_event_code ?? '');
  const [enabled, setEnabled] = useState(s.configured ? s.enabled : true);
  const [errors, setErrors] = useState<Partial<Record<'dataset' | 'token' | 'code', string>>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const submit = (): void => {
    const e: typeof errors = {};
    if (!/^\d{5,30}$/.test(dataset.trim())) e.dataset = 'El identificador del dataset son solo dígitos';
    const changedDataset = s.configured && dataset.trim() !== s.dataset_id;
    if ((!s.configured || changedDataset) && token.trim() === '') e.token = changedDataset ? 'Al cambiar de dataset pega también su token' : 'Pega el token de acceso del dataset';
    else if (token.trim() !== '' && (token.trim().length < 20 || /\s/.test(token.trim()))) e.token = 'El token no parece válido (sin espacios, al menos 20 caracteres)';
    if (code.trim() !== '' && !/^[A-Za-z0-9_-]{1,40}$/.test(code.trim())) e.code = 'Solo letras, números, guion y guion bajo';
    setErrors(e);
    setError(undefined);
    setNotice(undefined);
    if (Object.keys(e).length > 0) return;
    save.mutate(
      { dataset_id: dataset.trim(), ...(token.trim() ? { access_token: token.trim() } : {}), grace_minutes: grace, test_event_code: code.trim() === '' ? null : code.trim(), enabled },
      { onSuccess: () => { setToken(''); setNotice(token.trim() ? 'Conexión guardada: Meta aceptó el token.' : 'Cambios guardados.'); }, onError: (err) => setError(metaReason(err, 'No se pudo guardar la conexión')) },
    );
  };

  return (
    <section aria-label="Conexión con Meta" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <b className="text-[15px]">API de Conversiones</b>
        <p className="text-[12.5px] text-muted">Envía a Meta los Lead, las citas y las compras de tus ventas para medir y optimizar tus anuncios. Usa el dataset (pixel) de tu Events Manager. El token se guarda cifrado y no se vuelve a mostrar.</p>
      </div>
      {!s.available ? <Alert>El servidor aún no puede conectarse con Meta (falta el cifrado de credenciales o el envío). Avisa a soporte.</Alert> : null}
      {s.configured && s.last_error ? <Alert>{s.last_error}. Corrige la conexión y reintenta los eventos bloqueados abajo.</Alert> : null}
      {s.configured ? <p className="text-[12.5px] text-muted">Token guardado: <span className="font-mono">••••{s.token_last4}</span>{s.last_check_at ? ` · última comprobación ${shortDateTime(s.last_check_at)}` : ''}</p> : null}

      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Identificador del dataset (pixel)" error={errors.dataset}>{(f) => <Input {...f} inputMode="numeric" value={dataset} onChange={(e) => setDataset(e.target.value)} placeholder="123456789012345" />}</Field>
        <Field label={s.configured ? 'Token de acceso (déjalo vacío para conservar el guardado)' : 'Token de acceso'} error={errors.token}>{(f) => <Input {...f} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Esperar antes de enviar la compra" hint="Si la venta se anula dentro de este tiempo, Meta nunca recibe la compra.">
          {(f) => (
            <select {...f} value={grace} onChange={(e) => setGrace(Number(e.target.value))} className={`${selectCls} w-full`}>
              {[...new Set([...GRACE_CHOICES, grace])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{graceLabel(m)}</option>)}
            </select>
          )}
        </Field>
        <Field label="Código de «Eventos de prueba» (opcional)" error={errors.code} hint="Mientras lo tengas puesto, Meta muestra los eventos en la pestaña de pruebas y no los cuenta. Quítalo para producción.">
          {(f) => <Input {...f} value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} placeholder="TEST12345" />}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13.5px]">
        <input type="checkbox" aria-label="Enviar eventos a Meta" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span><b>Enviar eventos a Meta</b><span className="block text-[12px] text-muted">Apagado: los eventos se acumulan como pendientes (Meta solo acepta los de los últimos 7 días).</span></span>
      </label>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {test.isSuccess ? <Alert kind="ok">Conexión correcta{test.data.dataset_name ? `: «${test.data.dataset_name}»` : ''}.</Alert> : null}
      {test.isError ? <Alert>{metaReason(test.error, 'No se pudo comprobar la conexión')}</Alert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {s.configured ? <Button loading={test.isPending} onClick={() => { setNotice(undefined); test.reset(); test.mutate(); }}>Probar conexión</Button> : null}
        <Button variant="primary" loading={save.isPending} disabled={!s.available} onClick={submit}>Guardar</Button>
      </div>
    </section>
  );
}

/** Panel de eventos enviados a Meta: estado de cada uno, el motivo si no salió y el reintento de los fallidos o bloqueados. */
function EventsPanel({ counts }: { counts: Record<string, number> }) {
  const [status, setStatus] = useState<EventStatusFilter>('');
  const [limit, setLimit] = useState(30);
  const q = useMetaEvents(status, limit);
  const retry = useRetryMetaEvent();
  const [error, setError] = useState<string>();
  const items = q.data?.items ?? [];
  const attention = (counts['failed'] ?? 0) + (counts['blocked'] ?? 0);
  return (
    <section aria-label="Eventos enviados a Meta" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-[15px]">Eventos enviados a Meta</b>
        <label className="flex items-center gap-2 text-[13px]">Estado
          <select value={status} onChange={(e) => { setStatus(e.target.value as EventStatusFilter); setLimit(30); }} className={selectCls}>
            <option value="">Todos</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
      </div>
      {attention > 0 ? <Alert>{attention} evento(s) fallido(s) o bloqueado(s): revisa el motivo y reintenta.</Alert> : null}
      {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando eventos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudieron cargar los eventos')}</Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-4 text-center text-[13px] text-muted">Todavía no hay eventos. Aparecen cuando alguien llega por un anuncio, agenda o compra.</p> : null}
      {items.length > 0 ? (
        <ul className="grid gap-2" aria-label="Eventos">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13px]">
              <span className="min-w-0">
                <b>{TYPE_LABEL[e.type]}</b> · {e.contact?.name ?? 'Contacto'} <span className="text-muted">· {shortDateTime(e.created_at)}</span>
                {e.last_error ? <span className="block text-[12px] text-crit">{e.last_error}</span> : null}
                {e.status === 'pending' ? <span className="block text-[12px] text-muted">Sale a partir de {shortDateTime(e.send_after)}{e.attempts > 0 ? ` · ${e.attempts} intento(s)` : ''}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <Pill kind={STATUS[e.status].kind}>{STATUS[e.status].label}</Pill>
                {e.can_retry ? <Button className={SMALL} aria-label={`Reintentar el evento de ${e.contact?.name ?? 'contacto'}`} loading={retry.isPending && retry.variables === e.id} onClick={() => { setError(undefined); retry.mutate(e.id, { onError: (err) => setError(friendlyError(err, 'No se pudo reintentar')) }); }}>Reintentar</Button> : null}
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

/** Configuración › Meta (M6.4, ADR-45/51): la conexión de la empresa con la API de Conversiones y el panel de eventos. Solo el administrador de la empresa. */
export function MetaPage() {
  const q = useMetaSettings();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.data ? <ConnectionForm s={q.data} /> : null}
      {q.data ? <EventsPanel counts={q.data.counts} /> : null}
    </div>
  );
}
