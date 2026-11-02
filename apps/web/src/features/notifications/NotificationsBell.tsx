import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { AppNotification, Me } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications, useUnreadNotifications } from './useNotifications';

/** Qué dice un aviso: una mención en una nota, «te asignaron una tarea» o «tu tarea vence / venció» (F1 y F2, ADR-57 y ADR-58). */
function textOf(n: AppNotification): string {
  if (n.type === 'task_assigned') return n.actor ? `${n.actor.name} te asignó la tarea «${n.task?.title ?? 'sin título'}»` : `Se te asignó la tarea «${n.task?.title ?? 'sin título'}»`;
  if (n.type === 'task_due') {
    const due = n.task?.due_at ?? null;
    const past = due !== null && new Date(due).getTime() <= Date.now();
    return `La tarea «${n.task?.title ?? 'sin título'}» ${past ? 'venció' : 'vence'}${due ? ` ${shortDateTime(due)}` : ''}`;
  }
  return `${n.actor?.name ?? 'Alguien'} te mencionó en una nota de la conversación con ${n.conversation?.contact.name ?? 'un contacto'}`;
}

/** A dónde lleva un aviso: la conversación de una mención o la tarea (se abre en «Tareas»). */
const hrefOf = (n: AppNotification): string => (n.type === 'mention' ? `/inbox/${n.conversation?.id ?? ''}` : `/tasks?task=${n.task?.id ?? ''}`);

function Item({ n, canMark, onOpen }: { n: AppNotification; canMark: boolean; onOpen: () => void }) {
  const mark = useMarkNotificationRead();
  const unread = n.read_at === null;
  return (
    <li className={`rounded-xl border px-3 py-2.5 text-[13px] ${unread ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}>
      <Link
        to={hrefOf(n)}
        onClick={() => { if (unread && canMark) mark.mutate(n.id); onOpen(); }}
        className="grid gap-0.5 focus-visible:outline-none"
      >
        <span className="flex items-start justify-between gap-2">
          <b className={unread ? '' : 'font-semibold'}>{textOf(n)}</b>
          {unread ? <span role="img" aria-label="Sin leer" className="mt-1 size-2 shrink-0 rounded-full bg-accent" /> : null}
        </span>
        {n.excerpt ? <span className="line-clamp-2 whitespace-pre-wrap text-muted">{n.excerpt}</span> : null}
        <time dateTime={n.created_at} className="text-[11.5px] text-muted">{shortDateTime(n.created_at)}</time>
      </Link>
    </li>
  );
}

function Panel({ canMark, onClose }: { canMark: boolean; onClose: () => void }) {
  const q = useNotifications(true);
  const all = useMarkAllNotificationsRead();
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const unread = q.data?.pages[0]?.unread ?? 0;
  return (
    <Modal title="Avisos" onClose={onClose} wide>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{unread > 0 ? `${unread} sin leer` : 'Estás al día.'}</p>
        {canMark && unread > 0 ? <Button className="!px-3 !py-1 !text-[12.5px]" loading={all.isPending} onClick={() => all.mutate()}>Marcar todo como leído</Button> : null}
      </div>
      {all.isError ? <Alert>{friendlyError(all.error, 'No pudimos marcar los avisos como leídos.')}</Alert> : null}
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando avisos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los avisos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">Todavía no tienes avisos. Aquí aparecerá cuando alguien te mencione con «@» en una nota, te asignen una tarea o una tarea tuya esté por vencer.</p> : null}
      {items.length > 0 ? <ul aria-label="Avisos" className="grid max-h-[55vh] gap-1.5 overflow-y-auto">{items.map((n) => <Item key={n.id} n={n} canMark={canMark} onOpen={onClose} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}

/**
 * Campana de avisos del menú lateral (F1, ADR-57; F2, ADR-58): el contador de lo que no se ha leído y un panel con los avisos (menciones «@» en notas y avisos de tareas). Si la persona no puede ver avisos
 * (permiso o error), no se muestra. «Ver como» y el acceso de solo lectura ven los avisos pero no los pueden marcar como leídos (el servidor lo rechazaría).
 */
export function NotificationsBell({ me }: { me: Me }) {
  const unread = useUnreadNotifications();
  const [open, setOpen] = useState(false);
  if (unread === null) return null;
  const canMark = !me.read_only && !me.viewing_as;
  return (
    <>
      <button
        type="button"
        aria-label={unread > 0 ? `Avisos (${unread} sin leer)` : 'Avisos'}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="mx-3 mb-2 flex min-h-11 items-center gap-2.5 rounded-xl bg-white/8 px-3 py-2 text-left text-[13px] font-semibold text-white/90 hover:bg-white/12"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8z" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></svg>
        <span className="flex-1">Avisos</span>
        {unread > 0 ? <span aria-hidden="true" className="grid min-w-5 place-items-center rounded-full bg-crit px-1.5 text-[11px] font-bold leading-5 text-white">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
      {open ? <Panel canMark={canMark} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
