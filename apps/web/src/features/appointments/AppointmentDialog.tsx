import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useNow } from '../../lib/useNow';
import type { Conversation } from '../../lib/types';
import { todayIn, zonedToIso, dateTimeIn } from '../../lib/zone';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { offsetLabel, REMINDER_CHOICES, useAppointmentOptions, useCreateAppointment } from './useAppointments';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
/** Margen antes de que cierre la ventana de 24 h en que todavía se confía en poder escribir con texto libre (igual que el servidor). */
const WINDOW_MARGIN_MS = 60_000;
const DURATIONS = [15, 30, 45, 60, 90, 120];
const BLOCKED: Record<NonNullable<ReturnType<typeof useAppointmentOptions>['data']>['blocked'] & string, string> = {
  unassigned: 'La conversación aún no tiene asesor: asígnala o tómala antes de agendar.',
  not_owner: 'Solo quien tiene asignada la conversación, o un administrador, puede agendar la cita.',
  channel_off: 'La conexión de WhatsApp de esta conversación está desactivada: no se podrían enviar los recordatorios.',
};

/**
 * «Agendar» desde el chat (F13, ADR-13): día y hora EN LA ZONA DE LA EMPRESA, duración, tipo, notas y hasta 3 recordatorios (5 en QR/Messenger/Instagram). Si algún
 * recordatorio saldría después de que se cierre la ventana de 24 h de WhatsApp, se elige una plantilla aprobada y se llenan sus valores. El servidor valida todo otra vez.
 */
