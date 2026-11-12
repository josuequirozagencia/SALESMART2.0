import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Field, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { OUTCOMES, useCalendarChoices, useCalendarConnection, useCalendarMutations, type CalendarConnection, type CalendarMode, type CalendarOutcome, type CalendarStatus, type CalendarUnavailable } from './useCalendar';

const STATUS: Record<CalendarStatus, { label: string; kind: PillKind }> = {
  connected: { label: 'Conectado', kind: 'ok' },
  pending_calendar: { label: 'Falta elegir el calendario', kind: 'warn' },
  needs_reconnect: { label: 'Requiere reconexión', kind: 'crit' },
  disconnected: { label: 'Desconectado', kind: 'muted' },
};
const UNAVAILABLE: Record<CalendarUnavailable, string> = {
  provider: 'el servidor no tiene activado el calendario',
  encryption: 'el servidor no tiene configurado el cifrado de credenciales',
  base_url: 'el servidor no tiene configurada su dirección pública',
  platform_credentials: 'la plataforma todavía no tiene cargada la aplicación de Google (Plataforma › Proveedores › Calendario)',
};
const OUTCOME_TEXT: Record<CalendarOutcome, { kind: 'ok' | 'error' | 'info'; text: string }> = {
  connected: { kind: 'ok', text: 'Google Calendar quedó conectado. Se creó un calendario nuevo solo para Sales Smart.' },
  pick: { kind: 'info', text: 'Autorizaste el acceso. Falta elegir el calendario donde se guardarán las citas.' },
  denied: { kind: 'error', text: 'No se conectó: cancelaste la autorización en Google o Google la rechazó. Puedes intentarlo de nuevo.' },
  invalid: { kind: 'error', text: 'El enlace de regreso de Google venció o no es válido. Empieza la conexión otra vez.' },
  scopes: { kind: 'error', text: 'No se conectó: en la pantalla de Google desmarcaste algún permiso. Hacen falta todos para poder crear las citas.' },
  unavailable: { kind: 'error', text: 'Por ahora no se puede conectar Google Calendar. Avisa a soporte.' },
  api: { kind: 'error', text: 'No se conectó: la API de Google Calendar no está habilitada en el proyecto de Google Cloud de la plataforma. Avisa a soporte; no es algo que debas cambiar tú.' },
  error: { kind: 'error', text: 'Google no respondió bien y no se conectó nada. Inténtalo de nuevo en unos minutos.' },
};

const MODES: ReadonlyArray<{ mode: CalendarMode; title: string; body: string; badge?: string }> = [
  { mode: 'own', title: 'Un calendario nuevo de Sales Smart', badge: 'Recomendado', body: 'Creamos un calendario aparte en tu cuenta de Google, solo para las citas. No vemos ni tocamos tus otros calendarios: es el permiso más pequeño que pide Google.' },
  { mode: 'existing', title: 'Usar un calendario que ya tengo', body: 'Eliges uno de tus calendarios. Para eso Google nos da permiso de ver y editar eventos de TODOS los calendarios de la cuenta.' },
];

function Status({ c }: { c: CalendarConnection }) {
  const s = c.status ? STATUS[c.status] : STATUS.disconnected;
  return (
    <section aria-label="Estado de la conexión" className="grid gap-2 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">Google Calendar</h2>
        <Pill kind={s.kind}>{s.label}</Pill>
      </div>
      <dl className="grid gap-1 text-[13.5px] sm:grid-cols-[180px_1fr]">
        <dt className="text-muted">Cuenta de Google</dt><dd>{c.account ?? '—'}</dd>
        <dt className="text-muted">Calendario</dt><dd>{c.calendar_name ?? '—'}</dd>
        <dt className="text-muted">Modo</dt><dd>{c.mode === 'own' ? 'Calendario propio de Sales Smart' : c.mode === 'existing' ? 'Un calendario que ya tenías' : '—'}</dd>
        <dt className="text-muted">Conectado desde</dt><dd>{c.connected_at ? shortDateTime(c.connected_at) : '—'}</dd>
      </dl>
      {c.last_error ? <Alert>{c.last_error}</Alert> : null}
    </section>
  );
}

