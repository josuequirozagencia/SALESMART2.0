import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { Channel } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { CATEGORY_KIND, CATEGORY_LABEL, STATUS_KIND, STATUS_LABEL } from '../templates/templateFormat';
import { useChannelTemplates, useSyncTemplates } from './useChannels';

/**
 * Las plantillas de WhatsApp de una conexión (M5.6a, ADR-50): lo que Meta tiene aprobado, en revisión o rechazado para ese número, con el motivo de cada rechazo y de
 * lo que no se puede enviar desde el Inbox. Las plantillas se crean y aprueban en Meta; aquí solo se sincronizan («Sincronizar ahora») y se revisan.
 */
export function TemplatesDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const q = useChannelTemplates(channel.id);
  const sync = useSyncTemplates(channel.id);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const items = q.data?.items ?? [];

  function run() {
    setMessage(undefined);
    sync.mutate(undefined, {
      onSuccess: (r) => setMessage({ kind: 'ok', text: `Sincronizadas ${r.total} plantillas: ${r.added} nuevas, ${r.updated} con cambios y ${r.removed} que ya no están en Meta.` }),
      onError: (e) => setMessage({ kind: 'error', text: friendlyError(e, 'No pudimos sincronizar las plantillas.') }),
    });
  }

  return (
    <Modal title={`Plantillas de ${channel.name}`} onClose={onClose} wide>
      <p className="text-[13px] text-muted">Las plantillas se crean y se aprueban en Meta (WhatsApp Manager); aquí se sincronizan para poder enviarlas desde el Inbox. Se actualizan solas cada 30 minutos.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-muted">{q.data?.synced_at ? `Última sincronización: ${shortDateTime(q.data.synced_at)}` : 'Aún no se han sincronizado.'}</span>
        <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" loading={sync.isPending} onClick={run}>Sincronizar ahora</Button>
      </div>
      {message ? <Alert kind={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</Alert> : null}
      {q.data?.sync_error ? <Alert>La última sincronización falló: {q.data.sync_error}</Alert> : null}
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando plantillas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las plantillas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">Esta conexión no tiene plantillas todavía.</p> : null}
      {items.length > 0 ? (
        <ul aria-label="Plantillas de la conexión" className="grid max-h-[50vh] gap-2 overflow-y-auto pr-1">
          {items.map((t) => (
            <li key={t.id} className="grid gap-1 rounded-xl border border-line p-3">
              <span className="flex flex-wrap items-center gap-1.5">
                <b className="font-mono text-[13px]">{t.name}</b>
                <Pill kind="muted">{t.language}</Pill>
                <Pill kind={CATEGORY_KIND[t.category] ?? 'muted'}>{CATEGORY_LABEL[t.category] ?? t.category}</Pill>
                <Pill kind={STATUS_KIND[t.status] ?? 'muted'}>{STATUS_LABEL[t.status] ?? t.status}</Pill>
                {t.sendable ? <Pill kind="ok">Se puede enviar</Pill> : null}
              </span>
              <span className="line-clamp-2 whitespace-pre-wrap text-[12.5px] text-muted">{t.body}</span>
              {!t.sendable && t.unsupported_reason ? <span className="text-[12.5px] text-warn">{t.unsupported_reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
