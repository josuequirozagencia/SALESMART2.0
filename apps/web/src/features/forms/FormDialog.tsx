import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { Tabs } from '../crm/Tabs';
import { usePipelines } from '../pipelines/usePipelines';
import { useQueues } from '../queues/useQueues';
import { useTags } from '../tags/useTags';
import { useForm, useFormMutations, useFormSubmissions, type FieldKind, type FormDetail, type FormField } from './useForms';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const areaCls = 'min-h-[84px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] font-normal text-fg';
type TabKey = 'fields' | 'destination' | 'publish' | 'submissions';

export const STATUS_LABEL = { draft: 'Borrador', published: 'Publicado', paused: 'Pausado' } as const;
export const STATUS_KIND = { draft: 'muted', published: 'ok', paused: 'warn' } as const;
/** El motivo de un rechazo: si el servidor detalla qué campos no valen (en español, pensado para la persona), eso; si no, el mensaje habitual. */
function reason(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.details.length > 0) return e.details.map((d) => d.message).join(' ');
  return friendlyError(e, fallback);
}

const KIND_LABEL: Record<FieldKind, string> = { text: 'Texto corto', long_text: 'Texto largo', email: 'Correo', phone: 'Teléfono', number: 'Número', select: 'Lista de opciones' };

function Result({ ok, error }: { ok: boolean; error: string | undefined }) {
  if (error) return <Alert>{error}</Alert>;
  return ok ? <Alert kind="ok">Cambios guardados.</Alert> : null;
}

