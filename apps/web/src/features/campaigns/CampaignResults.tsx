import { useState } from 'react';
import { saveBlob } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { channelLabel, percent, RECIPIENT_STATUS_KIND, RECIPIENT_STATUS_LABEL, RECIPIENT_STATUS_ORDER, SKIP_REASON_LABEL } from './labels';
import { exportCampaign, useCampaignResults, type Campaign, type CampaignRecipient, type RecipientStatus } from './useCampaigns';

const n = (v: number): string => v.toLocaleString('es-EC');
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : '');
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';

/** La línea de detalle de un destinatario: por qué se omitió, qué falló o cuándo respondió. */
function detail(r: CampaignRecipient): string {
  const v = r.variant !== null ? ` · versión ${r.variant}` : '';
  if (r.status === 'skipped') return r.skip_reason ? SKIP_REASON_LABEL[r.skip_reason] : '';
  if (r.status === 'failed') return `${r.error ?? 'No se pudo enviar'}${v}`;
  if (r.status === 'replied') return `${when(r.replied_at)}${r.opted_out_at ? ' · pidió la baja' : ''}${v}`;
  if (r.opted_out_at) return `Pidió la baja${v}`;
  return `${when(r.sent_at)}${v}`;
}

/**
 * El informe de una campaña (v17 · 17.5, prototipo `openCampRes`): los totales con las tasas y cada destinatario con su estado (Respondió, Leído, Entregado, Enviado, Fallido, Omitido…), por páginas y
 * filtrable, más el CSV. «Respondió» cuenta la primera respuesta dentro de las 72 h posteriores al envío; quien respondió «BAJA» o «STOP» queda marcado y ya no recibe nada. Un borrador no tiene
 * resultados: se muestran los totales en cero y se explica.
 */
export function ResultsDialog({ c, onClose }: { c: Campaign; onClose: () => void }) {
  const draft = c.status === 'draft';
  const [status, setStatus] = useState<RecipientStatus | null>(null);
  const live = c.status === 'running' || c.status === 'scheduled';
  const q = useCampaignResults(c.id, status, !draft, live);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const first = q.data?.pages[0];
  const s = first?.summary;
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);
  const k = c.counts;
  const cells: Array<[string, number]> = s
    ? [['Destinatarios', s.recipients], ['Enviados', s.sent], ['Entregados', s.delivered], ['Leídos', s.read], ['Respondieron', s.replied], ['Fallidos', s.failed]]
    : [['Destinatarios', k.total], ['Enviados', k.sent], ['Entregados', k.delivered], ['Leídos', k.read], ['Respondieron', k.replied], ['Fallidos', k.failed]];

  const download = (): void => {
    setError(undefined);
    setExporting(true);
    exportCampaign(c.id)
      .then(saveBlob)
      .catch((e: unknown) => setError(friendlyError(e, 'No pudimos descargar el informe.')))
      .finally(() => setExporting(false));
  };

  return (
    <Modal title={c.name} onClose={onClose} wide>
      <p className="text-[13px] text-muted">{channelLabel(c)} · creada por {c.created_by.name || 'una persona del equipo'}</p>
      <dl className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
        {cells.map(([label, v]) => (
          <div key={label} className="rounded-xl border border-line p-3"><dt className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}</dt><dd className="text-[22px] font-bold">{n(v)}</dd></div>
        ))}
      </dl>
      {draft ? <Alert kind="info">Esta campaña es un borrador: todavía no se envió, por eso los resultados están en cero.</Alert> : null}
      {s ? (
        <ul aria-label="Tasas y omitidos" className="flex flex-wrap gap-2 text-[12.5px]">
          <li><Pill kind="info">Entrega {percent(s.delivery_rate)}</Pill></li>
          <li><Pill kind="ok">Respuesta {percent(s.reply_rate)}</Pill></li>
          {s.waiting > 0 ? <li><Pill kind="warn">Por enviar {n(s.waiting)}</Pill></li> : null}
          {s.skipped > 0 ? <li><Pill kind="muted">Omitidos {n(s.skipped)}</Pill></li> : null}
          {s.opted_out > 0 ? <li><Pill kind="crit">Pidieron la baja {n(s.opted_out)}</Pill></li> : null}
        </ul>
      ) : null}
      {!draft ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[13px]">Estado
              <select value={status ?? ''} onChange={(e) => setStatus((e.target.value || null) as RecipientStatus | null)} className={selectCls}>
                <option value="">Todos</option>
                {RECIPIENT_STATUS_ORDER.map((st) => <option key={st} value={st}>{RECIPIENT_STATUS_LABEL[st]}</option>)}
              </select>
            </label>
            <Button loading={exporting} onClick={download}>Descargar CSV</Button>
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando los destinatarios" /></div> : null}
          {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los destinatarios.')}</Alert> : null}
          {q.data ? (
            items.length === 0 ? <p className="text-[13px] text-muted">{status ? 'Ningún destinatario con ese estado.' : 'Esta campaña no tiene destinatarios.'}</p> : (
              <div className="max-h-[320px] overflow-auto rounded-xl border border-line">
                <table className="w-full min-w-[420px] text-left text-[13px]">
                  <thead className="sticky top-0 bg-surface text-[11.5px] uppercase tracking-wide text-muted"><tr><th scope="col" className="px-3 py-2">Destinatario</th><th scope="col" className="px-3 py-2">Estado</th><th scope="col" className="px-3 py-2">Detalle</th></tr></thead>
                  <tbody>
                    {items.map((r) => (
                      <tr key={r.id} className="border-t border-line">
                        <td className="px-3 py-2"><b>{r.contact.name}</b><div className="font-mono text-[11.5px] text-muted">{r.phone ?? 'Sin teléfono'}</div></td>
                        <td className="px-3 py-2"><Pill kind={RECIPIENT_STATUS_KIND[r.status]}>{RECIPIENT_STATUS_LABEL[r.status]}</Pill></td>
                        <td className="px-3 py-2 text-[12px] text-muted">{detail(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
          {q.hasNextPage ? <div className="flex justify-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más</Button></div> : null}
          <p className="text-[12px] text-muted">Los números se actualizan con los estados que reporta WhatsApp (enviado, entregado, leído). «Respondió» cuenta la primera respuesta dentro de las 72 h posteriores al envío.</p>
        </>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
