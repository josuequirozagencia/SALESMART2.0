import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Holiday, SlaSettings, WeekHours } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { cloneWeek, defaultWeek, holidayDate, summarizeWeek, validateWeek } from './hours';
import { HoursEditor } from './HoursEditor';
import { useAddHoliday, useRemoveHoliday, useSaveHours, useSavePolicy, useSlaSettings } from './useSla';

type Msg = { kind: 'ok' | 'error'; text: string } | undefined;
const intIn = (v: string, min: number, max: number): number | null => (/^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
const card = 'grid gap-3 rounded-2xl border border-line p-4';

function Result({ msg }: { msg: Msg }) {
  return msg ? <Alert kind={msg.kind === 'ok' ? 'ok' : 'error'}>{msg.text}</Alert> : null;
}

function PolicyCard({ s }: { s: SlaSettings }) {
  const [target, setTarget] = useState(String(s.policy.target_minutes));
  const [risk, setRisk] = useState(String(s.policy.risk_minutes));
  const [errors, setErrors] = useState<{ target?: string; risk?: string }>({});
  const [msg, setMsg] = useState<Msg>();
  const save = useSavePolicy();

  function submit() {
    setMsg(undefined);
    const t = intIn(target, 1, 1440);
    const r = intIn(risk, 0, 1440);
    const next: typeof errors = {};
    if (t === null) next.target = 'Un número entero de minutos entre 1 y 1440';
    if (r === null) next.risk = 'Un número entero de minutos entre 0 y 1440';
    else if (t !== null && r > t) next.risk = 'El aviso no puede ser mayor que el objetivo';
    setErrors(next);
    if (t === null || r === null || Object.keys(next).length > 0) return;
    save.mutate({ target_minutes: t, risk_minutes: r }, { onSuccess: () => setMsg({ kind: 'ok', text: 'Objetivo de respuesta guardado.' }), onError: (e) => setMsg({ kind: 'error', text: friendlyError(e, 'No pudimos guardar el objetivo.') }) });
  }

  return (
    <section aria-label="Objetivo de respuesta" className={card}>
      <div>
        <h2 className="text-[15px] font-bold">Objetivo de respuesta</h2>
        <p className="text-[12.5px] text-muted">Cuánto tiempo de horario abierto tiene quien recibe una conversación para escribirle al cliente. Cuenta desde que se la asignan (o desde que el cliente vuelve a escribir) y se detiene con el primer mensaje de una persona; una nota interna no cuenta.</p>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Responder en (minutos)" error={errors.target} hint="Por omisión 15 minutos.">{(p) => <Input {...p} inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
        <Field label="Avisar «en riesgo» cuando falten (minutos)" error={errors.risk} hint="Por omisión 3 minutos antes de vencer.">{(p) => <Input {...p} inputMode="numeric" value={risk} onChange={(e) => setRisk(e.target.value)} />}</Field>
      </div>
      <Result msg={msg} />
      <div><Button variant="primary" loading={save.isPending} onClick={submit}>Guardar objetivo</Button></div>
    </section>
  );
}

function HoursCard({ s }: { s: SlaSettings }) {
  const [weekly, setWeekly] = useState(s.hours !== null);
  const [week, setWeek] = useState<WeekHours>(() => (s.hours ? cloneWeek(s.hours) : defaultWeek()));
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<Msg>();
  const save = useSaveHours();

  function submit() {
    setMsg(undefined);
    setError(undefined);
    if (weekly) {
      const problem = validateWeek(week);
      if (problem) return setError(problem);
    }
    save.mutate(weekly ? week : null, { onSuccess: () => setMsg({ kind: 'ok', text: weekly ? 'Horario guardado.' : 'La empresa quedó abierta siempre.' }), onError: (e) => setMsg({ kind: 'error', text: friendlyError(e, 'No pudimos guardar el horario.') }) });
  }

  return (
    <section aria-label="Horario laboral" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-bold">Horario laboral</h2>
          <p className="text-[12.5px] text-muted">El SLA solo corre dentro de este horario (y fuera de los feriados). Zona horaria de la empresa: <b className="font-semibold text-fg">{s.time_zone}</b>.</p>
        </div>
        <Pill kind={s.open_now ? 'ok' : 'muted'}>{s.open_now ? 'Abierta ahora' : 'Cerrada ahora'}</Pill>
      </div>
      <div role="radiogroup" aria-label="Tipo de horario" className="grid gap-1.5">
        <label className="flex items-start gap-2 text-[13.5px]"><input type="radio" name="hours-mode" aria-label="Abierta siempre" checked={!weekly} onChange={() => setWeekly(false)} className="mt-1" /><span><b>Abierta siempre</b><span className="block text-[12px] text-muted">Las 24 horas, todos los días: el SLA corre sin pausas.</span></span></label>
        <label className="flex items-start gap-2 text-[13.5px]"><input type="radio" name="hours-mode" aria-label="Horario semanal" checked={weekly} onChange={() => setWeekly(true)} className="mt-1" /><span><b>Horario semanal</b>{s.hours ? <span className="block text-[12px] text-muted">Guardado: {summarizeWeek(s.hours)}</span> : <span className="block text-[12px] text-muted">Elige los días y tramos en que atiendes.</span>}</span></label>
      </div>
      {weekly ? <HoursEditor value={week} onChange={setWeek} /> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Result msg={msg} />
      <div><Button variant="primary" loading={save.isPending} onClick={submit}>Guardar horario</Button></div>
    </section>
  );
}

function HolidaysCard({ s }: { s: SlaSettings }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [yearly, setYearly] = useState(false);
  const [errors, setErrors] = useState<{ date?: string; name?: string }>({});
  const [msg, setMsg] = useState<Msg>();
  const add = useAddHoliday();
  const remove = useRemoveHoliday();

  function submit() {
    setMsg(undefined);
    const next: typeof errors = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) next.date = 'Elige la fecha del feriado';
    if (name.trim() === '') next.name = 'Escribe cómo se llama';
    else if (name.trim().length > 80) next.name = 'Usa como máximo 80 caracteres';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    add.mutate({ date, name: name.trim(), yearly }, { onSuccess: () => { setDate(''); setName(''); setYearly(false); setMsg({ kind: 'ok', text: 'Feriado agregado.' }); }, onError: (e) => setMsg({ kind: 'error', text: friendlyError(e, 'No pudimos agregar el feriado.') }) });
  }

  return (
    <section aria-label="Feriados" className={card}>
      <div>
        <h2 className="text-[15px] font-bold">Feriados</h2>
        <p className="text-[12.5px] text-muted">Días en que la empresa no atiende: el SLA no corre en ellos. Se cargan a mano (no hay calendario automático). Marca «Se repite cada año» para los fijos, como Navidad.</p>
      </div>
      {s.holidays.length === 0 ? <p className="text-[12.5px] text-muted">Aún no hay feriados.</p> : (
        <ul aria-label="Lista de feriados" className="grid gap-1.5">
          {s.holidays.map((h: Holiday) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13.5px]">
              <span className="flex flex-wrap items-center gap-2"><b className="font-mono text-[13px]">{holidayDate(h.date)}</b><span>{h.name}</span>{h.yearly ? <Pill kind="info">Cada año</Pill> : null}</span>
              <Button variant="link" className="text-[12.5px]" aria-label={`Quitar el feriado ${h.name}`} loading={remove.isPending && remove.variables === h.id} onClick={() => { setMsg(undefined); remove.mutate(h.id, { onError: (e) => setMsg({ kind: 'error', text: friendlyError(e, 'No pudimos quitar el feriado.') }) }); }}>Quitar</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid items-start gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
        <Field label="Fecha" error={errors.date}>{(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Nombre" error={errors.name}>{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />}</Field>
      </div>
      <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" aria-label="Se repite cada año" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />Se repite cada año</label>
      <Result msg={msg} />
      <div><Button variant="primary" loading={add.isPending} onClick={submit}>Agregar feriado</Button></div>
    </section>
  );
}

/**
 * Configuración › SLA y horario (M5.5b, ADR-07/50; F08-F09): cuánto tiempo tiene el equipo para responder, en qué horario corre ese tiempo y qué días no se atiende. Solo
 * `sla.manage` (el administrador). El horario propio de una cola se edita en la cola; ahí también se pide reasignar si nadie responde.
 */
export function SlaPage() {
  const q = useSlaSettings();
  const s = q.data;
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <p className="max-w-[680px] text-[13.5px] text-muted">El SLA mide cuánto tarda tu equipo en responder. Solo cuenta el tiempo en que atiendes: fuera de horario y en feriados el reloj se detiene.</p>
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando el SLA" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar el SLA.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {s ? (
        <>
          <PolicyCard s={s} />
          <HoursCard s={s} />
          <HolidaysCard s={s} />
        </>
      ) : null}
    </div>
  );
}
