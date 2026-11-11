import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Spinner } from '../../ui/controls';
import { REASON_LABEL, useFollowUps, useSaveFollowUps, type FollowUpMode, type FollowUps } from './useFollowUps';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const areaCls = 'min-h-[80px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] font-normal text-fg';
const inputCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const MAX_STEPS = 5;
const MIN_MINUTES = 5;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_TEXT = 1000;

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MIN: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const UNIT_LABEL: Record<Unit, string> = { minutes: 'minutos', hours: 'horas', days: 'días' };

interface Draft { amount: string; unit: Unit; mode: FollowUpMode; text: string; automation: string }

/** Muestra una cantidad de minutos con la unidad más grande que la divide exacto. */
function split(minutes: number): { amount: string; unit: Unit } {
  if (minutes % 1440 === 0) return { amount: String(minutes / 1440), unit: 'days' };
  if (minutes % 60 === 0) return { amount: String(minutes / 60), unit: 'hours' };
  return { amount: String(minutes), unit: 'minutes' };
}

const fromServer = (d: FollowUps): Draft[] => d.steps.map((s) => ({ ...split(s.delay_minutes), mode: s.mode, text: s.fixed_text ?? '', automation: s.start_automation_id ?? '' }));
const minutesOf = (d: Draft): number => Math.round(Number(d.amount) * UNIT_MIN[d.unit]);

/** Revisa lo que el servidor también revisa (la pantalla es solo ayuda). Devuelve el primer problema o `undefined`. */
function problem(steps: Draft[]): string | undefined {
  for (const [i, s] of steps.entries()) {
    const n = i + 1;
    const m = minutesOf(s);
    if (!Number.isFinite(m) || m < MIN_MINUTES || m > MAX_MINUTES) return `Paso ${n}: la espera debe ir de 5 minutos a 7 días.`;
    if (s.mode === 'fixed_text' && s.text.trim() === '') return `Paso ${n}: escribe el texto del mensaje o deja que lo escriba la IA.`;
    if (s.mode === 'none' && s.automation === '') return `Paso ${n}: elige la automatización que se iniciará o cambia a enviar un mensaje.`;
  }
  return undefined;
}

/** Resumen de los últimos 7 días: cuántos salieron, quedaron pendientes, se cancelaron u omitieron, y por qué. */
function Summary({ d }: { d: FollowUps }) {
  const s = d.summary;
  if (s.sent + s.skipped + s.cancelled + s.pending === 0) return <p className="text-[12.5px] text-muted">Aún no hay seguimientos en los últimos 7 días.</p>;
  const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]);
  return (
    <section aria-label="Últimos 7 días" className="grid gap-1.5 rounded-xl bg-surface2 p-3 text-[12.5px]">
      <h3 className="text-[13px] font-bold">Últimos 7 días</h3>
      <p>{s.sent} enviados · {s.pending} pendientes · {s.cancelled} cancelados (ya no hacían falta) · {s.skipped} omitidos</p>
      {reasons.length > 0 ? <ul className="grid gap-0.5 text-muted">{reasons.map(([k, n]) => <li key={k}>{n} × {REASON_LABEL[k] ?? k}</li>)}</ul> : null}
    </section>
  );
}