/** Cómo van las citas hacia Google: cuántas ya están, cuántas esperan y cuántas fallaron (con «Reintentar»). */
function SyncStatus({ c }: { c: CalendarConnection }) {
  const m = useCalendarMutations();
  const [error, setError] = useState<string>();
  const s = c.sync;
  if (!s || c.status !== 'connected') return null;
  const retry = (): void => {
    setError(undefined);
    m.retry.mutate(undefined, { onError: (e) => setError(friendlyError(e, 'No pudimos volver a intentarlo.')) });
  };
  return (
    <section aria-label="Sincronización de citas" className="grid gap-2 rounded-xl border border-line p-4">
      <h2 className="text-[15px] font-bold">Citas en Google Calendar</h2>
      <p className="text-[13.5px]">
        {s.synced} {s.synced === 1 ? 'cita sincronizada' : 'citas sincronizadas'}
        {s.pending > 0 ? ` · ${s.pending} en espera` : ''}
        {s.failed > 0 ? ` · ${s.failed} con error` : ''}
        {s.gone > 0 ? ` · ${s.gone} borrada${s.gone === 1 ? '' : 's'} en Google` : ''}
      </p>
      <p className="text-[12px] text-muted">{s.last_synced_at ? `Última sincronización: ${shortDateTime(s.last_synced_at)}.` : 'Todavía no se ha sincronizado ninguna cita.'} Solo se envían las citas que agendes o cambies después de conectar; si borras un evento en Google, no se vuelve a crear.</p>
      {s.failed > 0 ? (
        <>
          <Alert>No pudimos enviar {s.failed === 1 ? 'una cita' : `${s.failed} citas`} a Google. Revisa que la conexión esté bien y vuelve a intentarlo.</Alert>
          {error ? <Alert>{error}</Alert> : null}
          <div><Button loading={m.retry.isPending} onClick={retry}>Reintentar</Button></div>
        </>
      ) : null}
    </section>
  );
}

