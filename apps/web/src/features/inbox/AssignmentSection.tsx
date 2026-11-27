import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { personName } from './inboxFormat';

type Kind = 'distribution' | 'reassigned' | 'taken' | 'assigned' | 'transferred' | 'released';
interface Person { id: string; name: string }
export interface Assignment {
  owner: Person | null;
  assigned_at: string | null;
  how: Kind | null;
  how_by: Person | null;
  queue: { id: string; name: string } | null;
  shared: Array<{ user: Person; permission: 'reply' | 'view'; added_by: Person | null; added_at: string | null }>;
  history: Array<{ at: string; kind: Kind; from: Person | null; to: Person | null; by: Person | null }>;
  history_scope: 'all' | 'own';
  time_zone: string;
}
/** Pasos del historial a la vista antes de «Ver todo». */
export const VISIBLE_STEPS = 10;

/** «12/10/2026 14:05» en la zona horaria de la empresa (si el navegador no la conoce, la suya). */
export function companyTime(iso: string, timeZone: string | undefined): string {
  const o: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('es-EC', { ...o, ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('es-EC', o).format(new Date(iso));
  }
}

const name = (p: Person | null): string => (p ? personName(p.name) : 'alguien');

export function howLabel(how: Kind | null, by: Person | null): string {
  if (how === 'distribution') return 'Reparto automático';
  if (how === 'reassigned') return 'Reasignada automáticamente por falta de respuesta';
  if (how === 'taken') return by ? `Tomada por ${name(by)}` : 'Tomada';
  if (how === 'assigned' || how === 'transferred') return by ? `Asignada manualmente por ${name(by)}` : 'Asignada manualmente';
  return 'Sin registro';
}

export function stepLabel(s: Assignment['history'][number]): string {
  switch (s.kind) {
    case 'distribution': return `Asignada a ${name(s.to)} · reparto automático`;
    case 'reassigned': return `De ${name(s.from)} a ${name(s.to)} · por falta de respuesta`;
    case 'taken': return `${name(s.to)} la tomó`;
    case 'assigned': return `Asignada a ${name(s.to)} · ${name(s.by)}`;
    case 'transferred': return `De ${name(s.from)} a ${name(s.to)} · ${name(s.by)}`;
    default: return `${name(s.from)} dejó de tenerla (quedó sin asignar)${s.by ? ` · ${name(s.by)}` : ''}`;
  }
}

const label = 'text-[12px] text-muted';

/**
 * Bloque «Asignación» (V24): asesor asignado, cómo y cuándo, departamento, con quién está compartida y el historial. `responsible`: el responsable del contacto (null = no tiene;
 * undefined = esta persona no puede verlo), que puede ser distinto de quien tiene la conversación. Se actualiza con la conversación (la clave cuelga de la suya).
 */
export function AssignmentSection({ c, responsible }: { c: Conversation; responsible?: string | null | undefined }) {
  const q = useQuery({ queryKey: ['conversation', c.id, 'assignment'], retry: false, queryFn: () => api<Assignment>(`/conversations/${c.id}/assignment`) });
  const [all, setAll] = useState(false);
  const owner = responsible !== undefined ? <dl><dt className={label}>Responsable</dt><dd className="text-[13px]">{responsible ?? 'Sin responsable'}</dd></dl> : null;
  if (q.isPending) return <><Spinner label="Cargando la asignación" />{owner}</>;
  if (q.isError) return <><Alert>{friendlyError(q.error, 'No pudimos cargar la asignación.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert>{owner}</>;
  const a = q.data;
  const zone = a.time_zone;
  const steps = all ? a.history : a.history.slice(0, VISIBLE_STEPS);
  return (
    <div className="grid gap-2 text-[13px]">
      <dl className="grid gap-1.5">
        <div><dt className={label}>Asesor asignado</dt><dd>{a.owner ? <><b>{name(a.owner)}</b>{a.assigned_at ? ` · desde el ${companyTime(a.assigned_at, zone)}` : ''}</> : 'Sin asignar'}</dd></div>
        {a.owner ? <div><dt className={label}>Cómo se asignó</dt><dd>{howLabel(a.how, a.how_by)}</dd></div> : null}
        <div><dt className={label}>Departamento</dt><dd>{a.queue?.name ?? 'Sin departamento'}</dd></div>
        <div>
          <dt className={label}>Compartido con</dt>
          <dd>
            {a.shared.length === 0 ? 'No está compartida' : (
              <ul className="grid gap-1">
                {a.shared.map((s) => (
                  <li key={s.user.id}>
                    <b>{name(s.user)}</b> · {s.permission === 'reply' ? 'Puede responder' : 'Solo ver y notas'}
                    {s.added_at ? <span className={`block ${label}`}>{s.added_by ? `La compartió ${name(s.added_by)} · ` : ''}{companyTime(s.added_at, zone)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      {owner}
      <div>
        <h3 className={label}>{a.history_scope === 'own' ? 'Tus pasos' : 'Transferencias y asignaciones'}</h3>
        {a.history.length === 0 ? <p>Sin movimientos registrados.</p> : (
          <ol aria-label="Historial de asignación" className="grid gap-1">
            {steps.map((s, i) => <li key={`${s.at}-${i}`}>{stepLabel(s)}<span className={`block ${label}`}>{companyTime(s.at, zone)}</span></li>)}
          </ol>
        )}
        {a.history.length > VISIBLE_STEPS ? <Button variant="link" aria-expanded={all} onClick={() => setAll((v) => !v)}>{all ? 'Ver menos' : `Ver todo (${a.history.length})`}</Button> : null}
      </div>
    </div>
  );
}
