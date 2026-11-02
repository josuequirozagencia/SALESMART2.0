import type { ReactNode } from 'react';
import { Button, Field, Input } from '../../ui/controls';
import { useChannels } from '../channels/useChannels';
import { useOwners } from '../contacts/useContacts';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { useFollowUpTemplates } from '../forms/useForms';
import { usePipelines } from '../pipelines/usePipelines';
import { useQueues } from '../queues/useQueues';
import { useTags } from '../tags/useTags';
import { ACTION_HINT, ACTION_LABEL, ACTIONS, CONSENT_LABEL, HTTP_VARIABLE_HELP, hostCovered, NO_VALUE_OPS, OP_LABEL, opsFor, SOURCE_SUGGESTIONS, TRIGGER_LABEL, TRIGGERS, UNIT_LABEL } from './labels';
import { useAutomations, useAutomationSettings, type Action, type ActionType, type Condition, type Trigger, type TriggerType, type WaitUnit } from './useAutomations';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const small = '!px-3 !py-1.5 !text-[12.5px]';

/** Lo que el editor puede elegir: todo sale de la propia empresa (el servidor vuelve a comprobar que exista y encaje). */
export function useRuleOptions() {
  const fields = useCustomFields().data?.items ?? [];
  const tags = useTags().data?.items ?? [];
  const pipelines = usePipelines().data?.items ?? [];
  const queues = useQueues().data?.items ?? [];
  const channels = useChannels().data?.items ?? [];
  const people = useOwners(true).data ?? [];
  const rules = useAutomations().data?.items ?? [];
  const allowedHosts = useAutomationSettings().data?.http_allowed_hosts ?? [];
  return { allowedHosts, rules, fields, tags, customTags: tags.filter((t) => !t.is_system), pipelines, queues, channels, official: channels.filter((c) => c.is_official && c.status === 'active'), people };
}
type Options = ReturnType<typeof useRuleOptions>;

