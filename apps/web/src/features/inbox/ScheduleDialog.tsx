import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useScheduleMessage } from './useInbox';

const MIN = 60_000;
/** Igual que el servidor: al menos un minuto en el futuro (aquí dos, por si pasa un rato) y un minuto antes de que cierre la ventana. */
const LEAD_MS = 2 * MIN;
const MARGIN_MS = 60_000;

const pad = (n: number): string => String(n).padStart(2, '0');
/** Valor de un `<input type="datetime-local">` (hora local, sin zona). */
export const toLocalInput = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Hasta cuándo se puede programar: un minuto antes de que cierre la ventana de 24 h de WhatsApp; null si ya está cerrada. */
export function scheduleLimit(c: Pick<Conversation, 'window'>): Date | null {
  return c.window.open && c.window.expires_at ? new Date(new Date(c.window.expires_at).getTime() - MARGIN_MS) : null;
}

/** Atajos de hora que caen dentro de la ventana: en 30 minutos, 1 hora, 3 horas y mañana a las 9:00. */
export function quickTimes(now: Date, limit: Date): Array<{ label: string; at: Date }> {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: 'En 30 minutos', at: new Date(now.getTime() + 30 * MIN) },
    { label: 'En 1 hora', at: new Date(now.getTime() + 60 * MIN) },
    { label: 'En 3 horas', at: new Date(now.getTime() + 180 * MIN) },
    { label: 'Mañana a las 9:00', at: tomorrow },
  ].filter((o) => o.at.getTime() >= now.getTime() + LEAD_MS && o.at.getTime() <= limit.getTime());
}

/** Elegir cuándo debe salir el mensaje que se escribió. Solo cabe dentro de la ventana de 24 h; el servidor lo vuelve a comprobar. */
export function ScheduleDialog({ c, text, onClose, onDone }: { c: Conversation; text: string; onClose: () => void; onDone: () => void }) {
  const schedule = useScheduleMessage(c.id);
  const limit = scheduleLimit(c);
  const [now] = useState(() => new Date());
  const options = limit ? quickTimes(now, limit) : [];
  const [value, setValue] = useState(options[0] ? toLocalInput(options[0].at) : '');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const earliest = new Date(now.getTime() + LEAD_MS);

  function submit(): void {
    setFieldError(undefined);
    setError(undefined);
    const at = value ? new Date(value) : null;
    if (!at || Number.isNaN(at.getTime())) return setFieldError('Elige el día y la hora');
    if (at.getTime() < earliest.getTime()) return setFieldError('Elige una hora al menos dos minutos en el futuro');
    if (limit && at.getTime() > limit.getTime()) return setFieldError(`WhatsApp solo permite escribir libremente hasta ${shortDateTime(limit.toISOString())}`);
    schedule.mutate(
      { text, send_at: at.toISOString() },
      {
        onSuccess: () => {
          onDone();
          onClose();
        },
        onError: (e) => {
          if (e instanceof ApiError && e.details.some((d) => d.path === 'send_at')) return setFieldError(e.details.find((d) => d.path === 'send_at')!.message);
          setError(friendlyError(e, 'No pudimos programar el mensaje.'));
        },
      },
    );
  }

  return (
    <Modal title="Programar mensaje" onClose={onClose}>
      <p className="whitespace-pre-wrap rounded-xl bg-accent-soft p-3 text-[13.5px]" aria-label="Mensaje a programar">{text}</p>
      {limit ? (
        <>
          {options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Horas sugeridas">
              {options.map((o) => (
                <button key={o.label} type="button" onClick={() => { setValue(toLocalInput(o.at)); setFieldError(undefined); }} className="rounded-full border border-line px-3 py-1 text-[12.5px] font-semibold text-muted hover:border-accent hover:text-accent">{o.label}</button>
              ))}
            </div>
          ) : null}
          <Field label="Día y hora" required error={fieldError} hint={`Puedes programarlo hasta ${shortDateTime(limit.toISOString())}: después, WhatsApp solo permite plantillas.`}>
            {(p) => <Input {...p} type="datetime-local" value={value} min={toLocalInput(earliest)} max={toLocalInput(limit)} onChange={(e) => { setValue(e.target.value); setFieldError(undefined); }} />}
          </Field>
          <Alert kind="info">Si el cliente te escribe antes de esa hora, el mensaje se cancela solo. Lo puedes cancelar tú cuando quieras.</Alert>
        </>
      ) : (
        <Alert>Pasaron más de 24 horas desde el último mensaje del cliente: ya no se puede programar un mensaje libre. Usa una plantilla.</Alert>
      )}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        {limit ? <Button variant="primary" loading={schedule.isPending} onClick={submit}>Programar</Button> : null}
      </div>
    </Modal>
  );
}
