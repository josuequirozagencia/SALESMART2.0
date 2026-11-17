import { useEffect, useMemo, useState } from 'react';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { useLists } from '../contacts/useLists';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { campaignError, KIND_HINT, KIND_TITLE } from './labels';
import { LaunchDialog } from './LaunchDialog';
import { RecipientsPicker } from './RecipientsPicker';
import { useCampaignTemplates, useCreateCampaign, useIdempotencyKey, useLivePreview, useUpdateCampaign, type Campaign, type CampaignAccessInfo, type CampaignAudience, type CampaignInput, type CampaignOptions, type PreviewInput } from './useCampaigns';

const selectCls = 'w-full rounded-[11px] border border-line-strong bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const areaCls = 'w-full rounded-[11px] border border-line-strong bg-surface px-3 py-[11px] text-[14px] font-normal text-fg placeholder:text-muted/70';
const SECTION = 'grid gap-2';
const TITLE = 'text-[13px] font-semibold';

/** El valor de un campo «fecha y hora» del navegador (hora local, sin zona) a partir de un instante. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Espera `ms` a que el valor deje de cambiar (la vista previa en vivo no pregunta en cada tecla). Compara por contenido. */
function useSettled<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(JSON.parse(key) as T), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return settled;
}

/**
 * «Nueva campaña» del prototipo: UNA sola pantalla con cinco secciones numeradas — 1 · Nombre, 2 · Base y destinatarios, 3 · Conexión de WhatsApp, 4 · Mensaje y 5 · Envío — con los números
 * al día mientras se escribe (vista previa en vivo, sin guardar). Guarda un BORRADOR; el envío llega en la próxima versión (17.3 y 17.4).
 */
