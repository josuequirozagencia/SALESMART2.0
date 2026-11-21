import { useState } from 'react';
import { TagBadge } from '../../ui/TagBadge';
import { shortDateTime } from '../../lib/format';
import type { Contact, ContactTouch } from '../../lib/types';
import { ChannelBadge } from '../../ui/ChannelBadge';
import { Pill, type PillKind } from '../../ui/Pill';
import { useAdCreatives, type AdCreative } from './useAdCreatives';

const CAPI: Record<string, [PillKind, string]> = {
  pending: ['info', 'Pendiente de enviar'],
  sent: ['ok', 'Enviado a Meta'],
  cancelled: ['muted', 'Cancelado'],
  failed: ['crit', 'Falló el envío'],
  skipped: ['muted', 'Omitido (sin anuncio de Meta)'],
  expired: ['warn', 'Caducado'],
  blocked: ['warn', 'Bloqueado'],
};

/** Etiquetas del sistema del contacto (Lead, Cita agendada, Venta): solo las pone el sistema. */
export function TagBadges({ tags }: { tags: Contact['tags'] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Etiquetas">
      {tags.map((t) => (
        <li key={t.id}>
          <TagBadge name={t.name} color={t.color} pill {...(t.is_system ? { title: 'Etiqueta del sistema: la pone el sistema' } : {})} />
        </li>
      ))}
    </ul>
  );
}

const short = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
function Touch({ label, t }: { label: string; t: ContactTouch | null }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="text-[13px]">{t ? <>{shortDateTime(t.at)}{t.campaign ? <span className="text-muted"> · {t.campaign}</span> : null}</> : '—'}</dd>
    </div>
  );
}

const NETWORK: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram' };

/**
 * El anuncio de donde llegó el contacto (v20, ADR-55): miniatura, titular, texto, red y su id. El titular es lo que Meta muestra en el anuncio; NO es el nombre del anuncio (Meta no lo entrega en el mensaje).
 * Sin miniatura (el anuncio no la trajo o el almacenamiento no responde) se muestra igual, sin imagen.
 */
export function AdCard({ adId, ad, fallbackTitle }: { adId: string; ad: AdCreative | undefined; fallbackTitle: string | null }) {
  const title = ad?.headline ?? fallbackTitle ?? 'Anuncio sin título';
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface2 p-2.5 min-[520px]:col-span-2" aria-label="Anuncio de origen">
      {ad?.thumbnail_url ? (
        <img src={ad.thumbnail_url} alt={`Miniatura del anuncio «${title}»`} width={64} height={64} loading="lazy" className="h-16 w-16 shrink-0 rounded-lg border border-line object-cover" />
      ) : (
        <div aria-hidden="true" className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-line bg-surface text-[11px] text-muted">Sin imagen</div>
      )}
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-words text-[13px] font-semibold">{title}</span>
          {ad?.platform ? <Pill kind="info">{NETWORK[ad.platform]}</Pill> : null}
        </div>
        {ad?.body ? <p className="line-clamp-2 break-words text-[12.5px] text-muted">{ad.body}</p> : null}
        <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
          <span>ID del anuncio: <code className="rounded bg-surface px-1 py-0.5" title={adId}>{short(adId)}</code></span>
          {ad?.source_url ? <a href={ad.source_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">Ver anuncio</a> : null}
        </p>
      </div>
    </div>
  );
}

/**
 * «Origen del lead» (M3.3, ADR-45): de qué anuncio de Meta llegó el contacto. 100% de solo lectura y colapsable (no llama al servidor). Solo se muestra si el
 * contacto tiene datos de atribución.
 */
export function AttributionSection({ contact }: { contact: Contact }) {
  const a = contact.attribution;
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const adId = a?.last_touch?.ad_id ?? a?.first_touch?.ad_id ?? null;
  const creative = useAdCreatives([adId]);
  // Sin atribución no se inventa nada: texto exacto de V20 §7
  if (!a) return <p aria-label="Origen del lead" className="rounded-xl border border-line px-3 py-2.5 text-[13px] text-muted">Atribución del anuncio no disponible</p>;
  const last = a.last_touch;
  const ad = adId ? creative.data?.items[adId] : undefined;
  const capi = a.capi ? (CAPI[a.capi.status] ?? ['muted', a.capi.status]) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(a!.ctwa_cl_id ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin permiso del portapapeles: el valor sigue visible */
    }
  }

  return (
    <section aria-label="Origen del lead" className="rounded-xl border border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] font-semibold">
        Origen del lead
        <span aria-hidden="true" className={`transition ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      <div className="px-3 pb-2.5" aria-label="Canal del lead">
        <ChannelBadge channel={contact.channel ?? a.channel} />
      </div>
      {open ? (
        <dl className="grid gap-2.5 border-t border-line px-3 py-3 min-[520px]:grid-cols-2">
          <div>
            <dt className="text-[12px] text-muted">Canal de entrada</dt>
            <dd className="text-[13px]">{contact.source === 'meta_ctwa' ? <Pill kind="info">Click to WhatsApp</Pill> : contact.source}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-muted">Campaña</dt>
            <dd className="break-words text-[13px]">{last?.campaign ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-muted">Conjunto de anuncios</dt>
            <dd className="break-words text-[13px]">{last?.adset ?? '—'}</dd>
          </div>
          {adId ? <AdCard adId={adId} ad={ad} fallbackTitle={last?.ad ?? null} /> : null}
          {/* Un nombre real del anuncio (si llegó por el punto de entrada) solo se muestra si no es el mismo texto del titular */}
          {!adId || (last?.ad && last.ad !== (ad?.headline ?? null)) ? (
            <div>
              <dt className="text-[12px] text-muted">{adId ? 'Nombre del anuncio' : 'Anuncio'}</dt>
              <dd className="break-words text-[13px]">{last?.ad ?? '—'}</dd>
            </div>
          ) : null}
          <div className="min-[520px]:col-span-2">
            <dt className="text-[12px] text-muted">CTWA Click ID</dt>
            <dd className="flex items-center gap-2 text-[13px]">
              {a.ctwa_cl_id ? (
                <>
                  <code className="rounded bg-surface2 px-1.5 py-0.5" title={a.ctwa_cl_id}>{short(a.ctwa_cl_id)}</code>
                  <button type="button" onClick={() => void copy()} aria-label="Copiar CTWA Click ID" className="text-[12.5px] font-semibold text-accent hover:underline">{copied ? 'Copiado' : 'Copiar'}</button>
                </>
              ) : '—'}
            </dd>
          </div>
          <Touch label="Primer clic" t={a.first_touch} />
          <Touch label="Último clic" t={a.last_touch} />
          <div className="min-[520px]:col-span-2">
            <dt className="text-[12px] text-muted">Compra enviada a Meta</dt>
            <dd className="text-[13px]">
              {capi ? <><Pill kind={capi[0]}>{capi[1]}</Pill>{a.capi?.sent_at ? <span className="text-muted"> · {shortDateTime(a.capi.sent_at)}</span> : null}</> : <span className="text-muted">Sin compra registrada</span>}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
