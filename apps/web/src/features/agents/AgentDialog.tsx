import { useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { Tabs } from '../crm/Tabs';
import { Avatar, COVER_CLASS, COVER_LABEL } from './agentUi';
import { useAgent, useAgentMutations, useAgentOptions, useContactSearch, type Agent, type AgentOptions, type AgentPatch, type Cover, type TestTurn } from './useAgents';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const areaCls = 'min-h-[96px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] font-normal text-fg';
type TabKey = 'general' | 'instructions' | 'knowledge' | 'behavior' | 'test';

/** El resultado de guardar: «Cambios guardados.» o el motivo del servidor. */
function Result({ ok, error }: { ok: boolean; error: string | undefined }) {
  if (error) return <Alert>{error}</Alert>;
  return ok ? <Alert kind="ok">Cambios guardados.</Alert> : null;
}

function GeneralTab({ a, o }: { a: Agent; o: AgentOptions }) {
  const m = useAgentMutations();
  const [name, setName] = useState(a.name);
  const [role, setRole] = useState(a.role ?? '');
  const [cover, setCover] = useState<Cover>(a.cover);
  const [model, setModel] = useState(a.model);
  const [temperature, setTemperature] = useState(String(a.temperature));
  const [maxTokens, setMaxTokens] = useState(String(a.max_tokens));
  const [maxChars, setMaxChars] = useState(String(a.max_chars));
  const [active, setActive] = useState(a.active);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const models = o.models.includes(a.model) ? o.models : [a.model, ...o.models];

  const save = (): void => {
    setOk(false);
    const t = Number(temperature);
    const tk = Number(maxTokens);
    const mc = Number(maxChars);
    if (name.trim().length === 0) return setError('Escribe el nombre del agente.');
    if (!(t >= 0 && t <= 1.5)) return setError('La creatividad debe estar entre 0 y 1,5.');
    if (!Number.isInteger(tk) || tk < 100 || tk > 2000) return setError('El tope de palabras por respuesta debe ser un número entre 100 y 2000.');
    if (!Number.isInteger(mc) || mc < 100 || mc > 4000) return setError('El largo máximo de cada respuesta debe estar entre 100 y 4000 caracteres.');
    setError(undefined);
    const patch: AgentPatch = { name: name.trim(), role: role.trim() || null, cover, model, temperature: t, max_tokens: tk, max_chars: mc, active };
    m.update.mutate({ id: a.id, patch }, { onSuccess: () => setOk(true), onError: (e) => setError(friendlyError(e, 'No pudimos guardar los cambios.')) });
  };
  const upload = (f: File | undefined): void => {
    if (!f) return;
    setError(undefined);
    m.uploadPhoto.mutate({ id: a.id, file: f }, { onError: (e) => setError(friendlyError(e, 'No pudimos subir la foto.')) });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={a.name} url={a.photo_url} size={72} />
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Elegir foto" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        <Button loading={m.uploadPhoto.isPending} onClick={() => file.current?.click()}>{a.photo_url ? 'Cambiar foto' : 'Subir foto'}</Button>
        {a.photo_url ? <Button loading={m.removePhoto.isPending} onClick={() => m.removePhoto.mutate(a.id, { onError: (e) => setError(friendlyError(e, 'No pudimos quitar la foto.')) })}>Quitar foto</Button> : null}
        <span className="text-[12px] text-muted">JPEG, PNG o WebP, hasta {Math.floor(o.limits.max_photo_bytes / (1024 * 1024))} MB</span>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="Nombre" required>{(f) => <Input {...f} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="¿Qué hace?">{(f) => <Input {...f} value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} />}</Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-[12.5px] font-semibold">Color de la tarjeta</legend>
        <div className="flex flex-wrap gap-2">
          {o.covers.map((c) => (
            <label key={c} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${cover === c ? 'border-accent' : 'border-line'}`}>
              <input type="radio" name="cover" className="sr-only" checked={cover === c} onChange={() => setCover(c)} aria-label={COVER_LABEL[c]} />
              <span className={`size-4 rounded-full ${COVER_CLASS[c]} border border-line`} />{COVER_LABEL[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="Modelo de IA">{(f) => <select {...f} className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((x) => <option key={x} value={x}>{x}</option>)}</select>}</Field>
        <Field label="Creatividad (0 a 1,5)" hint="Más bajo = respuestas más predecibles.">{(f) => <Input {...f} inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} />}</Field>
        <Field label="Tope de palabras por respuesta (100 a 2000)">{(f) => <Input {...f} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />}</Field>
        <Field label="Largo máximo de cada respuesta (caracteres)">{(f) => <Input {...f} inputMode="numeric" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} />}</Field>
      </div>
      <section aria-label="Estado del agente" className="grid gap-2 rounded-xl border border-line p-3">
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Agente activo
        </label>
        <ul className="grid gap-1 text-[12.5px]">
          <li>{a.readiness.instructions ? <Pill kind="ok">Listo</Pill> : <Pill kind="warn">Falta</Pill>} Instrucciones (personalidad u objetivo)</li>
          <li>{a.readiness.documents ? <Pill kind="ok">Listo</Pill> : <Pill kind="warn">Falta</Pill>} Documentos que puede usar</li>
          <li>{a.readiness.channel ? <Pill kind="ok">Listo</Pill> : <Pill kind="warn">Falta</Pill>} Conexión donde responde</li>
        </ul>
        <p className="text-[12px] text-muted">Un agente necesita instrucciones para activarse. Contestará mensajes cuando esa función esté disponible.</p>
      </section>
      <Result ok={ok} error={error} />
      <div><Button variant="primary" loading={m.update.isPending} onClick={save}>Guardar</Button></div>
    </div>
  );
}

function InstructionsTab({ a, o }: { a: Agent; o: AgentOptions }) {
  const m = useAgentMutations();
  const [texts, setTexts] = useState({ personality: a.personality, objective: a.objective, extra_info: a.extra_info });
  const [last, setLast] = useState<keyof typeof texts>('personality');
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const [search, setSearch] = useState('');
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const refs = { personality: useRef<HTMLTextAreaElement>(null), objective: useRef<HTMLTextAreaElement>(null), extra_info: useRef<HTMLTextAreaElement>(null) };
  const found = useContactSearch(contact ? '' : search);

  const insert = (key: string): void => {
    const el = refs[last].current;
    const token = `{{${key}}}`;
    const at = el?.selectionStart ?? texts[last].length;
    const end = el?.selectionEnd ?? at;
    setTexts((t) => ({ ...t, [last]: `${t[last].slice(0, at)}${token}${t[last].slice(end)}` }));
    el?.focus();
  };
  const save = (): void => {
    setOk(false);
    setError(undefined);
    m.update.mutate({ id: a.id, patch: texts }, { onSuccess: () => setOk(true), onError: (e) => setError(friendlyError(e, 'No pudimos guardar las instrucciones.')) });
  };
  const preview = (): void => {
    setError(undefined);
    m.preview.mutate({ agent_id: a.id, ...texts, contact_id: contact?.id ?? null }, { onError: (e) => setError(friendlyError(e, 'No pudimos armar la vista previa.')) });
  };
  const blocks: Array<{ key: keyof typeof texts; label: string; hint: string; max: number }> = [
    { key: 'personality', label: 'Personalidad', hint: 'Cómo habla: tono, trato, estilo.', max: 4000 },
    { key: 'objective', label: 'Objetivo', hint: 'Qué debe lograr en cada conversación.', max: 4000 },
    { key: 'extra_info', label: 'Información adicional', hint: 'Datos que siempre debe tener presentes.', max: 8000 },
  ];

  return (
    <div className="grid gap-4">
      {blocks.map((b) => (
        <Field key={b.key} label={b.label} hint={b.hint}>
          {(f) => <textarea {...f} ref={refs[b.key]} className={areaCls} value={texts[b.key]} maxLength={b.max} onFocus={() => setLast(b.key)} onChange={(e) => setTexts((t) => ({ ...t, [b.key]: e.target.value }))} />}
        </Field>
      ))}
      <section aria-label="Variables" className="grid gap-2">
        <h3 className="text-[12.5px] font-semibold">Variables (se llenan con los datos de cada cliente)</h3>
        <div className="flex flex-wrap gap-1.5">
          {o.variables.map((v) => <button key={v.key} type="button" title={v.label} onClick={() => insert(v.key)} className="rounded-full border border-line px-2.5 py-1 text-[12px] hover:border-accent">{`{{${v.key}}}`}</button>)}
        </div>
      </section>
      <Result ok={ok} error={error} />
      <div><Button variant="primary" loading={m.update.isPending} onClick={save}>Guardar instrucciones</Button></div>
      <section aria-label="Vista previa" className="grid gap-3 rounded-xl border border-line p-3">
        <h3 className="text-[13.5px] font-bold">Vista previa</h3>
        <p className="text-[12.5px] text-muted">Mira exactamente lo que recibiría el agente, con las variables llenas. No usa créditos. Puedes probar con un contacto tuyo o con un ejemplo.</p>
        {contact ? (
          <p className="flex flex-wrap items-center gap-2 text-[13px]">Contacto: <b>{contact.name}</b><Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setContact(null)}>Quitar</Button></p>
        ) : (
          <div className="grid gap-1.5">
            <Input aria-label="Buscar un contacto" type="search" placeholder="Buscar un contacto para probar (opcional)…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.data && found.data.items.length > 0 ? <ul aria-label="Contactos encontrados" className="flex flex-wrap gap-1.5">{found.data.items.map((c) => <li key={c.id}><button type="button" onClick={() => { setContact(c); setSearch(''); }} className="rounded-full border border-line px-2.5 py-1 text-[12px] hover:border-accent">{c.name}</button></li>)}</ul> : null}
          </div>
        )}
        <div><Button loading={m.preview.isPending} onClick={preview}>Ver vista previa</Button></div>
        {m.preview.data ? (
          <div className="grid gap-2">
            {m.preview.data.unknown.length > 0 ? <Alert>Estas variables no existen o no se permiten: {m.preview.data.unknown.map((v) => `{{${v}}}`).join(', ')}</Alert> : null}
            {m.preview.data.missing.length > 0 ? <Alert kind="info">Este contacto no tiene datos para: {m.preview.data.missing.map((v) => `{{${v}}}`).join(', ')}</Alert> : null}
            <pre aria-label="Mensaje de sistema" className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-xl bg-surface2 p-3 text-[12.5px]">{m.preview.data.system}</pre>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function KnowledgeTab({ a, o }: { a: Agent; o: AgentOptions }) {
  const m = useAgentMutations();
  const [ids, setIds] = useState<string[]>(a.document_ids);
  const [showSource, setShowSource] = useState(a.show_source);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const total = o.documents.filter((d) => ids.includes(d.id)).reduce((n, d) => n + d.chunk_count, 0);
  const toggle = (id: string): void => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async (): Promise<void> => {
    setOk(false);
    setError(undefined);
    try {
      await m.setDocuments.mutateAsync({ id: a.id, ids });
      if (showSource !== a.show_source) await m.update.mutateAsync({ id: a.id, patch: { show_source: showSource } });
      setOk(true);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos guardar los documentos.'));
    }
  };
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Elige los documentos de tu biblioteca que este agente puede usar para responder. Sube y administra documentos en Configuración › Conocimiento.</p>
      {o.documents.length === 0 ? <Alert kind="info">Tu biblioteca está vacía. Sube documentos en Configuración › Conocimiento.</Alert> : null}
      <ul aria-label="Documentos de la biblioteca" className="grid gap-1.5">
        {o.documents.map((d) => (
          <li key={d.id}>
            <label className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-[13.5px]">
              <input type="checkbox" checked={ids.includes(d.id)} onChange={() => toggle(d.id)} aria-label={`Usar «${d.name}»`} />
              <span className="min-w-0 flex-1 truncate font-semibold">{d.name}</span>
              <span className="text-[12px] text-muted">{d.chunk_count} {d.chunk_count === 1 ? 'fragmento' : 'fragmentos'}</span>
              {d.status !== 'ready' ? <Pill kind="warn">{d.status === 'error' ? 'Con error' : 'Procesando'}</Pill> : null}
              {!d.active ? <Pill kind="muted">Desactivado</Pill> : null}
            </label>
          </li>
        ))}
      </ul>
      <p className={`text-[12.5px] ${total > o.limits.max_chunks ? 'font-semibold text-crit' : 'text-muted'}`}>{total.toLocaleString('es-EC')} de {o.limits.max_chunks.toLocaleString('es-EC')} fragmentos usados</p>
      <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={showSource} onChange={(e) => setShowSource(e.target.checked)} />Mostrar de qué documento sale cada dato</label>
      <Result ok={ok} error={error} />
      <div><Button variant="primary" loading={m.setDocuments.isPending || m.update.isPending} onClick={() => void save()}>Guardar</Button></div>
    </div>
  );
}

function BehaviorTab({ a, o }: { a: Agent; o: AgentOptions }) {
  const m = useAgentMutations();
  const [split, setSplit] = useState(a.split_enabled);
  const [blocks, setBlocks] = useState(String(a.split_blocks));
  const [transfer, setTransfer] = useState(a.transfer_enabled);
  const [queue, setQueue] = useState(a.transfer_queue_id ?? '');
  const [always, setAlways] = useState(a.always_on);
  const [capture, setCapture] = useState<string[]>(a.capture_fields ?? []);
  const [tasks, setTasks] = useState(a.tasks_enabled ?? false);
  const [channels, setChannels] = useState<string[]>(a.channel_ids);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const toggleField = (key: string): void => setCapture((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));
  const maxFields = o.limits.max_capture_fields ?? 10;
  const toggle = (id: string): void => setChannels((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async (): Promise<void> => {
    setOk(false);
    setError(undefined);
    try {
      await m.update.mutateAsync({ id: a.id, patch: { split_enabled: split, split_blocks: Number(blocks), transfer_enabled: transfer, transfer_queue_id: transfer && queue ? queue : null, always_on: always, capture_fields: capture, tasks_enabled: tasks } });
      await m.setChannels.mutateAsync({ id: a.id, ids: channels });
      setOk(true);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos guardar el comportamiento.'));
    }
  };
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Estos ajustes se aplicarán cuando el agente conteste mensajes.</p>
      <section aria-label="Respuestas" className="grid gap-2">
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />Dividir las respuestas largas en varios mensajes</label>
        {split ? <Field label="Máximo de mensajes por respuesta">{(f) => <select {...f} className={selectCls} value={blocks} onChange={(e) => setBlocks(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>}</Field> : null}
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />Responder a toda hora (también fuera del horario del departamento)</label>
      </section>
      <section aria-label="Pasar con una persona" className="grid gap-2">
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} />Puede pasar la conversación a una persona del equipo</label>
        {transfer ? (
          <Field label="Departamento al que pasa" hint="Sin departamento, usa el de la conexión.">
            {(f) => <select {...f} className={selectCls} value={queue} onChange={(e) => setQueue(e.target.value)}><option value="">El departamento de la conexión</option>{o.queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select>}
          </Field>
        ) : null}
      </section>
      <section aria-label="Datos y tareas" className="grid gap-2">
        <h3 className="text-[13.5px] font-bold">Qué puede hacer con los datos del cliente</h3>
        <p className="text-[12.5px] text-muted">Solo guarda lo que el cliente dijo con claridad, nunca pisa lo que escribió una persona y todo queda en el historial con la marca «IA».</p>
        {(o.capture_options ?? []).length === 0 ? <p className="text-[12.5px] text-muted">Crea campos personalizados en Configuración › Campos personalizados para que el agente pueda llenarlos.</p> : (
          <ul aria-label="Campos que puede llenar" className="grid gap-1.5 sm:grid-cols-2">
            {(o.capture_options ?? []).map((f) => (
              <li key={f.key}>
                <label className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[13.5px]">
                  <input type="checkbox" checked={capture.includes(f.key)} disabled={!capture.includes(f.key) && capture.length >= maxFields} onChange={() => toggleField(f.key)} aria-label={`Puede llenar «${f.name}»`} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{f.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <label className="inline-flex items-center gap-2 text-[13.5px] font-semibold"><input type="checkbox" checked={tasks} onChange={(e) => setTasks(e.target.checked)} />Puede crear tareas de seguimiento para el responsable de la conversación</label>
      </section>
      <section aria-label="Conexiones" className="grid gap-2">
        <h3 className="text-[13.5px] font-bold">Conexiones donde responde</h3>
        <p className="text-[12.5px] text-muted">Cada conexión la atiende como máximo un agente.</p>
        {o.channels.length === 0 ? <Alert kind="info">Aún no tienes conexiones. Conéctalas en Configuración › Conexiones.</Alert> : null}
        <ul className="grid gap-1.5">
          {o.channels.map((c) => {
            const other = c.agent && c.agent.id !== a.id ? c.agent : null;
            return (
              <li key={c.id}>
                <label className={`flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-[13.5px] ${other ? 'opacity-60' : ''}`}>
                  <input type="checkbox" checked={channels.includes(c.id)} disabled={other !== null} onChange={() => toggle(c.id)} aria-label={`Atender «${c.name}»`} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{c.name}</span>
                  {other ? <Pill kind="muted">Lo atiende {other.name}</Pill> : null}
                </label>
              </li>
            );
          })}
        </ul>
      </section>
      <Result ok={ok} error={error} />
      <div><Button variant="primary" loading={m.update.isPending || m.setChannels.isPending} onClick={() => void save()}>Guardar</Button></div>
    </div>
  );
}

interface Bubble { from: 'user' | 'agent'; texts: string[]; turn?: TestTurn }
const SHORTCUTS = ['¿Cuál es el horario de atención?', '¿Cuánto cuesta?', '¿Tienen cupos disponibles?', 'Quiero hablar con un asesor'];

const TOOL_LABELS: Record<string, string> = { update_contact_fields: 'Guardar datos en la ficha', create_task: 'Crear tarea', transfer_to_person: 'Pasar a una persona' };

/** «Qué hizo el agente» en un turno: los documentos que consultó, si no encontró respaldo, las variables sin datos y el consumo. */
function Trace({ t }: { t: TestTurn }) {
  return (
    <ul aria-label="Qué hizo el agente" className="grid gap-1 rounded-xl bg-surface2 p-2 text-[11.5px] text-muted">
      <li>{t.trace.search.grounded ? <>Consultó: {t.trace.search.results.map((r) => `${r.document} (${Math.round(r.score * 100)} %)`).join(', ')}</> : <b className="text-warn">No encontró respaldo en los documentos: no debería dar datos del negocio.</b>}</li>
      {t.trace.missing_variables.length > 0 ? <li>Sin datos del contacto para: {t.trace.missing_variables.map((v) => `{{${v}}}`).join(', ')}</li> : null}
      {t.trace.split ? <li>Respuesta dividida en {t.replies.length} mensajes.</li> : null}
      {t.trace.trimmed ? <li>Respuesta recortada al largo máximo del agente.</li> : null}
      {(t.trace.tool_calls ?? []).map((c, i) => <li key={i}><b>{TOOL_LABELS[c.tool] ?? c.tool}</b> (solo se simula): {c.detail}</li>)}
      <li>Modelo {t.trace.model.name} · {t.trace.model.tokens_in + t.trace.model.tokens_out} tokens · {t.credits_used} {t.credits_used === 1 ? 'crédito' : 'créditos'}</li>
    </ul>
  );
}

/** Simulador (M8.4): conversa con el agente tal como está guardado, sin enviar mensajes a nadie ni crear contactos. Cada mensaje usa créditos de prueba. */
function TestTab({ a }: { a: Agent }) {
  const m = useAgentMutations();
  const [log, setLog] = useState<Bubble[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const [spent, setSpent] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const found = useContactSearch(contact ? '' : search);

  const send = (message: string): void => {
    const msg = message.trim();
    if (msg === '' || m.test.isPending) return;
    setError(undefined);
    const history = log.slice(-20).map((b) => ({ role: b.from === 'user' ? ('user' as const) : ('assistant' as const), text: b.texts.join('\n\n') }));
    setLog((l) => [...l, { from: 'user', texts: [msg] }]);
    setText('');
    m.test.mutate({ id: a.id, message: msg, history, contactId: contact?.id ?? null }, {
      onSuccess: (t) => { setLog((l) => [...l, { from: 'agent', texts: t.replies.length > 0 ? t.replies : ['(sin respuesta)'], turn: t }]); setSpent((s) => s + t.credits_used); setRemaining(t.remaining_today); },
      onError: (e) => setError(friendlyError(e, 'No pudimos probar al agente.')),
    });
  };

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">Conversa con «{a.name}» como lo haría un cliente. Usa las instrucciones y los documentos <b>guardados</b>; no envía mensajes a nadie ni crea contactos. Cada mensaje usa créditos de prueba.</p>
      {!a.readiness.documents ? <Alert kind="info">Este agente no tiene documentos asignados: no tendrá respaldo para dar datos del negocio y te lo dirá.</Alert> : null}
      <section aria-label="Probar como" className="grid gap-1.5 text-[13px]">
        {contact ? <p className="flex flex-wrap items-center gap-2">Probando como <b>{contact.name}</b><Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setContact(null)}>Volver al ejemplo</Button></p> : (
          <>
            <Input aria-label="Probar como un contacto" type="search" placeholder="Probar como un contacto (opcional)…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.data && found.data.items.length > 0 ? <ul aria-label="Contactos para probar" className="flex flex-wrap gap-1.5">{found.data.items.map((c) => <li key={c.id}><button type="button" onClick={() => { setContact(c); setSearch(''); }} className="rounded-full border border-line px-2.5 py-1 text-[12px] hover:border-accent">{c.name}</button></li>)}</ul> : null}
          </>
        )}
      </section>
      <div className="mx-auto grid w-full max-w-[380px] gap-2 rounded-[28px] border-4 border-line bg-surface p-3">
        <div role="log" aria-label="Conversación de prueba" className="grid max-h-[340px] min-h-[200px] content-start gap-2 overflow-y-auto">
          {log.length === 0 ? <p className="py-8 text-center text-[12.5px] text-muted">Escribe un mensaje o elige un atajo.</p> : null}
          {log.map((b, i) => (
            <div key={i} className={`grid gap-1 ${b.from === 'user' ? 'justify-items-end' : 'justify-items-start'}`}>
              {b.texts.map((x, j) => <p key={j} className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-[13.5px] ${b.from === 'user' ? 'bg-accent text-accent-ink' : 'bg-surface2'}`}>{x}</p>)}
              {b.turn ? (
                <>
                  <button type="button" className="text-[11.5px] font-semibold text-accent hover:underline" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Ocultar qué hizo' : 'Ver qué hizo el agente'}</button>
                  {open === i ? <Trace t={b.turn} /> : null}
                </>
              ) : null}
            </div>
          ))}
          {m.test.isPending ? <p className="text-[12px] text-muted" role="status">El agente está escribiendo…</p> : null}
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap gap-1.5">{SHORTCUTS.map((s) => <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] hover:border-accent">{s}</button>)}</div>
        <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex gap-2">
          <Input aria-label="Mensaje de prueba" className="flex-1" value={text} maxLength={1000} placeholder="Escribe un mensaje…" onChange={(e) => setText(e.target.value)} />
          <Button type="submit" variant="primary" loading={m.test.isPending}>Enviar</Button>
        </form>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>{spent} {spent === 1 ? 'crédito usado' : 'créditos usados'} en esta prueba{remaining !== null ? ` · te quedan ${remaining} mensajes de prueba hoy` : ''}</span>
        <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => { setLog([]); setSpent(0); setOpen(null); setError(undefined); }}>Nueva conversación</Button>
      </div>
    </div>
  );
}

