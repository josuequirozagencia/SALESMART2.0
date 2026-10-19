import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { initials } from '../../lib/format';
import type { Queue } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { NewQueueDialog } from './NewQueueDialog';
import { MODE_SHORT, QueueDialog } from './QueueDialog';
import { useQueues } from './useQueues';

function QueueCard({ q, onOpen }: { q: Queue; onOpen: () => void }) {
  const team = q.members.filter((m) => m.active);
  return (
    <button type="button" aria-label={`Configurar ${q.name}`} onClick={onOpen} className="grid h-full w-full content-start overflow-hidden rounded-2xl border border-line bg-surface text-left transition hover:border-accent">
      <span aria-hidden="true" className="block h-2" style={{ backgroundColor: q.color }} />
      <span className="grid gap-2.5 p-4">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <b className="text-[15px]">{q.name}</b>
          <Pill kind={q.distribution_on ? 'ok' : 'muted'}>{q.distribution_on ? 'Reparto activo' : 'Reparto manual'}</Pill>
        </span>
        {!q.open_now ? <span><Pill kind="muted">Cerrada ahora</Pill></span> : null}
        <span className="flex items-center gap-2 text-[12.5px] text-muted">
          {team.length > 0 ? (
            <>
              <span className="flex -space-x-1.5" aria-hidden="true">{team.slice(0, 4).map((m) => <span key={m.user_id} className="grid size-6 place-items-center rounded-full border border-surface bg-accent-soft text-[10px] font-bold text-accent">{initials(m.name)}</span>)}</span>
              {team.length} {team.length === 1 ? 'asesor' : 'asesores'}
            </>
          ) : 'Sin asesores activos'}
        </span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          <span>Reparto: <b className="font-semibold text-fg">{q.distribution_on ? MODE_SHORT[q.mode] : 'Manual'}</b></span>
          <span>Conexiones: <b className="font-semibold text-fg">{q.channels.length}</b></span>
        </span>
        {q.unassigned_count > 0 ? <span><Pill kind="warn">{q.unassigned_count} sin asignar</Pill></span> : null}
      </span>
    </button>
  );
}

/**
 * Configuración › Colas (M5.3, ADR-07). Cada cola es un equipo: decide a qué asesor va una conversación nueva. Solo `queues.manage` (el administrador). El horario,
 * el reasignar por falta de respuesta y los mensajes de la cola llegan con el SLA (M5.5); el catálogo de productos, con las ventas (M6).
 */
export function QueuesPage() {
  const q = useQueues();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const items = q.data?.items ?? [];
  const open = openId ? items.find((x) => x.id === openId) : undefined;
  const max = q.data?.limits.max_queues;

  return (
    <div className="grid gap-4">
      <SettingsNav />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[680px] text-[13.5px] text-muted">
          Una cola es un equipo: define sus asesores y cómo se reparten las conversaciones nuevas. Cada conexión de WhatsApp envía sus conversaciones a una cola (se elige en Conexiones) y la cola decide el asesor.
        </p>
        {q.isSuccess ? <Button variant="primary" disabled={max !== undefined && items.length >= max} onClick={() => setCreating(true)}>Nueva cola</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando colas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar las colas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}

      {q.isSuccess ? (
        items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[13.5px] text-muted">Aún no hay colas. Crea la primera con «Nueva cola»: sin cola, las conversaciones nuevas quedan sin asignar.</p>
        ) : (
          <ul aria-label="Colas" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((x) => <li key={x.id}><QueueCard q={x} onOpen={() => setOpenId(x.id)} /></li>)}
          </ul>
        )
      ) : null}

      {creating ? <NewQueueDialog onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); setOpenId(created.id); }} /> : null}
      {open ? <QueueDialog key={open.id} queue={open} onClose={() => setOpenId(undefined)} /> : null}
    </div>
  );
}
