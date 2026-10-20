import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Conversation, Template } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { CATEGORY_KIND, CATEGORY_LABEL, fillTemplate, MAX_VALUE, valuesOf, variableLabel } from '../templates/templateFormat';
import { useConversationTemplates, useSendTemplate } from './useInbox';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** La vista previa del mensaje tal como lo recibirá el cliente (con lo que ya se llenó de las variables). */
function Preview({ t, params }: { t: Template; params: Record<string, string> }) {
  const header = t.header?.format === 'text' && t.header.text ? fillTemplate(t.header.text, valuesOf(t.variables, params, 'header')) : null;
  return (
    <div role="group" aria-label="Vista previa" className="grid gap-1.5 rounded-xl bg-accent-soft p-3 text-[13.5px]">
      {header ? <b>{header}</b> : null}
      <span className="whitespace-pre-wrap">{fillTemplate(t.body, valuesOf(t.variables, params, 'body'))}</span>
      {t.footer ? <span className="text-[12px] text-muted">{t.footer}</span> : null}
      {t.buttons.length > 0 ? (
        <span className="flex flex-wrap gap-1.5 pt-1">
          {t.buttons.map((b, i) => (
            <span key={i} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold text-accent">{b.text}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** Llenar las variables de una plantilla y enviarla. */
function TemplateForm({ c, t, onBack, onClose }: { c: Conversation; t: Template; onBack: () => void; onClose: () => void }) {
  const { state } = useSession();
  const send = useSendTemplate(c.id);
  const [params, setParams] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const myName = state.status === 'authed' ? (state.me.user.full_name ?? '') : '';
  const insertions = [
    { label: 'Primer nombre', value: c.contact.name.trim().split(/\s+/)[0] ?? '' },
    { label: 'Nombre completo', value: c.contact.name.trim() },
    { label: 'Teléfono', value: c.contact.phone ?? '' },
    { label: 'Mi nombre', value: myName.trim() },
  ].filter((x) => x.value !== '');

  function submit() {
    setError(undefined);
    const next: Record<string, string> = {};
    for (const v of t.variables) {
      const value = (params[v.id] ?? '').trim();
      if (value === '') next[v.id] = 'Escribe un valor';
      else if (value.length > MAX_VALUE[v.part]) next[v.id] = `Usa como máximo ${MAX_VALUE[v.part]} caracteres`;
      else if (/ {4,}/.test(value)) next[v.id] = 'No puede tener más de 3 espacios seguidos';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    send.mutate(
      { template_id: t.id, params: Object.fromEntries(t.variables.map((v) => [v.id, (params[v.id] ?? '').trim()])) },
      {
        onSuccess: onClose,
        onError: (e) => {
          // El servidor dice qué variable no vale: se marca en su campo
          if (e instanceof ApiError && e.details.length > 0) {
            const fields: Record<string, string> = {};
            for (const d of e.details) if (d.path.startsWith('params.')) fields[d.path.slice('params.'.length)] = d.message;
            if (Object.keys(fields).length > 0) {
              setErrors(fields);
              return;
            }
          }
          setError(friendlyError(e, 'No pudimos enviar la plantilla.'));
        },
      },
    );
  }

  return (
    <Modal title={`Plantilla ${t.name}`} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill kind={CATEGORY_KIND[t.category] ?? 'muted'}>{CATEGORY_LABEL[t.category] ?? t.category}</Pill>
        <Pill kind="muted">{t.language}</Pill>
        {c.window.open ? null : <Pill kind="warn">Fuera de las 24 h</Pill>}
      </div>
      {t.category === 'marketing' ? <Alert kind="info">Es una plantilla de marketing: Meta la cobra por mensaje y el cliente debe haber aceptado recibir promociones.</Alert> : null}
      <Preview t={t} params={params} />
      {t.variables.length === 0 ? <p className="text-[13px] text-muted">Esta plantilla no tiene variables: se envía tal como está.</p> : null}
      <div className="grid max-h-[40vh] gap-3 overflow-y-auto pr-1">
        {t.variables.map((v) => (
          <div key={v.id} className="grid gap-1">
            <Field label={variableLabel(v)} error={errors[v.id]} {...(v.example ? { hint: `Ejemplo: ${v.example}` } : {})}>
              {(p) => <Input {...p} value={params[v.id] ?? ''} maxLength={MAX_VALUE[v.part]} autoComplete="off" onChange={(e) => setParams((cur) => ({ ...cur, [v.id]: e.target.value.replace(/[\n\r\t]/g, ' ') }))} />}
            </Field>
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
              {insertions.map((x) => (
                <Button key={x.label} variant="link" className="text-[12px]" aria-label={`Usar ${x.label.toLowerCase()} en ${variableLabel(v)}`} onClick={() => setParams((cur) => ({ ...cur, [v.id]: x.value.slice(0, MAX_VALUE[v.part]) }))}>{x.label}</Button>
              ))}
            </span>
          </div>
        ))}
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap justify-between gap-2">
        <Button onClick={onBack}>Volver</Button>
        <span className="flex gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={send.isPending} onClick={submit}>Enviar plantilla</Button>
        </span>
      </div>
    </Modal>
  );
}

/**
 * El selector de plantillas de WhatsApp (M5.6a, ADR-50): las aprobadas de la conexión de la conversación, con búsqueda y categoría; las que no se pueden enviar desde aquí
 * se listan aparte con el motivo. Al elegir una se llenan sus variables y se envía; funciona dentro y fuera de las 24 h (fuera es lo único permitido).
 */
export function TemplatePicker({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const q = useConversationTemplates(c.id, true);
  const [chosen, setChosen] = useState<Template>();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const items = q.data?.items ?? [];
  const match = (t: Template): boolean => (category === '' || t.category === category) && (search.trim() === '' || `${t.name} ${t.body}`.toLowerCase().includes(search.trim().toLowerCase()));
  const sendable = items.filter((t) => t.sendable && match(t));
  const blocked = items.filter((t) => !t.sendable && match(t));

  if (chosen) return <TemplateForm c={c} t={chosen} onBack={() => setChosen(undefined)} onClose={onClose} />;
  return (
    <Modal title="Enviar una plantilla" onClose={onClose} wide>
      <p className="text-[13px] text-muted">Plantillas aprobadas por Meta de «{c.channel.name}». Con ellas puedes escribirle al cliente aunque hayan pasado más de 24 horas desde su último mensaje.</p>
      <Alert kind="info">Meta cobra cada plantilla que se envía, según su categoría.</Alert>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
        <input type="search" aria-label="Buscar plantilla" placeholder="Buscar por nombre o texto" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px]" />
        <select aria-label="Categoría" value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-[10px] border border-line bg-surface px-2.5 py-2 text-[13.5px]">
          <option value="">Todas las categorías</option>
          <option value="utility">Utilidad</option>
          <option value="marketing">Marketing</option>
          <option value="authentication">Autenticación</option>
        </select>
      </div>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando plantillas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las plantillas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.data?.sync_error ? <Alert kind="info">No se pudieron actualizar las plantillas con Meta ({q.data.sync_error}). Se muestran las últimas que se tenían.</Alert> : null}
      {q.isSuccess ? (
        <div className="grid max-h-[46vh] gap-3 overflow-y-auto pr-1">
          {sendable.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">{items.length === 0 ? 'Esta conexión aún no tiene plantillas. Se crean y aprueban en Meta; luego se sincronizan aquí.' : 'No hay plantillas que coincidan.'}</p> : null}
          <ul aria-label="Plantillas" className="grid gap-2">
            {sendable.map((t) => (
              <li key={t.id} className="grid gap-1.5 rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5"><b className="font-mono text-[13px]">{t.name}</b><Pill kind="muted">{t.language}</Pill><Pill kind={CATEGORY_KIND[t.category] ?? 'muted'}>{CATEGORY_LABEL[t.category] ?? t.category}</Pill></span>
                  <Button variant="primary" className={SMALL} aria-label={`Usar la plantilla ${t.name} (${t.language})`} onClick={() => setChosen(t)}>Usar</Button>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-muted">{t.body}</p>
              </li>
            ))}
          </ul>
          {blocked.length > 0 ? (
            <details className="rounded-xl border border-line p-3 text-[13px]">
              <summary className="cursor-pointer font-semibold">No se pueden enviar desde aquí ({blocked.length})</summary>
              <ul aria-label="Plantillas no disponibles" className="mt-2 grid gap-2">
                {blocked.map((t) => (
                  <li key={t.id} className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5"><b className="font-mono text-[12.5px]">{t.name}</b><Pill kind="muted">{t.language}</Pill></span>
                    <span className="text-[12.5px] text-muted">{t.unsupported_reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-muted">{q.data?.synced_at ? `Sincronizadas con Meta: ${shortDateTime(q.data.synced_at)}` : 'Aún no se han sincronizado con Meta.'}</span>
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </Modal>
  );
}
