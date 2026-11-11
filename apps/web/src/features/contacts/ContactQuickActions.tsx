import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Icon, type IconName } from '../../ui/Icon';

/** Las pestañas de la ficha del contacto a las que llevan las acciones rápidas (más «Datos», donde están las etiquetas). */
export type ContactTab = 'data' | 'notes' | 'tasks' | 'opportunities' | 'activity' | 'ghl' | 'agenda';

const BTN = 'relative grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface2 hover:text-fg focus-visible:text-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent max-md:size-11';

function Action({ icon, label, title, onClick, disabled, badge }: { icon: IconName; label: string; title: string; onClick?: () => void; disabled?: boolean; badge?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      draggable={false}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      className={BTN}
    >
      <Icon name={icon} size={17} />
      {badge && badge > 0 ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-4 text-accent-ink">{badge}</span> : null}
    </button>
  );
}

/**
 * Fila de acciones rápidas de un contacto (v11, S2): la MISMA en las tarjetas del Kanban y en la tabla de Contactos.
 *  · Teléfono — por ahora inactivo («Llamadas aún no disponibles»: no hay telefonía). Cuando la haya, pasa a un enlace `tel:` (decisión del responsable).
 *  · Mensaje — abre la conversación del contacto en el Inbox (la que decide el servidor: la abierta más reciente que la persona pueda ver; si no hay, deshabilitado con «Sin conversaciones»).
 *  · Etiquetas (con el conteo), Nota, Tarea y Calendario — abren la ficha del contacto en esa sección.
 */
export function ContactQuickActions({ contact, onOpenTab }: { contact: { id: string; name: string; tags: ReadonlyArray<unknown> }; onOpenTab: (tab: ContactTab) => void }) {
  const navigate = useNavigate();
  const [chat, setChat] = useState<'idle' | 'loading' | 'none' | 'error'>('idle');
  const openChat = async (): Promise<void> => {
    setChat('loading');
    try {
      const r = await api<{ conversation_id: string }>(`/contacts/${contact.id}/conversation`);
      setChat('idle');
      navigate(`/inbox/${r.conversation_id}`);
    } catch (e) {
      setChat(e instanceof ApiError && (e.status === 404 || e.status === 403) ? 'none' : 'error');
    }
  };
  const name = contact.name;
  return (
    <div role="group" aria-label={`Acciones rápidas de ${name}`} className="flex items-center gap-0.5">
      <Action icon="call" label={`Llamar a ${name}`} title="Llamadas aún no disponibles" disabled />
      <Action
        icon="chat"
        label={chat === 'none' ? `Sin conversaciones con ${name}` : `Abrir la conversación con ${name}`}
        title={chat === 'none' ? 'Sin conversaciones' : chat === 'error' ? 'No pudimos abrir la conversación: inténtalo de nuevo' : 'Abrir la conversación en el Inbox'}
        disabled={chat === 'loading' || chat === 'none'}
        onClick={() => { void openChat(); }}
      />
      <Action icon="tag" label={`Etiquetas de ${name}`} title="Etiquetas" badge={contact.tags.length} onClick={() => onOpenTab('data')} />
      <Action icon="note" label={`Notas de ${name}`} title="Notas" onClick={() => onOpenTab('notes')} />
      <Action icon="task" label={`Tareas de ${name}`} title="Tareas" onClick={() => onOpenTab('tasks')} />
      <Action icon="calendar" label={`Citas de ${name}`} title="Citas" onClick={() => onOpenTab('agenda')} />
    </div>
  );
}
