import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { reason } from './reason';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { AutomationEditor } from './AutomationEditor';
import { STATUS_KIND, STATUS_LABEL, TRIGGER_LABEL } from './labels';
import { useAutomationMutations, useAutomations, useAutomationSettings, useSaveAutomationSettings, type Automation } from './useAutomations';

function summary(a: Automation): string {
  const parts = [TRIGGER_LABEL[a.trigger.type], `${a.actions.length} ${a.actions.length === 1 ? 'acción' : 'acciones'}`];
  if (a.conditions.length > 0) parts.splice(1, 0, `${a.conditions.length} ${a.conditions.length === 1 ? 'condición' : 'condiciones'}`);
  return parts.join(' · ');
}

function recent(a: Automation): string {
  const { done, failed, skipped, queued, waiting } = a.recent;
  if (done + failed + skipped + queued + waiting === 0) return 'Sin ejecuciones en los últimos 7 días';
  return [done > 0 ? `${done} ${done === 1 ? 'hecha' : 'hechas'}` : '', failed > 0 ? `${failed} con fallos` : '', skipped > 0 ? `${skipped} ${skipped === 1 ? 'omitida' : 'omitidas'}` : '', queued > 0 ? `${queued} en cola` : '', waiting > 0 ? `${waiting} esperando` : ''].filter(Boolean).join(' · ') + ' en 7 días';
}

function Row({ a }: { a: Automation }) {
  const m = useAutomationMutations();
  const [error, setError] = useState<string>();
  const live = a.status === 'active';
  const toggle = (): void => {
    setError(undefined);
    const op = live ? m.pause : m.activate;
    op.mutate(a.id, { onError: (e) => setError(reason(e, live ? 'No pudimos pausar la automatización.' : 'No pudimos activar la automatización.')) });
  };
  return (
    <li className="grid gap-2 rounded-2xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/automations/${a.id}`} aria-label={`Abrir la automatización ${a.name}`} className="text-[15px] font-bold hover:text-accent">{a.name}</Link>
        <Pill kind={STATUS_KIND[a.status]}>{STATUS_LABEL[a.status]}</Pill>
        <Button className="ml-auto !px-3 !py-1.5 !text-[12.5px]" loading={m.activate.isPending || m.pause.isPending} aria-label={`${live ? 'Pausar' : a.status === 'paused' ? 'Reactivar' : 'Activar'} ${a.name}`} onClick={toggle}>{live ? 'Pausar' : a.status === 'paused' ? 'Reactivar' : 'Activar'}</Button>
      </div>
      <span className="text-[12.5px] text-muted">{summary(a)}</span>
      <span className="text-[12.5px] text-muted">{recent(a)}</span>
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

/** La lista de dominios a los que las automatizaciones pueden llamar (acción «llamada HTTP»): uno por línea. */
function AllowedHostsDialog({ onClose }: { onClose: () => void }) {
  const q = useAutomationSettings();
  const save = useSaveAutomationSettings();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const value = text ?? (q.data?.http_allowed_hosts ?? []).join('\n');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setError(undefined);
    setOk(false);
    save.mutate(value.split('\n').map((l) => l.trim()).filter((l) => l !== ''), { onSuccess: (r) => { setText(r.http_allowed_hosts.join('\n')); setOk(true); }, onError: (e2) => setError(reason(e2, 'No pudimos guardar los dominios.')) });
  };
  return (
    <Modal title="Destinos permitidos" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3">
        <p className="text-[13px] text-muted">Las automatizaciones solo pueden llamar (HTTP) a los dominios de esta lista. Escribe uno por línea, por ejemplo <b>hooks.zapier.com</b> o <b>*.n8n.cloud</b> (el comodín cubre los subdominios, no el dominio base). Solo https; nunca direcciones IP.</p>
        {q.isLoading ? <Spinner label="Cargando los dominios" /> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los dominios.')}</Alert> : null}
        <label className="grid gap-1 text-[13px] font-semibold">
          Dominios autorizados
          <textarea className="min-h-[120px] w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 font-mono text-[13px] font-normal text-fg" value={value} onChange={(e) => { setOk(false); setText(e.target.value); }} />
        </label>
        {error ? <Alert>{error}</Alert> : null}
        {ok ? <Alert kind="ok">Dominios guardados.</Alert> : null}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cerrar</Button><Button type="submit" variant="primary" loading={save.isPending}>Guardar dominios</Button></div>
      </form>
    </Modal>
  );
}

function List() {
  const [hosts, setHosts] = useState(false);
  const q = useAutomations();
  const nav = useNavigate();
  const items = q.data?.items ?? [];
  const max = q.data?.limits.max_automations ?? 50;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Automatizaciones</h1>
        <span className="flex flex-wrap gap-2">
          <Button onClick={() => setHosts(true)}>Destinos permitidos</Button>
          <Button variant="primary" disabled={items.length >= max} onClick={() => nav('/automations/new')}>Nueva automatización</Button>
        </span>
      </div>
      <p className="max-w-[70ch] text-[13px] text-muted">Una automatización hace por ti lo repetitivo: <b>cuando ocurre</b> algo (llega un contacto, un mensaje, cambia una etapa…), <b>si se cumple</b> lo que pidas, <b>hace</b> esto otro (asignar, etiquetar, crear una tarea, enviar un mensaje…).</p>
      {q.isLoading ? <Spinner label="Cargando automatizaciones" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Aún no tienes automatizaciones. Crea la primera, pruébala con un contacto y luego actívala.</p> : null}
      {items.length > 0 ? <ul aria-label="Automatizaciones" className="grid gap-2">{items.map((a) => <Row key={a.id} a={a} />)}</ul> : null}
      {hosts ? <AllowedHostsDialog onClose={() => setHosts(false)} /> : null}
    </div>
  );
}

/** Automatizaciones (M9.4, ADR-54; F20): la lista de reglas con su estado y, en `/automations/:id`, el editor por pasos con prueba e historial. */
export function AutomationsPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <AutomationEditor id={id} /> : <List />;
}