function Editor({ agentId, data }: { agentId: string; data: FollowUps }) {
  const save = useSaveFollowUps(agentId);
  const [enabled, setEnabled] = useState(data.enabled);
  const [steps, setSteps] = useState<Draft[]>(fromServer(data));
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const patch = (i: number, p: Partial<Draft>): void => { setOk(false); setSteps((cur) => cur.map((s, j) => (j === i ? { ...s, ...p } : s))); };
  const add = (): void => { setOk(false); setSteps((cur) => [...cur, { amount: cur.length === 0 ? '30' : '1', unit: cur.length === 0 ? 'minutes' : 'days', mode: 'ai', text: '', automation: '' }]); };
  const remove = (i: number): void => { setOk(false); setSteps((cur) => cur.filter((_, j) => j !== i)); };
  const submit = async (): Promise<void> => {
    setOk(false);
    const bad = enabled ? problem(steps) : undefined;
    if (bad) { setError(bad); return; }
    setError(undefined);
    try {
      await save.mutateAsync({
        enabled,
        steps: steps.map((s) => ({ delay_minutes: minutesOf(s), mode: s.mode, fixed_text: s.mode === 'fixed_text' ? s.text.trim() : null, start_automation_id: s.automation || null })),
      });
      setOk(true);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos guardar los seguimientos.'));
    }
  };
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">
        Cuando el agente contesta y el cliente deja de responder, puede retomar la conversación solo. Se cancela en cuanto el cliente escribe, una persona interviene o se pausa al agente; respeta el horario del departamento y las 24 horas de WhatsApp oficial.
      </p>
      <label className="flex items-start gap-2 text-[13.5px] font-semibold">
        <input type="checkbox" role="switch" checked={enabled} onChange={(e) => { setOk(false); setEnabled(e.target.checked); }} className="mt-1" />
        <span>Activar los seguimientos de este agente<span className="block text-[12.5px] font-normal text-muted">Escenario: «El contacto dejó de responder». Los mensajes escritos por la IA gastan créditos.</span></span>
      </label>
      <ol aria-label="Pasos del seguimiento" className="grid gap-3">
        {steps.map((s, i) => (
          <li key={i} className="grid gap-2 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-bold">Paso {i + 1}</h3>
              <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Quitar el paso ${i + 1}`} onClick={() => remove(i)}>Quitar</Button>
            </div>
            <div className="grid grid-cols-[1fr_1fr] items-end gap-2">
              <Field label={i === 0 ? 'Esperar tras la respuesta del agente' : 'Esperar tras el paso anterior'}>
                {(f) => <input {...f} type="number" min={1} inputMode="numeric" className={inputCls} value={s.amount} onChange={(e) => patch(i, { amount: e.target.value })} />}
              </Field>
              <Field label="Unidad">
                {(f) => <select {...f} className={selectCls} value={s.unit} onChange={(e) => patch(i, { unit: e.target.value as Unit })}>{(Object.keys(UNIT_LABEL) as Unit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}</select>}
              </Field>
            </div>
            <Field label="Qué hace">
              {(f) => (
                <select {...f} className={selectCls} value={s.mode} onChange={(e) => patch(i, { mode: e.target.value as FollowUpMode })}>
                  <option value="ai">La IA escribe el mensaje</option>
                  <option value="fixed_text">Enviar un texto fijo</option>
                  <option value="none">Solo iniciar una automatización</option>
                </select>
              )}
            </Field>
            {s.mode === 'fixed_text' ? (
              <Field label="Texto del mensaje" hint={`Puedes usar ${data.variables.map((v) => `{{${v}}}`).join(', ')}. Hasta ${MAX_TEXT} caracteres.`}>
                {(f) => <textarea {...f} className={areaCls} maxLength={MAX_TEXT} value={s.text} onChange={(e) => patch(i, { text: e.target.value })} />}
              </Field>
            ) : null}
            <Field label={s.mode === 'none' ? 'Automatización que se inicia' : 'Además, iniciar una automatización (opcional)'}>
              {(f) => (
                <select {...f} className={selectCls} value={s.automation} onChange={(e) => patch(i, { automation: e.target.value })}>
                  <option value="">{s.mode === 'none' ? 'Elige una…' : 'Ninguna'}</option>
                  {data.automations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </Field>
          </li>
        ))}
      </ol>
      {steps.length === 0 ? <p className="text-[12.5px] text-muted">Aún no hay pasos. Agrega el primero.</p> : null}
      <div>
        <Button disabled={steps.length >= MAX_STEPS} onClick={add}>Agregar paso</Button>
        {steps.length >= MAX_STEPS ? <span className="ml-2 text-[12px] text-muted">Máximo {MAX_STEPS} pasos.</span> : null}
      </div>
      <Summary d={data} />
      {error ? <Alert>{error}</Alert> : ok ? <Alert kind="ok">Cambios guardados.</Alert> : null}
      <div><Button variant="primary" loading={save.isPending} onClick={() => void submit()}>Guardar</Button></div>
    </div>
  );
}

/** Pestaña «Seguimiento» del agente (v11 S5, ADR-68): la secuencia de mensajes cuando el contacto deja de responder. */
export function FollowUpTab({ agentId }: { agentId: string }) {
  const q = useFollowUps(agentId);
  if (q.isLoading) return <Spinner label="Cargando los seguimientos" />;
  if (q.isError || !q.data) return <Alert>{friendlyError(q.error, 'No pudimos cargar los seguimientos.')}</Alert>;
  return <Editor agentId={agentId} data={q.data} />;
}
