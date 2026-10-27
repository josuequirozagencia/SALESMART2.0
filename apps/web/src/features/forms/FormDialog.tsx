import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useChannels } from '../channels/useChannels';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { Tabs } from '../crm/Tabs';
import { usePipelines } from '../pipelines/usePipelines';
import { useQueues } from '../queues/useQueues';
import { useTags } from '../tags/useTags';
import { useFollowUpTemplates, useForm, useFormMutations, useFormSubmissions, type FieldKind, type FormDetail, type FormField } from './useForms';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const areaCls = 'min-h-[84px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] font-normal text-fg';
type TabKey = 'fields' | 'destination' | 'follow' | 'publish' | 'submissions';

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

/** Un texto de código listo para copiar (el que se pega en la página del cliente). */
function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin permiso del portapapeles: el código sigue visible para copiarlo a mano */
    }
  };
  return (
    <div className="grid gap-1">
      <span className="flex items-center justify-between gap-2 text-[12.5px] font-semibold">{label}<Button className="!px-3 !py-1 !text-[12px]" aria-label={`Copiar ${label}`} onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</Button></span>
      <pre aria-label={label} className="max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface2 p-3 font-mono text-[12px]">{code}</pre>
    </div>
  );
}

/** Seguimiento: qué pasa con cada lead apenas llena el formulario. */
function FollowUpTab({ form }: { form: FormDetail }) {
  const m = useFormMutations();
  const channels = (useChannels().data?.items ?? []).filter((c) => c.status === 'active' && c.provider === 'meta_cloud');
  const [task, setTask] = useState(form.follow_up.task);
  const [channel, setChannel] = useState(form.follow_up.channel_id ?? '');
  const [template, setTemplate] = useState(form.follow_up.template_id ?? '');
  const [params, setParams] = useState<Record<string, string>>(form.follow_up.params);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const templates = (useFollowUpTemplates(channel).data?.items ?? []).filter((t) => t.sendable);
  const chosen = templates.find((t) => t.id === template);
  const pick = (id: string): void => {
    setOk(false);
    setTemplate(id);
    const t = templates.find((x) => x.id === id);
    // Valores iniciales: el primer dato lleva el primer nombre de quien llenó el formulario
    setParams(t ? Object.fromEntries(t.variables.map((v, i) => [v.id, params[v.id] ?? (i === 0 ? '{{primer_nombre}}' : '')])) : {});
  };
  const save = async (): Promise<void> => {
    setOk(false);
    setError(undefined);
    if (template && chosen && chosen.variables.some((v) => (params[v.id] ?? '').trim() === '')) return setError('Escribe un valor para cada variable de la plantilla.');
    try {
      await m.update.mutateAsync({ id: form.id, patch: { follow_up_task: task, follow_up_channel_id: template ? channel : null, follow_up_template_id: template || null, follow_up_params: template ? params : {} } });
      setOk(true);
    } catch (e) {
      setError(reason(e, 'No pudimos guardar el seguimiento.'));
    }
  };
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Qué pasa con cada persona apenas llena el formulario, además de quedar como contacto con su oportunidad.</p>
      <section aria-label="Tarea para el responsable" className="grid gap-2">
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={task} onChange={(e) => { setOk(false); setTask(e.target.checked); }} />Crear una tarea para el responsable del lead (vence en 1 hora)</label>
        <p className="text-[12.5px] text-muted">Es el aviso al asesor. Si no hay responsable (la cola no reparte), no se crea.</p>
      </section>
      <section aria-label="Plantilla de WhatsApp" className="grid gap-3">
        <h3 className="text-[13.5px] font-bold">Escribirle por WhatsApp con una plantilla</h3>
        <p className="text-[12.5px] text-muted">La primera vez hay que escribirle con una plantilla aprobada por Meta. Si la conexión tiene un agente de IA activo, atenderá lo que el lead conteste. Si la plantilla no se puede enviar, el lead no se pierde: queda la tarea.</p>
        {channels.length === 0 ? <Alert kind="info">Aún no tienes una conexión de WhatsApp oficial activa. Conéctala en Configuración › Conexiones.</Alert> : (
          <>
            <Field label="Conexión">
              {(f) => <select {...f} className={selectCls} value={channel} onChange={(e) => { setOk(false); setChannel(e.target.value); setTemplate(''); setParams({}); }}><option value="">Sin plantilla</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
            </Field>
            {channel ? (
              <Field label="Plantilla" hint="Solo se ofrecen las aprobadas y que se pueden enviar.">
                {(f) => <select {...f} className={selectCls} value={template} onChange={(e) => pick(e.target.value)}><option value="">Elige una plantilla</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}</select>}
              </Field>
            ) : null}
            {chosen ? (
              <div className="grid gap-2 rounded-xl border border-line p-3">
                <p className="text-[12.5px]"><b>Texto:</b> {chosen.body}</p>
                {chosen.variables.length === 0 ? <p className="text-[12.5px] text-muted">Esta plantilla no lleva variables.</p> : null}
                {chosen.variables.map((v) => (
                  <Field key={v.id} label={`Variable «${v.key}»${v.part === 'header' ? ' (encabezado)' : v.part === 'button' ? ' (botón)' : ''}`} hint={'Puedes usar {{nombre}}, {{primer_nombre}} y {{formulario}}.' + (v.example ? ` Ejemplo de Meta: ${v.example}` : '')}>
                    {(f) => <Input {...f} value={params[v.id] ?? ''} maxLength={200} onChange={(e) => { setOk(false); setParams((cur) => ({ ...cur, [v.id]: e.target.value })); }} />}
                  </Field>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>
      <div><Button variant="primary" loading={m.update.isPending} onClick={() => void save()}>Guardar seguimiento</Button></div>
      <Result ok={ok} error={error} />
    </div>
  );
}

/** Publicar, pausar o borrar, los dominios desde los que se acepta el envío y el código para ponerlo en la página. */
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
  const origin = window.location.origin;
  const definition = `${origin}/v1/public/forms/${form.public_token}`;
  const page = `${definition}/page`;
  const script = `<script src="${origin}/v1/embed/v1.js" data-form="${form.public_token}" async></script>`;
  const iframe = `<iframe src="${page}" title="${form.name.replace(/["<>&]/g, '')}" width="100%" height="640" style="border:0" loading="lazy"></iframe>`;
  const pixel = `<script>\nwindow.addEventListener('salesmart:lead', function (e) {\n  if (window.fbq) fbq('track', 'Lead', {}, { eventID: e.detail.event_id });\n});\n</script>`;
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
      <section aria-label="Código para tu página" className="grid gap-3">
        <h3 className="text-[13.5px] font-bold">Ponlo en tu página</h3>
        {form.status !== 'published' ? <Alert kind="info">Publica el formulario para que reciba envíos desde tu página.</Alert> : null}
        <CodeBlock label="Código para incrustar (recomendado)" code={script} />
        <p className="text-[12.5px] text-muted">Pégalo donde quieras que aparezca. El formulario se dibuja aislado del estilo de tu página y solo funciona en los dominios autorizados.</p>
        <CodeBlock label="Código de iframe" code={iframe} />
        <CopyField label="Enlace directo al formulario" value={page} />
        <CodeBlock label="Para medir con el Pixel de Meta (opcional)" code={pixel} />
        <p className="text-[12.5px] text-muted">Con el código para incrustar, tu página recibe el evento «salesmart:lead» con el identificador que también enviamos a Meta: así el Pixel y la API de Conversiones cuentan el mismo lead una sola vez. En un iframe el navegador no comparte las cookies de tu sitio, así que la coincidencia es menor.</p>
        <CopyField label="Dirección pública del formulario" value={definition} />
        <p className="text-[12.5px] text-muted">Esa dirección solo permite leer el formulario y enviarlo; no da acceso a nada más.</p>
      </section>
      {form.status === 'published' ? (
        <section aria-label="Vista previa" className="grid gap-2">
          <h3 className="text-[13.5px] font-bold">Vista previa</h3>
          <iframe title="Vista previa del formulario" src={page} className="h-[520px] w-full rounded-xl border border-line bg-white" />
        </section>
      ) : null}
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
          <Tabs label="Secciones del formulario" tabs={[['fields', 'Campos'], ['destination', 'Destino'], ['follow', 'Seguimiento'], ['publish', 'Publicación'], ['submissions', 'Envíos']] as const} active={tab} onChange={setTab} />
          {tab === 'fields' ? <FieldsTab key={f.id} form={f} /> : null}
          {tab === 'destination' ? <DestinationTab form={f} /> : null}
          {tab === 'follow' ? <FollowUpTab form={f} /> : null}
          {tab === 'publish' ? <PublishTab form={f} onDeleted={onClose} /> : null}
          {tab === 'submissions' ? <SubmissionsTab form={f} /> : null}
        </div>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
