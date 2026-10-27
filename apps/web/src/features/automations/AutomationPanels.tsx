import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { ContactList } from '../../lib/types';
import { Alert, Button, Input, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { OP_LABEL, RUN_KIND, RUN_LABEL, STEP_KIND, STEP_LABEL, TRIGGER_LABEL, WOULD_KIND, WOULD_LABEL } from './labels';
import { useAutomationMutations, useAutomationRuns, type Automation, type Condition, type DryRun } from './useAutomations';

/** Describe una condición en una frase (para decir cuál no se cumplió). */
function conditionText(c: Condition, names: { tag: (id: string) => string; field: (key: string) => string }): string {
  const what = c.field.startsWith('custom:') ? names.field(c.field.slice(7)) : { tag: 'Etiquetas', source: 'Origen', owner: 'Responsable', consent: 'Consentimiento' }[c.field] ?? c.field;
  const value = c.field === 'tag' && c.value ? names.tag(c.value) : (c.value ?? '');
  return `${what} ${OP_LABEL[c.op] ?? c.op}${value ? ` «${value}»` : ''}`;
}

function useContactSearch(q: string) {
  return useQuery({
    queryKey: ['automation-test-contacts', q],
    enabled: q.trim().length >= 2,
    retry: false,
    queryFn: () => api<ContactList>(`/contacts?q=${encodeURIComponent(q.trim())}&limit=8`),
  });
}

/** Prueba en seco: eliges un contacto y la regla dice qué haría con él, sin escribir ni enviar nada. */
export function TestPanel({ rule, dirty, fieldName, tagName }: { rule: Automation; dirty: boolean; fieldName: (key: string) => string; tagName: (id: string) => string }) {
  const { test } = useAutomationMutations();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);
  const found = useContactSearch(debounced);
  const [error, setError] = useState<string>();
  const run = (contactId: string): void => {
    setError(undefined);
    test.mutate({ id: rule.id, contactId }, { onError: (e) => setError(friendlyError(e, 'No pudimos hacer la prueba.')) });
  };
  const out: DryRun | undefined = test.data;
  return (
    <div className="grid gap-3">
      <p className="max-w-[70ch] text-[13px] text-muted">Elige un contacto y mira qué haría esta regla con él. <b>No se envía, asigna ni cambia nada.</b> Es una estimación de este momento.</p>
      {dirty ? <Alert kind="info">Tienes cambios sin guardar: la prueba usa la última versión guardada.</Alert> : null}
      <label className="grid gap-1 text-[13px] font-semibold">
        Buscar contacto
        <Input value={term} placeholder="Nombre o teléfono" onChange={(e) => setTerm(e.target.value)} />
      </label>
      {found.isLoading ? <Spinner label="Buscando contactos" /> : null}
      {found.data && found.data.items.length === 0 ? <p className="text-[13px] text-muted">No encontramos contactos con ese dato.</p> : null}
      {found.data && found.data.items.length > 0 ? (
        <ul aria-label="Contactos encontrados" className="grid gap-1.5">
          {found.data.items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13.5px]">
              <span><b>{c.name}</b>{c.phones[0] ? <span className="ml-2 text-muted">{c.phones[0].e164}</span> : null}</span>
              <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={test.isPending && test.variables?.contactId === c.id} aria-label={`Probar con ${c.name}`} onClick={() => run(c.id)}>Probar</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {out ? (
        <section aria-label="Resultado de la prueba" className="grid gap-2 rounded-xl border border-line p-3">
          <h3 className="text-[15px] font-bold">Con {out.contact.name}</h3>
          {out.conditions.length > 0 ? (
            <ul aria-label="Condiciones" className="grid gap-1 text-[13px]">
              {out.conditions.map((c) => (
                <li key={c.index} className="flex flex-wrap items-center gap-2">
                  <Pill kind={c.met ? 'ok' : 'crit'}>{c.met ? 'Cumple' : 'No cumple'}</Pill>
                  <span>{conditionText(rule.conditions[c.index]!, { tag: tagName, field: fieldName })}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {out.meets ? null : <Alert kind="info">No cumple todas las condiciones: la regla no se ejecutaría con este contacto.</Alert>}
          {out.meets && out.actions.length === 0 ? <p className="text-[13px] text-muted">La regla no tiene acciones.</p> : null}
          {out.actions.length > 0 ? (
            <ol aria-label="Acciones" className="grid gap-1.5">
              {out.actions.map((a) => (
                <li key={a.position} className="flex flex-wrap items-center gap-2 text-[13.5px]">
                  <span className="text-muted">{a.position}.</span>
                  <b>{a.label}</b>
                  <Pill kind={WOULD_KIND[a.would]}>{WOULD_LABEL[a.would]}</Pill>
                  <span className="text-[12.5px] text-muted">{a.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Historial: cada vez que la regla reaccionó a un hecho, con lo que hizo cada paso y el motivo de lo que no pudo. */
export function RunsPanel({ rule }: { rule: Automation }) {
  const q = useAutomationRuns(rule.id, true);
  const items = q.data?.items ?? [];
  return (
    <div className="grid gap-3">
      <p className="max-w-[70ch] text-[13px] text-muted">Aquí ves lo que hizo la regla, las más recientes primero. Lo que una defensa cortó (ciclos o demasiadas ejecuciones) queda como «Omitida» con su motivo.</p>
      {q.isLoading ? <Spinner label="Cargando el historial" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar el historial.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Todavía no se ha ejecutado. Cuando ocurra «{TRIGGER_LABEL[rule.trigger.type].toLowerCase()}» y la regla esté activa, aparecerá aquí.</p> : null}
      {items.length > 0 ? (
        <ul aria-label="Ejecuciones" className="grid gap-2">
          {items.map((r) => (
            <li key={r.id} className="grid gap-1.5 rounded-xl border border-line p-3 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <b>{r.contact.name}</b>
                <Pill kind={RUN_KIND[r.status]}>{RUN_LABEL[r.status]}</Pill>
                {r.depth > 0 ? <Pill kind="info">Encadenada</Pill> : null}
                <time dateTime={r.at} className="text-muted">{new Date(r.at).toLocaleString('es-EC')}</time>
              </span>
              {r.reason ? <span className="text-[12.5px] text-muted">{r.reason}</span> : null}
              {r.steps.length > 0 ? (
                <ol aria-label={`Pasos de la ejecución de ${r.contact.name}`} className="grid gap-1">
                  {r.steps.map((s) => (
                    <li key={s.position} className="flex flex-wrap items-center gap-2">
                      <span className="text-muted">{s.position}.</span>
                      <span>{s.label}</span>
                      <Pill kind={STEP_KIND[s.outcome]}>{STEP_LABEL[s.outcome]}</Pill>
                      {s.detail ? <span className="text-[12.5px] text-muted">{s.detail}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