function Picker() {
  const choices = useCalendarChoices(true);
  const m = useCalendarMutations();
  const [id, setId] = useState('');
  const [error, setError] = useState<string>();
  if (choices.isLoading) return <Spinner label="Cargando tus calendarios" />;
  if (choices.isError) return <Alert>{friendlyError(choices.error, 'No pudimos leer tus calendarios de Google.')}</Alert>;
  const items = choices.data?.items ?? [];
  if (items.length === 0) return <Alert kind="info">Tu cuenta de Google no tiene calendarios donde se pueda escribir. Crea uno en Google Calendar y vuelve a conectar.</Alert>;
  const submit = (): void => {
    setError(undefined);
    m.choose.mutate(id, { onError: (e) => setError(friendlyError(e, 'No pudimos guardar el calendario.')) });
  };
  return (
    <section aria-label="Elegir calendario" className="grid max-w-[520px] gap-3">
      <Field label="¿En qué calendario se guardarán las citas?">
        {(f) => (
          <select {...f} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Elige uno…</option>
            {items.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (principal)' : ''}</option>)}
          </select>
        )}
      </Field>
      {error ? <Alert>{error}</Alert> : null}
      <div><Button variant="primary" disabled={id === ''} loading={m.choose.isPending} onClick={submit}>Usar este calendario</Button></div>
    </section>
  );
}

function Connect({ c, reconnect }: { c: CalendarConnection; reconnect: boolean }) {
  const m = useCalendarMutations();
  const [mode, setMode] = useState<CalendarMode>(c.mode ?? 'own');
  const [error, setError] = useState<string>();
  const go = (): void => {
    setError(undefined);
    m.start.mutate(mode, {
      onSuccess: (r) => window.location.assign(r.url),
      onError: (e) => setError(friendlyError(e, 'No pudimos iniciar la conexión con Google.')),
    });
  };
  return (
    <section aria-label="Conectar" className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[13.5px] font-bold">{reconnect ? 'Vuelve a conectar tu cuenta' : '¿Cómo quieres usar tu calendario?'}</legend>
        {MODES.map((o) => (
          <label key={o.mode} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${mode === o.mode ? 'border-accent bg-accent-soft' : 'border-line'}`}>
            <input type="radio" name="calendar-mode" className="mt-1" checked={mode === o.mode} onChange={() => setMode(o.mode)} />
            <span className="grid gap-0.5 text-[13.5px]">
              <span className="font-semibold">{o.title}{o.badge ? <span className="ml-2"><Pill kind="accent">{o.badge}</Pill></span> : null}</span>
              <span className="text-[12.5px] text-muted">{o.body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error ? <Alert>{error}</Alert> : null}
      <div><Button variant="primary" loading={m.start.isPending} onClick={go}>{reconnect ? 'Volver a conectar con Google' : 'Conectar con Google'}</Button></div>
      <p className="text-[12px] text-muted">Te llevamos a Google para que autorices. Esta conexión solo envía tus citas de Sales Smart hacia Google: no leemos tus eventos.</p>
    </section>
  );
}

/** Configuración › Google Calendar (v11 Pista G, ADR-67): conectar la cuenta de la empresa, elegir el calendario y desconectar. */
export function CalendarPage() {
  const q = useCalendarConnection();
  const m = useCalendarMutations();
  const [params, setParams] = useSearchParams();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const raw = params.get('calendar');
  const outcome = OUTCOMES.find((o) => o === raw) ?? null;
  const c = q.data;
  const dismiss = (): void => { const next = new URLSearchParams(params); next.delete('calendar'); setParams(next, { replace: true }); };
  const status = c?.status ?? 'disconnected';
  return (
    <div className="grid gap-5">
      <SettingsNav />
      <p className="max-w-[680px] text-[13.5px] text-muted">
        Cada cita que agendes en Sales Smart aparecerá como un evento en tu calendario de Google, y si la mueves o la cancelas aquí, el evento se actualiza o se borra. Solo va de Sales Smart hacia Google; si cambias un evento allá, no cambia aquí. Un administrador conecta una sola cuenta para toda la empresa.
      </p>
      {outcome ? (
        <div className="grid gap-2">
          <Alert kind={OUTCOME_TEXT[outcome].kind}>{OUTCOME_TEXT[outcome].text}</Alert>
          <div><Button className="!px-3 !py-1 !text-[12px]" onClick={dismiss}>Entendido</Button></div>
        </div>
      ) : null}
      {q.isLoading ? <Spinner label="Cargando Google Calendar" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar la conexión con Google Calendar.')}</Alert> : null}
      {c ? (
        <>
          <Status c={c} />
          {!c.available ? <Alert kind="info">Por ahora no se puede conectar: {c.unavailable_reason ? UNAVAILABLE[c.unavailable_reason] : 'falta configuración del servidor'}. Avisa a soporte.</Alert> : null}
          <SyncStatus c={c} />
          {c.available && status === 'pending_calendar' ? <Picker /> : null}
          {c.available && (status === 'disconnected' || status === 'needs_reconnect') ? <Connect c={c} reconnect={status === 'needs_reconnect'} /> : null}
          {c.configured || status === 'needs_reconnect' ? (
            <section aria-label="Desconectar" className="grid gap-2 border-t border-line pt-4">
              <h2 className="text-[13.5px] font-bold">Desconectar</h2>
              <p className="max-w-[680px] text-[12.5px] text-muted">Revocamos el permiso en Google y borramos la autorización guardada. Los eventos que ya se crearon se quedan en tu calendario de Google.</p>
              {error ? <Alert>{error}</Alert> : null}
              {confirm ? (
                <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  ¿Desconectar Google Calendar?
                  <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={m.disconnect.isPending} onClick={() => m.disconnect.mutate(undefined, { onSuccess: () => setConfirm(false), onError: (e) => { setConfirm(false); setError(friendlyError(e, 'No pudimos desconectar.')); } })}>Sí, desconectar</Button>
                  <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
                </span>
              ) : (
                <div><Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Desconectar</Button></div>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