/** Los campos del formulario: nombre y teléfono son fijos (un lead sin ellos no sirve); lo demás se agrega, se ordena y se asigna a un dato del contacto. */
function FieldsTab({ form }: { form: FormDetail }) {
  const m = useFormMutations();
  const custom = useCustomFields().data?.items ?? [];
  const [rows, setRows] = useState<FormField[]>(form.fields);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const fixed = (r: FormField): boolean => r.maps_to === 'name' || r.maps_to === 'phone';
  const change = (i: number, patch: Partial<FormField>): void => {
    setOk(false);
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const retarget = (i: number, mapsTo: string): void => {
    const kind: Partial<FormField> = mapsTo === 'phone' ? { kind: 'phone' } : mapsTo === 'email' ? { kind: 'email' } : mapsTo === 'name' ? { kind: 'text' } : rows[i]!.kind === 'phone' || rows[i]!.kind === 'email' ? { kind: 'text' } : {};
    change(i, { maps_to: mapsTo, ...kind });
  };
  const move = (i: number, d: -1 | 1): void => {
    setOk(false);
    setRows((cur) => {
      const next = [...cur];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });
  };
  const save = async (): Promise<void> => {
    setOk(false);
    setError(undefined);
    try {
      await m.setFields.mutateAsync({ id: form.id, fields: rows.map((r) => ({ ...r, options: r.kind === 'select' ? (r.options ?? []).filter((o) => o.trim() !== '') : null })) });
      setOk(true);
    } catch (e) {
      setError(reason(e, 'No pudimos guardar los campos.'));
    }
  };
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">El nombre y el WhatsApp son obligatorios. Cada campo se guarda en el dato del contacto que elijas; «solo guardar en el envío» lo deja únicamente en lo recibido.</p>
      <ol aria-label="Campos del formulario" className="grid gap-2">
        {rows.map((r, i) => (
          <li key={r.id ?? `new-${i}`} className="grid gap-2 rounded-xl border border-line p-3">
            <div className="grid gap-2 min-[560px]:grid-cols-2">
              <Field label="Etiqueta">{(f) => <Input {...f} value={r.label} maxLength={100} onChange={(e) => change(i, { label: e.target.value })} />}</Field>
              <Field label="Se guarda en">
                {(f) => (
                  <select {...f} className={selectCls} value={r.maps_to} disabled={fixed(r)} onChange={(e) => retarget(i, e.target.value)}>
                    {fixed(r) ? <option value={r.maps_to}>{r.maps_to === 'name' ? 'Nombre del contacto' : 'Teléfono del contacto'}</option> : null}
                    {!fixed(r) ? <option value="email">Correo del contacto</option> : null}
                    {!fixed(r) ? <option value="note">Solo guardar en el envío</option> : null}
                    {!fixed(r) ? custom.map((c) => <option key={c.key} value={`custom:${c.key}`}>Campo: {c.name}</option>) : null}
                  </select>
                )}
              </Field>
              <Field label="Tipo">
                {(f) => (
                  <select {...f} className={selectCls} value={r.kind} disabled={fixed(r) || r.maps_to === 'email'} onChange={(e) => change(i, { kind: e.target.value as FieldKind, options: e.target.value === 'select' ? (r.options ?? ['']) : null })}>
                    {(Object.keys(KIND_LABEL) as FieldKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Texto de ayuda (opcional)">{(f) => <Input {...f} value={r.placeholder ?? ''} maxLength={100} onChange={(e) => change(i, { placeholder: e.target.value })} />}</Field>
            </div>
            {r.kind === 'select' ? (
              <Field label="Opciones" hint="Una por línea.">{(f) => <textarea {...f} className={areaCls} value={(r.options ?? []).join('\n')} onChange={(e) => change(i, { options: e.target.value.split('\n') })} />}</Field>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={r.required} disabled={fixed(r)} onChange={(e) => change(i, { required: e.target.checked })} />Obligatorio</label>
              <span className="ml-auto flex gap-1.5">
                <Button className="!px-3 !py-1.5 !text-[12.5px]" disabled={i === 0} aria-label={`Subir «${r.label}»`} onClick={() => move(i, -1)}>↑</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" disabled={i === rows.length - 1} aria-label={`Bajar «${r.label}»`} onClick={() => move(i, 1)}>↓</Button>
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" disabled={fixed(r)} aria-label={`Quitar «${r.label}»`} onClick={() => { setOk(false); setRows((cur) => cur.filter((_, j) => j !== i)); }}>Quitar</Button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button disabled={rows.length >= 30} onClick={() => { setOk(false); setRows((cur) => [...cur, { kind: 'text', label: 'Nuevo campo', maps_to: 'note', required: false, options: null }]); }}>Agregar campo</Button>
        <Button variant="primary" loading={m.setFields.isPending} onClick={() => void save()}>Guardar campos</Button>
      </div>
      <Result ok={ok} error={error} />
    </div>
  );
}

/** Adónde va cada lead: la cola que lo reparte, el pipeline y la etapa donde queda su oportunidad, una etiqueta extra y lo que ve la persona al enviar. */
function DestinationTab({ form }: { form: FormDetail }) {
  const m = useFormMutations();
  const queues = useQueues().data?.items ?? [];
  const pipelines = usePipelines().data?.items ?? [];
  const tags = (useTags().data?.items ?? []).filter((t) => !t.is_system);
  const [queue, setQueue] = useState(form.queue_id ?? '');
  const [pipeline, setPipeline] = useState(form.pipeline_id ?? '');
  const [stage, setStage] = useState(form.stage_id ?? '');
  const [tag, setTag] = useState(form.extra_tag_id ?? '');
  const [consent, setConsent] = useState(form.consent_text);
  const [thanks, setThanks] = useState(form.thanks_message);
  const [redirect, setRedirect] = useState(form.redirect_url ?? '');
  const [prefix, setPrefix] = useState(form.phone_prefix);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const stages = (pipelines.find((p) => p.id === pipeline)?.stages ?? []).filter((s) => s.kind === 'open' && !s.is_hidden);
  const save = async (): Promise<void> => {
    setOk(false);
    setError(undefined);
    if (consent.trim().length < 10) return setError('Escribe el texto del consentimiento (al menos 10 caracteres).');
    if (thanks.trim().length === 0) return setError('Escribe el mensaje de agradecimiento.');
    try {
      await m.update.mutateAsync({ id: form.id, patch: { queue_id: queue || null, pipeline_id: pipeline || null, stage_id: pipeline && stage ? stage : null, extra_tag_id: tag || null, consent_text: consent.trim(), thanks_message: thanks.trim(), redirect_url: redirect.trim() || null, phone_prefix: prefix.trim() } });
      setOk(true);
    } catch (e) {
      setError(reason(e, 'No pudimos guardar el destino.'));
    }
  };
  return (
    <div className="grid gap-3">
      <section aria-label="Destino del lead" className="grid gap-3">
        <Field label="Cola" hint="Reparte el lead a un asesor con la regla de la cola. Sin cola, queda sin responsable.">
          {(f) => <select {...f} className={selectCls} value={queue} onChange={(e) => { setOk(false); setQueue(e.target.value); }}><option value="">Sin cola</option>{queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select>}
        </Field>
        <div className="grid gap-3 min-[560px]:grid-cols-2">
          <Field label="Pipeline" hint="Donde se abre la oportunidad.">
            {(f) => <select {...f} className={selectCls} value={pipeline} onChange={(e) => { setOk(false); setPipeline(e.target.value); setStage(''); }}><option value="">El primer pipeline</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          </Field>
          <Field label="Etapa">
            {(f) => <select {...f} className={selectCls} value={stage} disabled={!pipeline} onChange={(e) => { setOk(false); setStage(e.target.value); }}><option value="">La primera etapa abierta</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          </Field>
        </div>
        <Field label="Etiqueta adicional" hint="Además de «Lead», que se pone sola.">
          {(f) => <select {...f} className={selectCls} value={tag} onChange={(e) => { setOk(false); setTag(e.target.value); }}><option value="">Ninguna</option>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
        </Field>
      </section>
      <section aria-label="Lo que ve quien envía" className="grid gap-3">
        <Field label="Texto del consentimiento" required hint="Se muestra junto a una casilla que la persona debe marcar.">{(f) => <textarea {...f} className={areaCls} value={consent} maxLength={500} onChange={(e) => { setOk(false); setConsent(e.target.value); }} />}</Field>
        <Field label="Mensaje de agradecimiento" required>{(f) => <Input {...f} value={thanks} maxLength={300} onChange={(e) => { setOk(false); setThanks(e.target.value); }} />}</Field>
        <Field label="Redirigir después de enviar (opcional)" hint="Debe empezar con https://. Si lo dejas vacío, se muestra el mensaje.">{(f) => <Input {...f} type="url" value={redirect} maxLength={500} onChange={(e) => { setOk(false); setRedirect(e.target.value); }} />}</Field>
        <Field label="Prefijo de teléfono" hint="Se usa cuando la persona escribe su número sin código de país. Ecuador: +593.">{(f) => <Input {...f} value={prefix} maxLength={5} onChange={(e) => { setOk(false); setPrefix(e.target.value); }} />}</Field>
      </section>
      <div><Button variant="primary" loading={m.update.isPending} onClick={() => void save()}>Guardar destino</Button></div>
      <Result ok={ok} error={error} />
    </div>
  );
}

/** Publicar, pausar o borrar, y los dominios desde los que se acepta el envío. */
function PublishTab({ form, onDeleted }: { form: FormDetail; onDeleted: () => void }) {
  const m = useFormMutations();
  const [domains, setDomains] = useState(form.allowed_domains.join('\n'));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const run = async (fn: () => Promise<unknown>, fallback: string): Promise<void> => {
    setOk(false);
    setError(undefined);
    try {
      await fn();
      setOk(true);
    } catch (e) {
      setError(reason(e, fallback));
    }
  };
  const saveDomains = (): Promise<void> => run(() => m.update.mutateAsync({ id: form.id, patch: { allowed_domains: domains.split('\n').map((d) => d.trim()).filter(Boolean) } }), 'No pudimos guardar los dominios.');
  const definition = `${window.location.origin}/v1/public/forms/${form.public_token}`;
  return (
    <div className="grid gap-4">
      <section aria-label="Estado" className="grid gap-2">
        <p className="flex flex-wrap items-center gap-2 text-[13.5px]">Estado: <Pill kind={STATUS_KIND[form.status]}>{STATUS_LABEL[form.status]}</Pill>{form.status === 'published' ? <span className="text-muted">Recibe envíos.</span> : <span className="text-muted">No recibe envíos.</span>}</p>
        {form.missing.length > 0 ? <Alert kind="info">Para publicarlo: {form.missing.join('; ')}.</Alert> : null}
        <div className="flex flex-wrap gap-2">
          {form.status !== 'published' ? <Button variant="primary" loading={m.publish.isPending} onClick={() => void run(() => m.publish.mutateAsync(form.id), 'No pudimos publicar el formulario.')}>Publicar</Button> : <Button loading={m.pause.isPending} onClick={() => void run(() => m.pause.mutateAsync(form.id), 'No pudimos pausar el formulario.')}>Pausar</Button>}
        </div>
      </section>
      <section aria-label="Dominios autorizados" className="grid gap-2">
        <Field label="Dominios desde los que se acepta" hint="Uno por línea: «mi-sitio.com» o «*.mi-sitio.com» (con sus subdominios). Solo esas páginas podrán enviar el formulario.">
          {(f) => <textarea {...f} className={areaCls} value={domains} placeholder="mi-sitio.com" onChange={(e) => { setOk(false); setDomains(e.target.value); }} />}
        </Field>
        <div><Button loading={m.update.isPending} onClick={() => void saveDomains()}>Guardar dominios</Button></div>
      </section>
      <section aria-label="Identificador público" className="grid gap-2">
        <CopyField label="Dirección pública del formulario" value={definition} />
        <p className="text-[12.5px] text-muted">El código para incrustarlo en tu página llega en el siguiente paso. Esta dirección solo permite leer el formulario y enviarlo; no da acceso a nada más.</p>
      </section>
      <Result ok={ok} error={error} />
      <section aria-label="Borrar" className="grid gap-2 border-t border-line pt-3">
        {confirm ? (
          <p className="flex flex-wrap items-center gap-2 text-[13px]">¿Borrar este formulario? Deja de recibir envíos y lo recibido se conserva en los contactos.
            <Button variant="danger" loading={m.remove.isPending} onClick={() => void run(async () => { await m.remove.mutateAsync(form.id); onDeleted(); }, 'No pudimos borrar el formulario.')}>Sí, borrar</Button>
            <Button onClick={() => setConfirm(false)}>No</Button>
          </p>
        ) : <div><Button variant="danger" onClick={() => setConfirm(true)}>Borrar formulario</Button></div>}
      </section>
    </div>
  );
}

function SubmissionsTab({ form }: { form: FormDetail }) {
  const q = useFormSubmissions(form.id, true);
  const items = q.data?.items ?? [];
  return (
    <div className="grid gap-3">
      {q.isLoading ? <Spinner label="Cargando envíos" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los envíos.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Todavía no hay envíos.</p> : null}
      {items.length > 0 ? (
        <ul aria-label="Envíos recibidos" className="grid gap-2">
          {items.map((s) => (
            <li key={s.id} className="grid gap-1 rounded-xl border border-line p-3 text-[13px]">
              <span className="flex flex-wrap items-center gap-2"><b>{s.contact.name}</b>{s.contact_created ? <Pill kind="ok">Contacto nuevo</Pill> : <Pill kind="muted">Ya existía</Pill>}<time dateTime={s.at} className="text-muted">{new Date(s.at).toLocaleString('es-EC')}</time></span>
              {s.source_url ? <span className="truncate text-[12px] text-muted">Desde {s.source_url}</span> : null}
              {Object.keys(s.utm).length > 0 ? <span className="text-[12px] text-muted">{Object.entries(s.utm).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Un formulario abierto: sus campos, su destino, su publicación y lo recibido. */
export function FormDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useForm(id);
  const [tab, setTab] = useState<TabKey>('fields');
  const f = q.data;
  return (
    <Modal title={f ? f.name : 'Formulario'} onClose={onClose} wide>
      {q.isLoading ? <Spinner label="Cargando formulario" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar el formulario.')}</Alert> : null}
      {f ? (
        <div className="grid gap-3">
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted"><Pill kind={STATUS_KIND[f.status]}>{STATUS_LABEL[f.status]}</Pill>{f.submissions} {f.submissions === 1 ? 'envío' : 'envíos'}</p>
          <Tabs label="Secciones del formulario" tabs={[['fields', 'Campos'], ['destination', 'Destino'], ['publish', 'Publicación'], ['submissions', 'Envíos']] as const} active={tab} onChange={setTab} />
          {tab === 'fields' ? <FieldsTab key={f.id} form={f} /> : null}
          {tab === 'destination' ? <DestinationTab form={f} /> : null}
          {tab === 'publish' ? <PublishTab form={f} onDeleted={onClose} /> : null}
          {tab === 'submissions' ? <SubmissionsTab form={f} /> : null}
        </div>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