/** Los ajustes de un agente en pestañas (M8.3, ADR-20): General, Instrucciones, Conocimiento, Comportamiento y Probar (el simulador, M8.4). */
export function AgentDialog({ id, justCreated, onClose }: { id: string; justCreated: boolean; onClose: () => void }) {
  const q = useAgent(id);
  const options = useAgentOptions();
  const { remove } = useAgentMutations();
  const [tab, setTab] = useState<TabKey>(justCreated ? 'instructions' : 'general');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const a = q.data;
  const o = options.data;
  return (
    <Modal title={a ? `Agente ${a.name}` : 'Agente'} onClose={onClose} wide>
      {q.isLoading || options.isLoading ? <Spinner label="Cargando el agente" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar el agente.')}</Alert> : null}
      {a && o ? (
        <>
          <Tabs label="Secciones del agente" active={tab} onChange={setTab} tabs={[['general', 'General'], ['instructions', 'Instrucciones'], ['knowledge', 'Conocimiento'], ['behavior', 'Comportamiento'], ['test', 'Probar']]} />
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            {tab === 'general' ? <GeneralTab a={a} o={o} /> : null}
            {tab === 'instructions' ? <InstructionsTab a={a} o={o} /> : null}
            {tab === 'knowledge' ? <KnowledgeTab a={a} o={o} /> : null}
            {tab === 'behavior' ? <BehaviorTab a={a} o={o} /> : null}
            {tab === 'test' ? <TestTab a={a} /> : null}
          </div>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            {confirm ? (
              <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
                ¿Borrar este agente? Se quitan sus conexiones y documentos asignados.
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(id, { onSuccess: onClose, onError: (e) => { setConfirm(false); setError(friendlyError(e, 'No pudimos borrar el agente.')); } })}>Sí, borrar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
              </span>
            ) : (
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Borrar agente</Button>
            )}
            <Button onClick={onClose}>Cerrar</Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
