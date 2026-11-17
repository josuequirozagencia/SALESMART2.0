import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLists } from '../contacts/useLists';
import { Alert, Button, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { PageHeader } from '../../ui/PageHeader';
import { Pill } from '../../ui/Pill';
import { useDocumentTitle } from '../../lib/platformBrand';
import { friendlyError } from '../../lib/errors';
import { CampaignForm } from './CampaignForm';
import { ResultsDialog } from './CampaignResults';
import { baseLabel, campaignError, channelLabel, STATUS_KIND, STATUS_LABEL, whenLabel } from './labels';
import { newKey, useCampaignAccess, useCampaignAction, useCampaignOptions, useCampaignSettings, useCampaigns, useDuplicateCampaign, useLivePreview, useSetCampaignSettings, type Campaign, type CampaignAccessInfo, type CampaignOptions } from './useCampaigns';

const n = (v: number): string => v.toLocaleString('es-EC');
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** Las reglas de protección del prototipo: lo que el sistema hace por ti al enviar. */
const RULES: Array<[string, string, 'ok' | 'warn']> = [
  ['WhatsApp oficial', 'Solo plantillas aprobadas fuera de la ventana de 24 h', 'ok'],
  ['WhatsApp QR', 'Texto libre con límites bajos: riesgo de bloqueo del número', 'warn'],
  ['Lista', 'Excluye contactos con «no contactar» y sin consentimiento', 'ok'],
  ['Alcance', 'Un asesor solo envía a sus contactos', 'ok'],
  ['Informe', 'Enviados, entregados, leídos y respuestas por mensaje', 'ok'],
];

function Rules() {
  return (
    <section aria-label="Reglas de protección" className="grid gap-1 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[16px] font-bold">Reglas de protección</h2>
      <ul className="mt-1 grid">
        {RULES.map(([title, text, kind]) => (
          <li key={title} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
            <span className="min-w-0 flex-1"><b className="block text-[13.5px]">{title}</b><span className="block text-[12px] text-muted">{text}</span></span>
            <Pill kind={kind}>{kind === 'ok' ? 'Activo' : 'Atención'}</Pill>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «Alcance de tus campañas» (solo asesores): cuántos contactos son suyos y cuántos no están disponibles para él, con su tope diario. */
function Scope({ options }: { options: CampaignOptions }) {
  const q = useLivePreview({ audience: { source: 'all' } });
  const inScope = q.data?.audience.in_scope ?? 0;
  const out = q.data?.audience.out_of_scope ?? 0;
  const total = inScope + out;
  const cap = options.limits.advisor_daily_cap;
  return (
    <section aria-label="Alcance de tus campañas" className="grid gap-2 rounded-2xl border border-line border-l-[3px] border-l-accent bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[230px] flex-1">
          <h2 className="text-[16px] font-bold">Alcance de tus campañas</h2>
          <p className="mt-1 text-[13px] text-muted">Solo puedes enviar a los contactos que gestionas. El resto de la base de la empresa no está disponible para ti; lo define tu administrador.</p>
        </div>
        <div className="flex flex-wrap gap-2"><Pill kind="ok">✓ Mis contactos · {n(inScope)}</Pill><Pill kind="muted">🔒 Resto de la empresa · {n(out)}</Pill></div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface2" aria-hidden="true"><i className="block h-full bg-accent" style={{ width: `${total > 0 ? Math.round((inScope / total) * 100) : 0}%` }} /></div>
      <p className="text-[12px] text-muted">{n(inScope)} de {n(total)} contactos de la empresa · tope diario de envíos: {cap ?? '—'}</p>
    </section>
  );
}

/** El tope diario de la empresa por WhatsApp oficial (lo administra quien administra las conexiones). Nunca debe pasar del nivel de mensajería de Meta de ese número: si Meta lo rechaza, la campaña se pausa sola. */
function CompanyCapCard() {
  const q = useCampaignSettings(true);
  const save = useSetCampaignSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const saved = q.data?.official_daily_cap;
  const value = draft ?? (saved !== undefined ? String(saved) : '');
  const cap = Number(value);
  const submit = (): void => {
    setNote(undefined);
    setError(undefined);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100000) return setError('Escribe un número entero entre 1 y 100 000.');
    save.mutate(cap, { onSuccess: () => { setDraft(null); setNote('Tope guardado.'); }, onError: (e) => setError(campaignError(e, 'No pudimos guardar el tope.')) });
  };
  return (
    <section aria-label="Tope diario de la empresa" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[16px] font-bold">Tope diario de la empresa</h2>
      <p className="text-[13px] text-muted">Máximo de mensajes de campaña por día entre todas las campañas por WhatsApp oficial. Nunca debe pasar del nivel de mensajería de Meta de tu número: si Meta lo rechaza, la campaña se pausa sola.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[160px]"><Input type="number" inputMode="numeric" min={1} max={100000} aria-label="Mensajes por día" value={value} disabled={q.isPending} onChange={(e) => setDraft(e.target.value)} /></div>
        <Button loading={save.isPending} disabled={value === '' || value === String(saved)} onClick={submit}>Guardar tope</Button>
      </div>
      {q.data ? <p className="text-[12px] text-muted">Sin tope propio rige {n(q.data.default_cap)} por día.</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
    </section>
  );
}

/** Pausar, reanudar y cancelar desde la tabla. Cancelar pide confirmación: no se deshace. */
function RowActions({ c, onNotice, onError }: { c: Campaign; onNotice: (t: string) => void; onError: (t: string) => void }) {
  const act = useCampaignAction();
  const [asking, setAsking] = useState(false);
  const run = (action: 'pause' | 'resume' | 'cancel', done: string): void => {
    act.mutate({ id: c.id, action }, { onSuccess: () => { setAsking(false); onNotice(done); }, onError: (e) => { setAsking(false); onError(campaignError(e, 'No pudimos completar la acción.')); } });
  };
  return (
    <>
      {c.can_pause ? <Button className={SMALL} loading={act.isPending} onClick={() => run('pause', `Campaña «${c.name}» pausada.`)} aria-label={`Pausar ${c.name}`}>Pausar</Button> : null}
      {c.can_resume ? <Button className={SMALL} loading={act.isPending} onClick={() => run('resume', `Campaña «${c.name}» reanudada.`)} aria-label={`Reanudar ${c.name}`}>Reanudar</Button> : null}
      {c.can_cancel ? <Button variant="danger" className={SMALL} onClick={() => setAsking(true)} aria-label={`Cancelar ${c.name}`}>Cancelar</Button> : null}
      {asking ? (
        <Modal title="¿Cancelar la campaña?" onClose={() => setAsking(false)}>
          <p className="text-[13.5px]">«<b>{c.name}</b>» dejará de enviarse. Lo que ya salió queda; lo pendiente no se enviará. No se puede deshacer.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAsking(false)} disabled={act.isPending}>Volver</Button>
            <Button variant="danger" loading={act.isPending} onClick={() => run('cancel', `Campaña «${c.name}» cancelada.`)}>Sí, cancelar</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function LockedPlan() {
  return (
    <section aria-label="Campañas no incluidas en el plan" className="grid max-w-[640px] gap-2 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-[16px] font-bold">🔒 Las campañas masivas no están incluidas en tu plan</h2>
      <p className="text-[13.5px] text-muted">El plan de tu empresa no incluye esta función. Pídele a tu administrador o a tu proveedor que cambie de plan para enviar mensajes a muchos contactos con límites, consentimiento y resultados por destinatario.</p>
    </section>
  );
}

function Content({ access, options }: { access: CampaignAccessInfo; options: CampaignOptions | undefined }) {
  const lists = useLists();
  const list = useCampaigns(access.read);
  const dup = useDuplicateCampaign();
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [results, setResults] = useState<Campaign | null>(null);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const items = (list.data?.pages ?? []).flatMap((p) => p.items);

  const duplicate = (c: Campaign): void => {
    setError(undefined);
    dup.mutate({ id: c.id, key: newKey() }, { onSuccess: (copy) => { setNotice(`Copia creada: «${copy.name}». Revísala y guárdala.`); setEditing(copy); }, onError: (e) => setError(campaignError(e, 'No pudimos duplicar la campaña.')) });
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      {!access.view_all && options ? <Scope options={options} /> : null}
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      {access.read ? (
        <section aria-label="Campañas" className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5 font-semibold">Campaña</th>
                {access.view_all ? <th className="px-3 py-2.5 font-semibold">Creada por</th> : null}
                <th className="px-3 py-2.5 font-semibold">Base</th>
                <th className="px-3 py-2.5 font-semibold">Canal</th>
                <th className="px-3 py-2.5 font-semibold">Estado</th>
                <th className="px-3 py-2.5 text-right font-semibold">Dest.</th>
                <th className="px-3 py-2.5 text-right font-semibold">Enviados</th>
                <th className="px-3 py-2.5 text-right font-semibold">Entregados</th>
                <th className="px-3 py-2.5 text-right font-semibold">Respondieron</th>
                <th className="px-3 py-2.5 font-semibold">Cuándo</th>
                <th className="px-3 py-2.5" aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {list.isPending ? <tr><td colSpan={11} className="p-6 text-center text-muted"><Spinner label="Cargando campañas" /></td></tr> : null}
              {list.isError ? <tr><td colSpan={11} className="p-4"><Alert>{friendlyError(list.error, 'No pudimos cargar las campañas.')}</Alert></td></tr> : null}
              {list.isSuccess && items.length === 0 ? <tr><td colSpan={11} className="p-6 text-center text-muted">{access.view_all ? 'Todavía no hay campañas.' : 'Todavía no has creado campañas.'}</td></tr> : null}
              {items.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-2.5"><b>{c.name}</b></td>
                  {access.view_all ? <td className="px-3 py-2.5">{c.created_by.name || '—'}</td> : null}
                  <td className="px-3 py-2.5">{baseLabel(c, lists.data ?? [])}</td>
                  <td className="px-3 py-2.5 text-muted">{channelLabel(c)}</td>
                  <td className="px-3 py-2.5">
                    <Pill kind={STATUS_KIND[c.status]}>{STATUS_LABEL[c.status]}</Pill>
                    {c.status_reason && (c.status === 'paused' || c.status === 'failed') ? <span className="mt-1 block max-w-[220px] text-[11.5px] text-warn">{c.status_reason}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{c.status === 'draft' ? '—' : n(c.counts.total)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{n(c.counts.sent)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{n(c.counts.delivered)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{n(c.counts.replied)}</td>
                  <td className="px-3 py-2.5 text-muted">{whenLabel(c)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button className={SMALL} onClick={() => setResults(c)} aria-label={`Resultados de ${c.name}`}>Resultados</Button>
                      {c.can_edit ? <Button className={SMALL} onClick={() => { setNotice(undefined); setEditing(c); }} aria-label={`Editar ${c.name}`}>Editar</Button> : null}
                      <RowActions c={c} onNotice={(t) => { setError(undefined); setNotice(t); }} onError={(t) => { setNotice(undefined); setError(t); }} />
                      {access.send ? <Button className={SMALL} loading={dup.isPending && dup.variables?.id === c.id} onClick={() => duplicate(c)} aria-label={`Duplicar ${c.name}`}>Duplicar</Button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage ? <div className="grid place-items-center p-3"><Button className={SMALL} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Cargar más</Button></div> : null}
        </section>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {access.send && options ? (
          <section className="min-w-0 rounded-2xl border border-line bg-surface p-5">
            <CampaignForm
              key={editing?.id ?? 'new'}
              access={access}
              options={options}
              editing={editing}
              onSaved={(c, created) => { setEditing(null); setNotice(created ? `Campaña «${c.name}» guardada como borrador.` : `Cambios de «${c.name}» guardados.`); }}
              onLaunched={(c) => { setEditing(null); setNotice(c.status === 'scheduled' ? `Campaña «${c.name}» programada.` : `Campaña «${c.name}» en curso: ya empezó a enviarse.`); }}
              onCancel={() => setEditing(null)}
            />
          </section>
        ) : null}
        <div className="grid gap-4">
          <Rules />
          {access.manage_settings ? <CompanyCapCard /> : null}
          {access.view_all ? (
            <section aria-label="Quién puede enviar campañas" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-[16px] font-bold">Quién puede enviar campañas</h2>
              <p className="text-[13px] text-muted">Tú decides qué asesores tienen acceso y su tope diario de envíos: se conceden en la ficha de cada persona.</p>
              <div><Link to="/users" className="inline-flex rounded-[11px] border border-line px-4 py-2.5 text-[14px] font-semibold hover:bg-surface2">Administrar accesos</Link></div>
            </section>
          ) : null}
        </div>
      </div>
      {results ? <ResultsDialog c={results} onClose={() => setResults(null)} /> : null}
    </div>
  );
}

/**
 * «Campañas masivas» (v17 · 17.2, ADR-72): la pantalla del prototipo v10. Lista de campañas, formulario de una sola pantalla con cinco secciones, reglas de protección y, para el asesor,
 * su alcance y tope. Solo borradores por ahora: el envío llega en 17.3 (oficial) y 17.4 (QR). Si el plan de la empresa no las incluye, la sección aparece bloqueada.
 */
export function CampaignsPage() {
  const access = useCampaignAccess();
  const a = access.data;
  const options = useCampaignOptions(a?.plan_enabled === true && a.send);
  const advisor = a ? !a.view_all : false;
  useDocumentTitle(advisor ? 'Mis campañas masivas' : 'Campañas masivas');
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title={advisor ? 'Mis campañas masivas' : 'Campañas masivas'} description={advisor ? 'Envíos masivos a tus contactos, dentro de los límites que fija tu administrador' : 'Envíos masivos a tus contactos, con límites para proteger el número'} />
      {access.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando campañas" /></div> : null}
      {access.isError ? <Alert>{friendlyError(access.error, 'No pudimos abrir las campañas.')}</Alert> : null}
      {a && !a.plan_enabled ? <LockedPlan /> : null}
      {a && a.plan_enabled && !a.read && !a.send ? <Alert kind="info">No tienes acceso a las campañas masivas. Pídele a tu administrador que te lo active.</Alert> : null}
      {a && a.plan_enabled && (a.read || a.send) ? <Content access={a} options={options.data} /> : null}
      {options.isError ? <Alert>{campaignError(options.error, 'No pudimos cargar tus conexiones.')}</Alert> : null}
    </div>
  );
}