function Select({ value, onChange, children, ...rest }: { value: string; onChange: (v: string) => void; children: ReactNode; id?: string; 'aria-invalid'?: true; 'aria-describedby'?: string; 'aria-label'?: string }) {
  return (
    <select {...rest} className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}

// ------------------------------------------------------------------------------------------------ disparador

export function TriggerEditor({ trigger, onChange, o }: { trigger: Trigger; onChange: (t: Trigger) => void; o: Options }) {
  const set = (key: string, v: string): void => {
    const filter = { ...trigger.filter };
    if (v === '') delete filter[key];
    else filter[key] = v;
    // elegir otro pipeline invalida la etapa elegida antes
    if (key === 'pipeline_id') delete filter['to_stage_id'];
    onChange({ ...trigger, filter });
  };
  const stages = o.pipelines.filter((p) => !trigger.filter['pipeline_id'] || p.id === trigger.filter['pipeline_id']).flatMap((p) => p.stages.filter((s) => !s.is_hidden).map((s) => ({ id: s.id, label: o.pipelines.length > 1 && !trigger.filter['pipeline_id'] ? `${p.name} · ${s.name}` : s.name })));
  return (
    <div className="grid gap-3">
      <Field label="Cuando ocurre">
        {(f) => (
          <Select {...f} value={trigger.type} onChange={(v) => onChange({ type: v as TriggerType, filter: {} })}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </Select>
        )}
      </Field>
      {trigger.type === 'contact_created' ? (
        <Field label="Origen del contacto (opcional)" hint="Déjalo vacío para cualquier origen.">
          {(f) => (
            <>
              <Input {...f} list="automation-sources" value={trigger.filter['source'] ?? ''} maxLength={40} onChange={(e) => set('source', e.target.value)} />
              <datalist id="automation-sources">{SOURCE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}</datalist>
            </>
          )}
        </Field>
      ) : null}
      {trigger.type === 'message_received' ? (
        <Field label="Conexión (opcional)">
          {(f) => (
            <Select {...f} value={trigger.filter['channel_id'] ?? ''} onChange={(v) => set('channel_id', v)}>
              <option value="">Cualquier conexión</option>
              {o.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
      {trigger.type === 'opportunity_created' || trigger.type === 'stage_changed' ? (
        <Field label="Pipeline (opcional)">
          {(f) => (
            <Select {...f} value={trigger.filter['pipeline_id'] ?? ''} onChange={(v) => set('pipeline_id', v)}>
              <option value="">Cualquier pipeline</option>
              {o.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
      {trigger.type === 'stage_changed' ? (
        <div className="grid gap-3 min-[560px]:grid-cols-2">
          <Field label="Etapa de destino (opcional)">
            {(f) => (
              <Select {...f} value={trigger.filter['to_stage_id'] ?? ''} onChange={(v) => set('to_stage_id', v)}>
                <option value="">Cualquier etapa</option>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Estado de destino (opcional)">
            {(f) => (
              <Select {...f} value={trigger.filter['to_status'] ?? ''} onChange={(v) => set('to_status', v)}>
                <option value="">Cualquiera</option>
                <option value="open">Abierta</option>
                <option value="won">Ganada</option>
                <option value="lost">Perdida</option>
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {trigger.type === 'field_changed' ? (
        <div className="grid gap-3 min-[560px]:grid-cols-2">
          <Field label="Campo" required>
            {(f) => (
              <Select {...f} value={trigger.filter['field'] ?? ''} onChange={(v) => set('field', v)}>
                <option value="">Elige un campo</option>
                {o.fields.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Cuando pase a este valor (opcional)">{(f) => <Input {...f} value={trigger.filter['value'] ?? ''} maxLength={200} onChange={(e) => set('value', e.target.value)} />}</Field>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ condiciones

export function ConditionRow({ c, index, onChange, onRemove, o }: { c: Condition; index: number; onChange: (c: Condition) => void; onRemove: () => void; o: Options }) {
  const n = index + 1;
  const retarget = (field: string): void => {
    const op = opsFor(field)[0]!;
    onChange({ field, op, ...(NO_VALUE_OPS.includes(op) ? {} : { value: field === 'consent' ? 'unknown' : '' }) });
  };
  const setOp = (op: string): void => onChange({ field: c.field, op, ...(NO_VALUE_OPS.includes(op) ? {} : { value: c.value ?? '' }) });
  const def = c.field.startsWith('custom:') ? o.fields.find((f) => f.key === c.field.slice(7)) : undefined;
  const needsValue = !NO_VALUE_OPS.includes(c.op);
  const label = (what: string): string => `Condición ${n}: ${what}`;
  let value: ReactNode = null;
  if (needsValue) {
    const set = (v: string): void => onChange({ ...c, value: v });
    if (c.field === 'tag') {
      value = (
        <Select aria-label={label('etiqueta')} value={c.value ?? ''} onChange={set}>
          <option value="">Elige una etiqueta</option>
          {o.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      );
    } else if (c.field === 'owner') {
      value = (
        <Select aria-label={label('persona')} value={c.value ?? ''} onChange={set}>
          <option value="">Elige una persona</option>
          {o.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      );
    } else if (c.field === 'consent') {
      value = (
        <Select aria-label={label('consentimiento')} value={c.value ?? 'unknown'} onChange={set}>
          {(Object.keys(CONSENT_LABEL) as Array<keyof typeof CONSENT_LABEL>).map((k) => <option key={k} value={k}>{CONSENT_LABEL[k]}</option>)}
        </Select>
      );
    } else if (def && (def.type === 'select' || def.type === 'multiselect') && (c.op === 'eq' || c.op === 'neq')) {
      value = (
        <Select aria-label={label('valor')} value={c.value ?? ''} onChange={set}>
          <option value="">Elige una opción</option>
          {(def.options ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
      );
    } else if (def?.type === 'boolean') {
      value = (
        <Select aria-label={label('valor')} value={c.value ?? ''} onChange={set}>
          <option value="">Elige</option>
          <option value="true">Sí</option>
          <option value="false">No</option>
        </Select>
      );
    } else {
      value = <Input aria-label={label('valor')} value={c.value ?? ''} maxLength={200} list={c.field === 'source' ? 'automation-sources' : undefined} onChange={(e) => set(e.target.value)} />;
    }
  }
  return (
    <li className="grid gap-2 rounded-xl border border-line p-3 min-[700px]:grid-cols-[1fr_1fr_1.2fr_auto] min-[700px]:items-center">
      <Select aria-label={label('campo')} value={c.field} onChange={retarget}>
        {o.fields.map((f) => <option key={f.key} value={`custom:${f.key}`}>Campo: {f.name}</option>)}
        <option value="tag">Etiquetas</option>
        <option value="source">Origen</option>
        <option value="owner">Responsable</option>
        <option value="consent">Consentimiento</option>
      </Select>
      <Select aria-label={label('comparación')} value={c.op} onChange={setOp}>
        {opsFor(c.field).map((op) => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}
      </Select>
      <div>{value}</div>
      <Button variant="danger" className={small} aria-label={`Quitar la condición ${n}`} onClick={onRemove}>Quitar</Button>
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ acciones

export function ActionCard({ a, index, count, selfId, onChange, onRemove, onMove, o }: { a: Action; index: number; count: number; selfId: string | undefined; onChange: (a: Action) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; o: Options }) {
  const n = index + 1;
  const set = (patch: Partial<Action>): void => onChange({ ...a, ...patch });
  const templates = useFollowUpTemplates(a.type === 'send_template' ? (a.channel_id ?? '') : '').data?.items.filter((t) => t.sendable) ?? [];
  const chosen = templates.find((t) => t.id === a.template_id);
  const pickTemplate = (id: string): void => {
    const t = templates.find((x) => x.id === id);
    onChange({ ...a, template_id: id, params: t ? Object.fromEntries(t.variables.map((v, i) => [v.id, a.params?.[v.id] ?? (i === 0 ? '{{primer_nombre}}' : '')])) : {} });
  };
  const retype = (type: ActionType): void => onChange(type === 'create_task' ? { type, assignee: 'owner' } : type === 'send_template' ? { type, params: {} } : type === 'wait' ? { type, amount: 1, unit: 'hours' } : type === 'http_request' ? { type, method: 'POST', url: '', body: '' } : { type });
  const openStages = o.pipelines.flatMap((p) => p.stages.filter((s) => s.kind === 'open' && !s.is_hidden).map((s) => ({ id: s.id, label: o.pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name })));
  const aria = (what: string): string => `Acción ${n}: ${what}`;
  return (
    <li className="grid gap-3 rounded-xl border border-line p-3">
      <div className="grid gap-1">
        <Select aria-label={aria('qué hacer')} value={a.type} onChange={(v) => retype(v as ActionType)}>
          {ACTIONS.map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
        </Select>
        <p className="text-[12.5px] text-muted">{ACTION_HINT[a.type]}</p>
      </div>
      {a.type === 'assign_user' ? (
        <Select aria-label={aria('persona')} value={a.user_id ?? ''} onChange={(v) => set({ user_id: v })}>
          <option value="">Elige una persona</option>
          {o.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      ) : null}
      {a.type === 'assign_queue' ? (
        <Select aria-label={aria('departamento')} value={a.queue_id ?? ''} onChange={(v) => set({ queue_id: v })}>
          <option value="">Elige un departamento</option>
          {o.queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </Select>
      ) : null}
      {a.type === 'move_stage' ? (
        <Select aria-label={aria('etapa')} value={a.stage_id ?? ''} onChange={(v) => set({ stage_id: v })}>
          <option value="">Elige una etapa</option>
          {openStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
      ) : null}
      {a.type === 'set_field' ? (
        <div className="grid gap-2 min-[560px]:grid-cols-2">
          <Select aria-label={aria('campo')} value={a.field ?? ''} onChange={(v) => set({ field: v })}>
            <option value="">Elige un campo</option>
            {o.fields.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
          </Select>
          <Input aria-label={aria('valor')} value={a.value ?? ''} maxLength={500} placeholder="Valor" onChange={(e) => set({ value: e.target.value })} />
        </div>
      ) : null}
      {a.type === 'add_tag' || a.type === 'remove_tag' ? (
        <Select aria-label={aria('etiqueta')} value={a.tag_id ?? ''} onChange={(v) => set({ tag_id: v })}>
          <option value="">Elige una etiqueta</option>
          {o.customTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      ) : null}
      {a.type === 'create_task' ? (
        <div className="grid gap-2 min-[560px]:grid-cols-2">
          <div className="min-[560px]:col-span-2"><Input aria-label={aria('título de la tarea')} value={a.title ?? ''} maxLength={120} placeholder="Ej.: Llamar a {{primer_nombre}}" onChange={(e) => set({ title: e.target.value })} /></div>
          <Select aria-label={aria('para quién')} value={a.assignee ?? 'owner'} onChange={(v) => set({ assignee: v })}>
            <option value="owner">El responsable del contacto</option>
            {o.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input aria-label={aria('vence en horas')} type="number" min={0} max={720} value={a.due_in_hours ?? ''} placeholder="Vence en… horas (opcional)" onChange={(e) => { const x = { ...a }; if (e.target.value === '') delete x.due_in_hours; else x.due_in_hours = Math.max(0, Math.min(720, Math.trunc(Number(e.target.value)))); onChange(x); }} />
        </div>
      ) : null}
      {a.type === 'send_text' ? (
        <textarea aria-label={aria('texto del mensaje')} className="min-h-[84px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] text-fg" maxLength={1000} value={a.text ?? ''} placeholder="Hola {{primer_nombre}}, ¿en qué te ayudamos?" onChange={(e) => set({ text: e.target.value })} />
      ) : null}
      {a.type === 'wait' ? (
        <div className="grid gap-2 min-[560px]:grid-cols-2">
          <Input aria-label={aria('cuánto esperar')} type="number" min={1} max={43200} value={a.amount ?? ''} onChange={(e) => set({ amount: e.target.value === '' ? undefined : Math.max(1, Math.trunc(Number(e.target.value))) })} />
          <Select aria-label={aria('unidad de la espera')} value={a.unit ?? 'hours'} onChange={(v) => set({ unit: v as WaitUnit })}>
            {(Object.keys(UNIT_LABEL) as WaitUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
          </Select>
        </div>
      ) : null}
      {a.type === 'http_request' ? <HttpFields a={a} aria={aria} set={set} o={o} /> : null}
      {a.type === 'run_rule' ? (
        <Select aria-label={aria('automatización')} value={a.automation_id ?? ''} onChange={(v) => set({ automation_id: v })}>
          <option value="">Elige una automatización</option>
          {o.rules.filter((r) => r.id !== selfId).map((r) => <option key={r.id} value={r.id}>{r.name}{r.status === 'active' ? '' : r.status === 'paused' ? ' (en pausa)' : ' (borrador)'}</option>)}
        </Select>
      ) : null}
      {a.type === 'send_template' ? (
        <div className="grid gap-2">
          <Select aria-label={aria('conexión')} value={a.channel_id ?? ''} onChange={(v) => onChange({ type: 'send_template', channel_id: v, template_id: '', params: {} })}>
            <option value="">Elige una conexión de WhatsApp oficial</option>
            {o.official.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {a.channel_id ? (
            <Select aria-label={aria('plantilla')} value={a.template_id ?? ''} onChange={pickTemplate}>
              <option value="">Elige una plantilla aprobada</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          ) : null}
          {chosen ? (
            <>
              <p className="rounded-lg bg-bg px-3 py-2 text-[12.5px] text-muted">{chosen.body}</p>
              {chosen.variables.length === 0 ? <p className="text-[12.5px] text-muted">Esta plantilla no lleva variables.</p> : null}
              {chosen.variables.map((v) => (
                <Field key={v.id} label={`Valor de {{${v.key}}}`} hint="Puedes usar {{nombre}} o {{primer_nombre}}.">
                  {(f) => <Input {...f} value={a.params?.[v.id] ?? ''} maxLength={200} onChange={(e) => set({ params: { ...(a.params ?? {}), [v.id]: e.target.value } })} />}
                </Field>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button className={small} disabled={index === 0} aria-label={`Subir la acción ${n}`} onClick={() => onMove(-1)}>↑</Button>
        <Button className={small} disabled={index === count - 1} aria-label={`Bajar la acción ${n}`} onClick={() => onMove(1)}>↓</Button>
        <Button variant="danger" className={small} aria-label={`Quitar la acción ${n}`} onClick={onRemove}>Quitar</Button>
      </div>
    </li>
  );
}

/** Los datos de una llamada HTTP: método, dirección y cuerpo, con el aviso si el dominio aún no está autorizado. */
function HttpFields({ a, aria, set, o }: { a: Action; aria: (what: string) => string; set: (p: Partial<Action>) => void; o: Options }) {
  const method = a.method ?? 'POST';
  const host = hostOf(a.url);
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 min-[560px]:grid-cols-[8rem_1fr]">
        <Select aria-label={aria('método')} value={method} onChange={(v) => set({ method: v as 'GET' | 'POST' })}>
          <option value="POST">POST</option>
          <option value="GET">GET</option>
        </Select>
        <Input aria-label={aria('dirección')} value={a.url ?? ''} maxLength={2000} placeholder="https://hooks.ejemplo.com/..." onChange={(e) => set({ url: e.target.value })} />
      </div>
      {a.url && a.url.trim() !== '' && host && !hostCovered(host, o.allowedHosts) ? <p role="alert" className="text-[12.5px] font-semibold text-[var(--crit,#b42318)]">El dominio {host} aún no está autorizado: agrégalo en «Destinos permitidos» (arriba, en la lista de automatizaciones).</p> : null}
      {method === 'POST' ? (
        <label className="grid gap-1 text-[13px] font-semibold">
          Cuerpo (JSON, opcional)
          <textarea aria-label={aria('cuerpo')} className="min-h-[84px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 font-mono text-[13px] font-normal text-fg" maxLength={4000} value={a.body ?? ''} placeholder={'{"nombre": "{{nombre}}", "telefono": "{{telefono}}"}'} onChange={(e) => set({ body: e.target.value })} />
          <span className="text-[12px] font-normal text-muted">Variables: {HTTP_VARIABLE_HELP.join(', ')}. Ponlas entre comillas. Salen datos personales del contacto hacia ese dominio.</span>
        </label>
      ) : null}
    </div>
  );
}

/** El dominio de una dirección (null si todavía no es una dirección válida: se está escribiendo). */
function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}
