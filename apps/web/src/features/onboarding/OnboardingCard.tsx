import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Me } from '../../lib/types';
import { useOnboarding } from './useOnboarding';

const key = (orgId: string): string => `ss:onboarding-dismissed:${orgId}`;
const wasDismissed = (orgId: string): boolean => {
  try {
    return window.localStorage.getItem(key(orgId)) === '1';
  } catch {
    return false;
  }
};

/**
 * «Primeros pasos» (M10.6, ADR-56 B5): cinco pasos derivados de datos que ya existen, así que se marcan solos. Solo para quien administra la empresa y mientras no esté todo hecho;
 * se puede cerrar (la preferencia vive en este navegador). Si se está mirando como otro rol no se muestra.
 */
export function OnboardingCard({ me }: { me: Me }) {
  const eligible = me.role === 'client_admin' && me.organization.kind === 'client' && !me.viewing_as && !me.acting_as;
  const [closed, setClosed] = useState(() => wasDismissed(me.organization.id));
  const q = useOnboarding(eligible && !closed);
  if (!eligible || closed || !q.data || q.data.complete) return null;
  const { steps, done, total } = q.data;

  function dismiss() {
    try {
      window.localStorage.setItem(key(me.organization.id), '1');
    } catch {
      /* sin almacenamiento: se oculta solo en esta visita */
    }
    setClosed(true);
  }

  return (
    <section aria-label="Primeros pasos" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-bold">Primeros pasos</h2>
          <p className="text-[12.5px] text-muted">{done} de {total} listos. Te dejamos algunos ejemplos apagados para que veas cómo funciona.</p>
        </div>
        <button type="button" onClick={dismiss} aria-label="Cerrar los primeros pasos" className="min-h-11 rounded-lg px-3 text-[12.5px] font-semibold text-muted hover:bg-surface2 hover:text-fg">Ocultar</button>
      </div>
      <div role="progressbar" aria-label="Avance de los primeros pasos" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-surface2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ol className="grid gap-1.5">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 rounded-xl border border-line px-3 py-2">
            <span aria-hidden="true" className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${s.done ? 'border-ok bg-ok-soft text-ok' : 'border-line text-muted'}`}>{s.done ? '✓' : ''}</span>
            <span className="grid min-w-0 flex-1">
              <span className={`text-[13.5px] font-semibold ${s.done ? 'text-muted line-through' : ''}`}>{s.label}<span className="sr-only">{s.done ? ' (hecho)' : ' (pendiente)'}</span></span>
              <span className="text-[12.5px] text-muted">{s.hint}</span>
            </span>
            {s.done ? null : <Link to={s.to} className="shrink-0 self-center rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface2">Ir</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