export function AppointmentDialog({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const options = useAppointmentOptions(c.id);
  const create = useCreateAppointment();
  const idem = useIdempotencyKey();
  const now = useNow(30_000);
  const data = options.data;
  const tz = data?.timezone ?? 'UTC';
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(30);
  const [kind, setKind] = useState('Cita');
  const [notes, setNotes] = useState('');
  const [offsets, setOffsets] = useState<number[]>([60]);
  const [templateId, setTemplateId] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Partial<Record<'when' | 'kind' | 'reminders' | 'template', string>>>({});
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ when: string; reminders: number }>();

  const startsAt = date && time ? zonedToIso(date, time, tz) : null;
  const windowEnd = data?.window.expires_at ? Date.parse(data.window.expires_at) - WINDOW_MARGIN_MS : Number.NEGATIVE_INFINITY;
  // ¿Algún recordatorio saldría con la ventana de 24 h ya cerrada? (la misma regla que aplica el servidor)
  const needsTemplate = startsAt !== null && offsets.some((o) => Date.parse(startsAt) - o * 60_000 > windowEnd);
  const template = data?.templates.find((t) => t.id === templateId);
  const toggle = (m: number): void => setOffsets((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : cur.length >= (data?.max_reminders ?? 3) ? cur : [...cur, m].sort((a, b) => b - a)));

  const submit = (): void => {
    const e: typeof errors = {};
    if (!startsAt) e.when = 'Elige el día y la hora';
    else if (Date.parse(startsAt) < now - 60_000) e.when = 'La cita debe ser en el futuro';
    if (kind.trim() === '') e.kind = 'Escribe el tipo de cita';
    if (needsTemplate && !template) e.template = 'Elige una plantilla aprobada para los recordatorios que saldrían con la ventana de 24 h cerrada';
    else if (needsTemplate && template?.variables.some((v) => (params[v.id] ?? '').trim() === '')) e.template = 'Llena todos los valores de la plantilla';
    setErrors(e);
    setError(undefined);
    if (Object.keys(e).length > 0 || !startsAt) return;
    const input = {
      conversation_id: c.id,
      starts_at: startsAt,
      duration_minutes: duration,
      kind: kind.trim(),
      reminders: offsets,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(needsTemplate && template ? { reminder_template_id: template.id, reminder_params: Object.fromEntries(template.variables.map((v) => [v.id, (params[v.id] ?? '').trim()])) } : {}),
    };
    create.mutate({ key: idem.keyFor(input), input }, { onSuccess: (a) => setDone({ when: dateTimeIn(a.starts_at, tz), reminders: a.reminders.length }), onError: (err) => setError(friendlyError(err, 'No se pudo agendar la cita')) });
  };

  if (done) {
    return (
      <Modal title="Cita agendada" onClose={onClose}>
        <Alert kind="ok">Cita agendada para {done.when}. {done.reminders > 0 ? `Se enviarán ${done.reminders} recordatorio(s) por WhatsApp.` : 'Sin recordatorios.'}</Alert>
        <p className="text-[12.5px] text-muted">El contacto recibió la etiqueta «Cita agendada» y su oportunidad avanzó a la etapa de cita. La ves en la Agenda.</p>
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }

  return (
    <Modal title="Agendar cita" onClose={onClose}>
      {options.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando" /></div> : null}
      {options.isError ? <Alert>{friendlyError(options.error, 'No se pudo cargar el formulario')}</Alert> : null}
      {data?.blocked ? <Alert>{BLOCKED[data.blocked]}</Alert> : null}
      {data && !data.blocked ? (
        <div className="grid gap-3">
          <p className="text-[12.5px] text-muted">Cliente: <b>{c.contact.name}</b> · Hora de la empresa: <b>{tz}</b></p>
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <Field label="Día" error={errors.when}>{(f) => <Input {...f} type="date" min={todayIn(tz)} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Hora">{(f) => <Input {...f} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
            <Field label="Duración">
              {(f) => (
                <select {...f} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={selectCls}>
                  {DURATIONS.map((d) => <option key={d} value={d}>{d} min</option>)}
                </select>
              )}
            </Field>
          </div>
          <Field label="Tipo de cita" error={errors.kind}>{(f) => <Input {...f} value={kind} maxLength={60} onChange={(e) => setKind(e.target.value)} />}</Field>
          <Field label="Notas (opcional)">{(f) => <Input {...f} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />}</Field>

          <fieldset className="grid gap-2">
            <legend className="text-[13px] font-semibold">Recordatorios por WhatsApp <span className="font-normal text-muted">(hasta {data.max_reminders})</span></legend>
            <div className="flex flex-wrap gap-2">
              {REMINDER_CHOICES.map((r) => {
                const on = offsets.includes(r.minutes);
                return (
                  <label key={r.minutes} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] ${on ? 'border-accent bg-accent-soft font-semibold' : 'border-line'}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(r.minutes)} className="sr-only" aria-label={r.label} />
                    {r.label}
                  </label>
                );
              })}
            </div>
            <p className="text-[12px] text-muted" aria-live="polite">{offsets.length === 0 ? 'Sin recordatorios.' : `Elegidos: ${offsets.map(offsetLabel).join(', ')}.`}</p>
          </fieldset>

          {needsTemplate ? (
            <section aria-label="Plantilla para los recordatorios" className="grid gap-2 rounded-xl border border-line p-3">
              <p className="text-[12.5px]">Algún recordatorio saldría <b>después de que se cierre la ventana de 24 h</b> de WhatsApp: solo se puede enviar con una plantilla aprobada.</p>
              <Field label="Plantilla" error={errors.template}>
                {(f) => (
                  <select {...f} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setParams({}); }} className={selectCls}>
                    <option value="">Elige una…</option>
                    {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
                  </select>
                )}
              </Field>
              {template ? (
                <>
                  <p className="rounded-lg bg-surface2 px-3 py-2 text-[12.5px]">{template.body}</p>
                  {template.variables.map((v) => (
                    <Field key={v.id} label={`Valor de {{${v.key}}}`}>{(f) => <Input {...f} value={params[v.id] ?? ''} maxLength={200} onChange={(e) => setParams({ ...params, [v.id]: e.target.value })} />}</Field>
                  ))}
                </>
              ) : null}
              {data.templates.length === 0 ? <p className="text-[12px] text-muted">No hay plantillas aprobadas en esta conexión. Sincronízalas en Configuración › Conexiones.</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        {data && !data.blocked ? <Button variant="primary" loading={create.isPending} onClick={submit}>Agendar</Button> : null}
      </div>
    </Modal>
  );
}
