import { useState } from 'react';
import { shortDateTime } from '../../lib/format';
import type { Contact, ContactTouch } from '../../lib/types';
import { Pill, type PillKind } from '../../ui/Pill';

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
          <span className="inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold text-white" style={{ backgroundColor: t.color }} title={t.is_system ? 'Etiqueta del sistema: la pone el sistema' : undefined}>{t.name}</span>
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

/**
 * «Origen del lead» (M3.3, ADR-45): de qué anuncio de Meta llegó el contacto. 100% de solo lectura y colapsable (no llama al servidor). Solo se muestra si el
 * contacto tiene datos de atribución.
 */
export function AttributionSection({ contact }: { contact: Contact }) {
  const a = contact.attribution;
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  if (!a) return null;
  const last = a.last_touch;
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
          <div>
            <dt className="text-[12px] text-muted">Anuncio</dt>
            <dd className="break-words text-[13px]">{last?.ad ?? '—'}</dd>
          </div>
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
