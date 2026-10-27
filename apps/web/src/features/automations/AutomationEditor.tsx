import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { reason } from './reason';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { Tabs } from '../crm/Tabs';
import { ActionCard, ConditionRow, TriggerEditor, useRuleOptions } from './AutomationParts';
import { RunsPanel, TestPanel } from './AutomationPanels';
import { NO_VALUE_OPS, STATUS_KIND, STATUS_LABEL } from './labels';
import { cleanAction, useAutomationMutations, useAutomations, type Action, type Automation, type AutomationInput, type Condition } from './useAutomations';

const MAX_ACTIONS = 10;
const MAX_CONDITIONS = 10;
type TabKey = 'edit' | 'test' | 'runs';

const EMPTY: AutomationInput = { name: '', description: null, trigger: { type: 'contact_created', filter: {} }, conditions: [], actions: [] };

/** Lo que se manda al servidor: filtros sin vacíos, condiciones sin valor sobrante y acciones solo con los datos de su tipo. */
function normalize(i: AutomationInput): AutomationInput {
  const filter = Object.fromEntries(Object.entries(i.trigger.filter).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  const conditions: Condition[] = i.conditions.map((c) => (NO_VALUE_OPS.includes(c.op) ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value: (c.value ?? '').trim() }));
  return { name: i.name.trim(), description: i.description?.trim() ? i.description.trim() : null, trigger: { type: i.trigger.type, filter }, conditions, actions: i.actions.map(cleanAction) };
}
const fromRule = (r: Automation): AutomationInput => ({ name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions, actions: r.actions });

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-bold text-white">{n}</span>
        <div className="grid gap-0.5"><h2 className="text-[16px] font-bold">{title}</h2>{hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}</div>
      </div>
      {children}
    </section>
  );
}