export function CampaignForm({ access, options, editing, onSaved, onLaunched, onCancel }: { access: CampaignAccessInfo; options: CampaignOptions; editing: Campaign | null; onSaved: (c: Campaign, created: boolean) => void; onLaunched: (c: Campaign) => void; onCancel: () => void }) {
  const lists = useLists();
  const fields = useCustomFields();
  const channels = options.channels;
  const [name, setName] = useState(editing?.name ?? '');
  const [base, setBase] = useState<string>(editing?.audience.source === 'list' && editing.audience.list_id ? editing.audience.list_id : 'all');
  const [excluded, setExcluded] = useState<Set<string>>(new Set(editing?.audience.excluded_contact_ids ?? []));
  const [includeUnknown, setIncludeUnknown] = useState(editing?.include_unknown_consent ?? false);
  const [channelId, setChannelId] = useState(editing?.channel?.id ?? channels[0]?.id ?? '');
  const [templateId, setTemplateId] = useState(editing?.template_id ?? '');
  const [params, setParams] = useState<Record<string, string>>(editing?.template_params ?? {});
  const [body, setBody] = useState(editing?.body ?? 'Hola {{primer_nombre}}, ');
  const [when, setWhen] = useState<'now' | 'later'>(editing?.scheduled_at ? 'later' : 'now');
  const [at, setAt] = useState(editing?.scheduled_at ? toLocalInput(editing.scheduled_at) : '');
  const [gap, setGap] = useState(editing?.gap_seconds ?? 60);
  const [cap, setCap] = useState(editing?.daily_cap ?? 100);
  const [focus, setFocus] = useState<string>('body');
  const [error, setError] = useState<string>();
  const idem = useIdempotencyKey();
  const create = useCreateCampaign();
  // El borrador que ya existe (el que se edita o el que se guardó al pedir el envío): los guardados siguientes lo cambian en vez de crear otro
  const [draftId, setDraftId] = useState<string | null>(editing?.id ?? null);
  const [confirm, setConfirm] = useState<Campaign | null>(null);
  const update = useUpdateCampaign(draftId ?? '');

  const channel = channels.find((c) => c.id === channelId);
  const kind = channel?.kind;
  const templates = useCampaignTemplates(kind === 'official' ? channelId : null);
  const template = templates.data?.items.find((t) => t.id === templateId);
  const minGap = kind === 'qr' ? options.limits.qr_min_gap_seconds : options.limits.official_min_gap_seconds;

  const audience: CampaignAudience = useMemo(
    () => ({ source: base === 'all' ? 'all' : 'list', ...(base === 'all' ? {} : { list_id: base }), ...(excluded.size > 0 ? { excluded_contact_ids: [...excluded] } : {}) }),
    [base, excluded],
  );
  const previewIn: PreviewInput = useSettled(
    {
      audience,
      include_unknown_consent: includeUnknown,
      channel_id: channelId || null,
      mode: kind === 'qr' ? 'text' : kind === 'official' ? 'template' : null,
      template_id: kind === 'official' && templateId ? templateId : null,
      template_params: kind === 'official' ? params : {},
      body: kind === 'qr' ? body : null,
      gap_seconds: gap >= 5 ? gap : null,
      daily_cap: cap >= 1 ? cap : null,
    },
    400,
  );
  const preview = useLivePreview(previewIn);
  const p = preview.data;
  const limits = p?.limits ?? null;
  const maxCap = limits ? Math.min(limits.channel_cap, limits.advisor_cap ?? Number.POSITIVE_INFINITY) : undefined;
  // El tope por día nunca pasa del máximo de la conexión (un chip nuevo por QR solo admite unos pocos al día): se ajusta solo en vez de proponer algo que el servidor rechazaría
  const capNow = maxCap !== undefined && cap > maxCap ? maxCap : cap;

  const pickChannel = (id: string): void => {
    setChannelId(id);
    setTemplateId('');
    setParams({});
    setFocus('body');
    const k = channels.find((c) => c.id === id)?.kind;
    const min = k === 'qr' ? options.limits.qr_min_gap_seconds : options.limits.official_min_gap_seconds;
    setGap((g) => Math.max(g, min));
  };
  const pickTemplate = (id: string): void => {
    setTemplateId(id);
    const t = templates.data?.items.find((x) => x.id === id);
    setParams(Object.fromEntries((t?.variables ?? []).map((v, i) => [v.id, i === 0 ? '{{primer_nombre}}' : ''])));
    setFocus(t?.variables[0]?.id ?? 'body');
  };
  const insert = (v: string): void => {
    if (focus === 'body') setBody((b) => `${b}${b && !/\s$/.test(b) ? ' ' : ''}${v}`);
    else setParams((x) => ({ ...x, [focus]: `${x[focus] ?? ''}${v}` }));
  };
  const variables = ['{{primer_nombre}}', '{{nombre}}', ...(fields.data?.items ?? []).filter((f) => !f.archived_at).map((f) => `{{contact.${f.key}}}`)];

  const missingTemplateData = kind === 'official' && template ? template.variables.some((v) => !(params[v.id] ?? '').trim()) : false;
  const ready = name.trim() !== '' && channelId !== '' && (kind === 'qr' ? body.trim() !== '' : kind === 'official' ? templateId !== '' && !missingTemplateData : false);
  const busy = create.isPending || update.isPending;

  /** Arma lo que se manda al servidor con lo que hay en pantalla (el servidor vuelve a validar todo); null si falta algo que se explica aquí. */
  const build = (): CampaignInput | null => {
    if (!channel || !kind) return null;
    let scheduled: string | null = null;
    if (when === 'later') {
      const d = new Date(at);
      if (!at || Number.isNaN(d.getTime())) {
        setError('Elige el día y la hora de envío.');
        return null;
      }
      scheduled = d.toISOString();
    }
    return {
      name: name.trim(),
      channel_id: channelId,
      mode: kind === 'qr' ? 'text' : 'template',
      ...(kind === 'qr' ? { body: body.trim() } : { template_id: templateId, template_params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.trim()])) }),
      audience,
      ...(access.view_all ? { include_unknown_consent: includeUnknown } : {}),
      scheduled_at: scheduled,
      gap_seconds: gap,
      daily_cap: capNow,
    };
  };
  /** Guarda el borrador (lo crea o lo cambia); null si falló (el motivo queda en pantalla). */
  const persist = async (): Promise<{ campaign: Campaign; created: boolean } | null> => {
    setError(undefined);
    const input = build();
    if (!input) return null;
    try {
      if (draftId) return { campaign: await update.mutateAsync(input), created: false };
      const campaign = await create.mutateAsync({ key: idem.keyFor(input), input });
      setDraftId(campaign.id);
      return { campaign, created: true };
    } catch (e) {
      setError(campaignError(e, 'No pudimos guardar la campaña.'));
      return null;
    }
  };
  const save = async (): Promise<void> => {
    const r = await persist();
    if (r) {
      idem.reset();
      onSaved(r.campaign, r.created && !editing);
    }
  };
  /** «Enviar»: guarda lo que hay en pantalla y pide la confirmación; el envío en sí lo hace el diálogo. */
  const send = async (): Promise<void> => {
    const r = await persist();
    if (r) setConfirm(r.campaign);
  };

  const eligible = p?.audience.eligible ?? 0;
  const sk = p?.audience.skipped;
  return (
    <form className="grid gap-[18px]" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={editing ? 'Editar campaña' : 'Nueva campaña'}>
      <h2 className="text-[18px] font-bold">{editing ? 'Editar borrador' : 'Nueva campaña'}</h2>

      <section className={SECTION}>
        <Field label="1 · Nombre" required>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Ej. Recordatorio de cupos" />}</Field>
      </section>

      <section className={SECTION} aria-labelledby="camp-s2">
        <h3 id="camp-s2" className={TITLE}>2 · Base y destinatarios</h3>
        <div role="group" aria-label="Base de destinatarios" className="flex flex-wrap gap-2">
          <Button variant={base === 'all' ? 'primary' : 'secondary'} className="!px-3 !py-2 !text-[13px]" aria-pressed={base === 'all'} onClick={() => { setBase('all'); setExcluded(new Set()); }}>{access.view_all ? 'Toda la base' : 'Mis contactos'}</Button>
          {(lists.data ?? []).map((l) => (
            <Button key={l.id} variant={base === l.id ? 'primary' : 'secondary'} className="!px-3 !py-2 !text-[13px]" aria-pressed={base === l.id} onClick={() => { setBase(l.id); setExcluded(new Set()); }}>
              {l.name}{l.member_count !== null ? <span className="font-mono text-[11.5px] opacity-80">{l.member_count}</span> : null}
            </Button>
          ))}
          {!access.view_all ? <Pill kind="muted">🔒 Resto de la empresa</Pill> : null}
        </div>
        <p className="text-[13px]" aria-live="polite">
          <b>{eligible}</b> {eligible === 1 ? 'destinatario' : 'destinatarios'}
          {sk && sk.revoked > 0 ? ` · ${sk.revoked} excluidos por «no contactar»` : ''}
          {sk && sk.no_consent > 0 ? ` · ${sk.no_consent} sin consentimiento definido` : ''}
          {sk && sk.no_phone > 0 ? ` · ${sk.no_phone} sin teléfono` : ''}
        </p>
        {access.view_all ? (
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5 size-[18px] accent-[var(--accent)]" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.target.checked)} />
            <span>Incluir contactos sin consentimiento definido. <span className="text-muted">Declaro que tengo permiso para escribirles; queda registrado. Quien pidió la baja nunca recibe mensajes.</span></span>
          </label>
        ) : null}
        <RecipientsPicker audience={{ source: audience.source, ...(audience.list_id ? { list_id: audience.list_id } : {}) }} includeUnknown={includeUnknown} excluded={excluded} onExcluded={setExcluded} />
      </section>

      <section className={SECTION} aria-labelledby="camp-s3">
        <h3 id="camp-s3" className={TITLE}>3 · Conexión de WhatsApp</h3>
        {channels.length === 0 ? (
          <p className="text-[13px] text-muted">No tienes una conexión de WhatsApp disponible para campañas. Pídele a tu administrador que te habilite una.</p>
        ) : (
          <>
            <select className={selectCls} aria-label="Conexión" value={channelId} onChange={(e) => pickChannel(e.target.value)}>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {kind ? <div className="flex flex-wrap items-center gap-2"><Pill kind={kind === 'qr' ? 'warn' : 'ok'}>{KIND_TITLE[kind]}</Pill><span className="text-[12px] text-muted">{KIND_HINT[kind]}</span></div> : null}
          </>
        )}
      </section>

      {kind ? (
        <section className={SECTION} aria-labelledby="camp-s4">
          <h3 id="camp-s4" className={TITLE}>4 · Mensaje</h3>
          {kind === 'qr' ? (
            <>
              <div className="rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn"><b>Conexión no oficial.</b> Puede bloquearse si envías muchos mensajes seguidos. Escribe un texto natural y no repitas el mismo mensaje a cientos de personas.</div>
              <textarea className={areaCls} rows={4} maxLength={1000} aria-label="Mensaje" value={body} onFocus={() => setFocus('body')} onChange={(e) => setBody(e.target.value)} placeholder="Escribe el mensaje. Usa {{primer_nombre}} para personalizarlo" />
            </>
          ) : (
            <>
              {templates.isPending ? <p className="text-[13px] text-muted">Cargando plantillas…</p> : null}
              {templates.isError ? <Alert>{campaignError(templates.error, 'No pudimos cargar las plantillas.')}</Alert> : null}
              {templates.isSuccess && templates.data.items.length === 0 ? <p className="text-[13px] text-muted">Esta conexión no tiene plantillas aprobadas todavía. Créalas y apruébalas en Meta y se sincronizan solas.</p> : null}
              {templates.isSuccess && templates.data.items.length > 0 ? (
                <select className={selectCls} aria-label="Plantilla" value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
                  <option value="">Elige una plantilla aprobada…</option>
                  {templates.data.items.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.language} · {t.category === 'marketing' ? 'Marketing' : t.category === 'utility' ? 'Utilidad' : t.category}</option>)}
                </select>
              ) : null}
              {template ? (
                <div className="grid gap-2">
                  <p className="whitespace-pre-wrap rounded-xl bg-surface2 px-3 py-2.5 text-[13px] text-muted">{template.body}</p>
                  {template.variables.map((v) => (
                    <Field key={v.id} label={`Variable {{${v.key}}}`} required hint={v.example ? `Ejemplo: ${v.example}` : undefined}>
                      {(f) => <Input {...f} value={params[v.id] ?? ''} maxLength={500} onFocus={() => setFocus(v.id)} onChange={(e) => setParams((x) => ({ ...x, [v.id]: e.target.value }))} />}
                    </Field>
                  ))}
                  {template.category === 'marketing' ? <Pill kind="warn">Plantilla de marketing: tiene costo en Meta</Pill> : null}
                </div>
              ) : null}
              <p className="text-[12px] text-muted">Fuera de la ventana de 24 h solo se envían plantillas aprobadas. Las plantillas de marketing tienen costo en Meta.</p>
            </>
          )}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Variables">
            <span className="text-[12px] text-muted">Variables:</span>
            {variables.map((v) => <Button key={v} className="!px-2.5 !py-1 !text-[12px]" onClick={() => insert(v)} disabled={kind === 'official' && !template}>{v}</Button>)}
          </div>
          {p?.message ? (
            <div className="rounded-xl border border-line p-3" aria-live="polite">
              <div className="text-[12px] text-muted">Vista previa con {p.message.contact.name}</div>
              <p className="mt-1 whitespace-pre-wrap text-[13.5px]">{p.message.text || 'Completa los datos de la plantilla para verla.'}</p>
              {p.message.missing.length > 0 ? <p className="mt-1 text-[12px] text-warn">A este contacto le falta: {p.message.missing.map((m) => `{{${m}}}`).join(', ')}. A los contactos sin ese dato no se les enviará el mensaje.</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {kind ? (
        <section className={SECTION} aria-labelledby="camp-s5">
          <h3 id="camp-s5" className={TITLE}>5 · Envío</h3>
          <div role="group" aria-label="Cuándo enviar" className="flex flex-wrap gap-2">
            <Button variant={when === 'now' ? 'primary' : 'secondary'} className="!px-3 !py-2 !text-[13px]" aria-pressed={when === 'now'} onClick={() => setWhen('now')}>Enviar ahora</Button>
            <Button variant={when === 'later' ? 'primary' : 'secondary'} className="!px-3 !py-2 !text-[13px]" aria-pressed={when === 'later'} onClick={() => setWhen('later')}>Programar</Button>
          </div>
          {when === 'later' ? <Field label="Día y hora de envío">{(f) => <Input {...f} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}</Field> : null}
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <Field label="Pausa entre mensajes (s)" hint={`Mínimo ${minGap} s en esta conexión`}>
              {(f) => <Input {...f} type="number" inputMode="numeric" min={minGap} max={3600} value={gap} onChange={(e) => setGap(Number(e.target.value))} />}
            </Field>
            <Field label="Máx. por día" hint={maxCap ? `Hasta ${maxCap}` : undefined}>
              {(f) => <Input {...f} type="number" inputMode="numeric" min={1} max={maxCap} value={capNow} onChange={(e) => setCap(Number(e.target.value))} />}
            </Field>
          </div>
          {limits ? (
            <p className="text-[12px] text-muted">
              Límite efectivo: <b>{limits.daily_cap}</b> por día{limits.advisor_cap !== null ? ' (tope fijado por tu administrador)' : ''}
              {kind === 'qr' ? ` · mínimo ${limits.min_gap_seconds} s entre mensajes en conexiones QR` : ''}.{p?.estimate && eligible > 0 ? ` Duración estimada del primer día: ${p.estimate.first_day_minutes} min.` : ''}
            </p>
          ) : null}
          {p?.estimate && p.estimate.days > 1 ? <div><Pill kind="warn">Tienes {eligible} destinatarios y el límite diario es {limits?.daily_cap}: se enviará en {p.estimate.days} días.</Pill></div> : null}
          {kind === 'official' ? <p className="text-[12px] text-muted">Las plantillas de marketing tienen costo en Meta: se estiman {eligible} mensajes.</p> : null}
        </section>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={busy} disabled={!ready}>{editing || draftId ? 'Guardar cambios' : 'Guardar borrador'}</Button>
        <Button variant="primary" loading={busy} disabled={!ready || !access.send || kind !== 'official' || eligible === 0} onClick={() => void send()} title={kind === 'qr' ? 'El envío por WhatsApp QR llega en la próxima versión' : undefined}>{when === 'later' ? 'Programar campaña' : 'Enviar campaña'}</Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
      {kind === 'qr' ? <p className="text-[12px] text-muted">El envío por WhatsApp QR llega en la próxima versión: por ahora puedes guardar el borrador. Las campañas se envían por WhatsApp oficial.</p> : null}
      {confirm ? (
        <LaunchDialog
          campaign={confirm}
          preview={p}
          templateName={template ? template.name : null}
          onClose={() => setConfirm(null)}
          onLaunched={(c) => { setConfirm(null); onLaunched(c); }}
        />
      ) : null}
    </form>
  );
}