function EditorBody({ rule }: { rule: Automation | null }) {
  const nav = useNavigate();
  const m = useAutomationMutations();
  const o = useRuleOptions();
  const [saved, setSaved] = useState<AutomationInput>(() => normalize(rule ? fromRule(rule) : EMPTY));
  const [draft, setDraft] = useState<AutomationInput>(() => (rule ? fromRule(rule) : EMPTY));
  const [tab, setTab] = useState<TabKey>('edit');
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(normalize(draft)) !== JSON.stringify(saved);
  const patch = (p: Partial<AutomationInput>): void => {
    setOk(undefined);
    setDraft((d) => ({ ...d, ...p }));
  };
  const fieldName = (key: string): string => o.fields.find((f) => f.key === key)?.name ?? key;
  const tagName = (id: string): string => o.tags.find((t) => t.id === id)?.name ?? 'una etiqueta';

  const run = async (fn: () => Promise<unknown>, fallback: string, success?: string): Promise<boolean> => {
    setError(undefined);
    setOk(undefined);
    try {
      await fn();
      if (success) setOk(success);
      return true;
    } catch (e) {
      setError(reason(e, fallback));
      return false;
    }
  };
  const save = async (): Promise<Automation | null> => {
    const body = normalize(draft);
    if (body.name === '') {
      setError('Ponle un nombre a la automatización.');
      return null;
    }
    const box: { rule: Automation | null } = { rule: null };
    const good = await run(async () => {
      const r = rule ? await m.update.mutateAsync({ id: rule.id, patch: body }) : await m.create.mutateAsync(body);
      box.rule = r;
      setSaved(normalize(fromRule(r)));
    }, 'No pudimos guardar la automatización.', rule ? 'Cambios guardados.' : undefined);
    if (good && box.rule && !rule) nav(`/automations/${box.rule.id}`, { replace: true });
    return good ? box.rule : null;
  };
  const activate = async (): Promise<void> => {
    let id = rule?.id;
    if (!rule || dirty) {
      const s = await save();
      if (!s) return;
      id = s.id;
    }
    await run(() => m.activate.mutateAsync(id!), 'No pudimos activar la automatización.', 'Automatización activa: desde ahora reacciona a los hechos nuevos.');
  };

  const setCondition = (i: number, c: Condition): void => patch({ conditions: draft.conditions.map((x, j) => (j === i ? c : x)) });
  const setAction = (i: number, a: Action): void => patch({ actions: draft.actions.map((x, j) => (j === i ? a : x)) });
  const moveAction = (i: number, d: -1 | 1): void => {
    const next = [...draft.actions];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    patch({ actions: next });
  };
  const live = rule?.status === 'active';

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/automations" className="text-[13px] font-semibold text-accent">← Automatizaciones</Link>
        {rule ? <Pill kind={STATUS_KIND[rule.status]}>{STATUS_LABEL[rule.status]}</Pill> : <Pill kind="muted">Nueva</Pill>}
        {dirty ? <span className="text-[12.5px] text-muted">Cambios sin guardar</span> : null}
      </div>
      <div className="grid gap-3 min-[700px]:grid-cols-2">
        <Field label="Nombre" required>{(f) => <Input {...f} value={draft.name} maxLength={80} placeholder="Ej.: Etiquetar a los que llegan por el anuncio" onChange={(e) => patch({ name: e.target.value })} />}</Field>
        <Field label="Descripción (opcional)">{(f) => <Input {...f} value={draft.description ?? ''} maxLength={300} onChange={(e) => patch({ description: e.target.value })} />}</Field>
      </div>
      {rule ? <Tabs label="Secciones de la automatización" tabs={[['edit', 'Editor'], ['test', 'Probar'], ['runs', 'Historial']] as const} active={tab} onChange={setTab} /> : null}

      {tab === 'edit' ? (
        <div className="grid gap-4">
          <Step n={1} title="Cuando ocurre…" hint="El hecho que hace despertar a la regla. Solo reacciona a hechos nuevos, nunca a los de antes de activarla.">
            <TriggerEditor trigger={draft.trigger} onChange={(t) => patch({ trigger: t })} o={o} />
          </Step>
          <Step n={2} title="Si se cumple…" hint="Todas las condiciones deben cumplirse. Sin condiciones, la regla actúa siempre.">
            {draft.conditions.length === 0 ? <p className="text-[13px] text-muted">Sin condiciones.</p> : null}
            {draft.conditions.length > 0 ? (
              <ul aria-label="Condiciones" className="grid gap-2">
                {draft.conditions.map((c, i) => <ConditionRow key={i} c={c} index={i} o={o} onChange={(x) => setCondition(i, x)} onRemove={() => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })} />)}
              </ul>
            ) : null}
            <div><Button disabled={draft.conditions.length >= MAX_CONDITIONS} onClick={() => patch({ conditions: [...draft.conditions, { field: 'consent', op: 'eq', value: 'unknown' }] })}>Agregar condición</Button></div>
          </Step>
          <Step n={3} title="Haz esto…" hint="Las acciones se hacen en orden. Si una no se puede hacer, se anota y las demás siguen.">
            {draft.actions.length === 0 ? <p className="text-[13px] text-muted">Aún no hay acciones: agrega al menos una para poder activarla.</p> : null}
            {draft.actions.length > 0 ? (
              <ol aria-label="Acciones" className="grid gap-2">
                {draft.actions.map((a, i) => <ActionCard key={i} a={a} index={i} count={draft.actions.length} o={o} onChange={(x) => setAction(i, x)} onRemove={() => patch({ actions: draft.actions.filter((_, j) => j !== i) })} onMove={(d) => moveAction(i, d)} />)}
              </ol>
            ) : null}
            <div><Button disabled={draft.actions.length >= MAX_ACTIONS} onClick={() => patch({ actions: [...draft.actions, { type: 'add_tag' }] })}>Agregar acción</Button></div>
          </Step>
        </div>
      ) : null}
      {tab === 'test' && rule ? <TestPanel rule={rule} dirty={dirty} fieldName={fieldName} tagName={tagName} /> : null}
      {tab === 'runs' && rule ? <RunsPanel rule={rule} /> : null}

      {error ? <Alert>{error}</Alert> : null}
      {ok ? <Alert kind="ok">{ok}</Alert> : null}
      {tab === 'edit' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={m.update.isPending || m.create.isPending} disabled={!dirty && rule !== null} onClick={() => void save()}>{rule ? 'Guardar cambios' : 'Guardar como borrador'}</Button>
          {live ? (
            <Button loading={m.pause.isPending} onClick={() => void run(() => m.pause.mutateAsync(rule.id), 'No pudimos pausar la automatización.', 'Automatización en pausa: ya no reacciona y lo que estaba en cola se descarta.')}>Pausar</Button>
          ) : (
            <Button loading={m.activate.isPending} onClick={() => void activate()}>{rule?.status === 'paused' ? 'Reactivar' : 'Activar'}</Button>
          )}
          {rule ? (
            confirm ? (
              <>
                <Button variant="danger" loading={m.remove.isPending} onClick={() => void run(async () => { await m.remove.mutateAsync(rule.id); nav('/automations'); }, 'No pudimos borrar la automatización.')}>Sí, borrar</Button>
                <Button onClick={() => setConfirm(false)}>No, conservar</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirm(true)}>Borrar</Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Editor de una automatización (M9.4, ADR-54; F20): disparador → condiciones → acciones, con prueba en seco e historial. `id = 'new'` crea una nueva. */
export function AutomationEditor({ id }: { id: string }) {
  const q = useAutomations();
  if (id === 'new') return <EditorBody key="new" rule={null} />;
  if (q.isLoading) return <Spinner label="Cargando la automatización" />;
  if (q.isError) return <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')}</Alert>;
  const rule = q.data?.items.find((r) => r.id === id);
  if (!rule) {
    return (
      <div className="grid gap-3">
        <Alert>No encontramos esa automatización. Puede que se haya borrado.</Alert>
        <div><Link to="/automations" className="text-[13px] font-semibold text-accent">← Volver a Automatizaciones</Link></div>
      </div>
    );
  }
  return <EditorBody key={rule.id} rule={rule} />;
}
