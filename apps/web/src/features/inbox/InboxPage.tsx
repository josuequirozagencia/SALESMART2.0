import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useParams } from 'react-router-dom';
import { useSession } from '../../lib/session';
import type { InboxFilters } from '../../lib/types';
import { useBreakpoint } from '../../ui/breakpoints';
import { Drawer } from '../../ui/Drawer';
import { useLayoutPrefs } from '../../ui/layoutStore';
import { ResizeHandle } from '../../ui/ResizeHandle';
import { ContactSidebar } from './ContactSidebar';
import { ConversationList } from './ConversationList';
import { CONTACT_OPEN_FROM, CONTACT_RANGE, LIST_RANGE, resolveLayout } from './inboxLayout';
import { Thread, type ThreadLayout } from './Thread';
import { DEFAULT_INBOX_FILTERS, useConversation } from './useInbox';

/** El ancho de una caja, al día cuando cambia (0 = aún no se sabe o no hay `ResizeObserver`: nada se recorta). */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** El panel de contacto de la conversación abierta (los mismos datos que ya traía el hilo; sin pedir nada nuevo). */
function ContactPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useConversation(id);
  return q.data ? <ContactSidebar c={q.data} onClose={onClose} /> : <aside aria-label="Datos del contacto" className="w-full border-l border-line bg-surface" />;
}

/**
 * Inbox (M5.4, ADR-16/50; distribución de la Fase 3 del ADR-60).
 *  · Escritorio (≥ 1280 px): tres columnas —Conversaciones | Chat | Contacto— con divisores arrastrables. El chat es la única columna flexible y nunca baja de 520 px; los paneles no se
 *    superponen. Los anchos y si cada panel está abierto se guardan por persona y empresa (\`ss.inbox.layout.v1:<userId>:<orgId>\`); el de contacto nace plegado bajo 1440 px.
 *  · Tablet (768–1279 px): lista (300/320 px) + chat; el panel de contacto es un cajón encima.
 *  · Móvil (< 768 px): una sola columna —la lista o, si hay una abierta (\`/inbox/:id\`), el hilo—; el contacto es un cajón.
 * La conversación seleccionada vive en la URL; quien no ve todo recibe del servidor solo sus conversaciones. El árbol de elementos es el mismo en todos los tamaños y el hilo nunca
 * cambia de sitio: arrastrar un divisor o plegar un panel no lo reinicia ni pierde el borrador.
 */
export function InboxPage() {
  const { id } = useParams();
  const { state } = useSession();
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_INBOX_FILTERS);
  const me = state.status === 'authed' ? state.me : null;
  const meId = me?.user.id ?? '';
  const bp = useBreakpoint();
  const desktop = bp === 'desktop';

  const [prefs, update] = useLayoutPrefs(meId, me?.organization.id ?? '');
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const listOpen = prefs.listOpen ?? true;
  const contactOpen = prefs.contactOpen ?? (typeof window !== 'undefined' && window.innerWidth >= CONTACT_OPEN_FROM);
  const layout = useMemo(
    () => resolveLayout({ width, listWidth: prefs.listWidth ?? LIST_RANGE.def, contactWidth: prefs.contactWidth ?? CONTACT_RANGE.def, listOpen: listOpen || !id, contactOpen }),
    [width, prefs.listWidth, prefs.contactWidth, listOpen, id, contactOpen],
  );

  // ¿Cabría el panel de contacto si se pidiera ahora? Si no, el botón lo explica en vez de no hacer nada
  const canOpenContact = useMemo(
    () => resolveLayout({ width, listWidth: prefs.listWidth ?? LIST_RANGE.def, contactWidth: prefs.contactWidth ?? CONTACT_RANGE.def, listOpen: listOpen || !id, contactOpen: true }).contactShown,
    [width, prefs.listWidth, prefs.contactWidth, listOpen, id],
  );

  // Cajón del contacto (tablet y móvil): transitorio, ligado a la conversación abierta; no se guarda
  const [drawerFor, setDrawerFor] = useState<string | null>(null);
  const drawerOpen = !desktop && id !== undefined && drawerFor === id;

  // Mientras se arrastra, el ancho va a una variable CSS de la caja (sin re-renderizar el hilo); al soltar se guarda
  const preview = useCallback(
    (name: '--il-list' | '--il-contact', px: number) => {
      rootRef.current?.style.setProperty(name, `${px}px`);
    },
    [rootRef],
  );

  const customized = prefs.listWidth !== undefined || prefs.contactWidth !== undefined || prefs.listOpen !== undefined || prefs.contactOpen !== undefined;
  const threadLayout: ThreadLayout = desktop
    ? {
        contactOpen: layout.contactShown,
        contactBlocked: !layout.contactShown && !canOpenContact,
        onToggleContact: () => update({ contactOpen: !contactOpen }),
        listOpen: listOpen,
        onToggleList: () => update({ listOpen: !listOpen }),
        // Solo se ofrece cuando algo se apartó de lo predeterminado (menos ruido en la cabecera)
        ...(customized ? { onResetLayout: () => update({}, ['listWidth', 'contactWidth', 'listOpen', 'contactOpen']) } : {}),
      }
    : { contactOpen: drawerOpen, onToggleContact: () => setDrawerFor(drawerOpen || !id ? null : id) };

  const vars = desktop ? ({ '--il-list': `${layout.list}px`, '--il-contact': `${layout.contact}px` } as CSSProperties) : undefined;
  return (
    <div
      ref={rootRef}
      style={vars}
      className={`flex min-h-[420px] overflow-hidden rounded-2xl border border-line bg-surface md:h-[calc(100dvh-70px)] ${id ? 'h-[calc(100dvh-32px)]' : 'h-[calc(100dvh-var(--bottom-nav-h)-env(safe-area-inset-bottom)-32px)]'}`}
    >
      {desktop && !layout.listShown ? null : (
        <div key="list" style={desktop ? { width: 'var(--il-list)' } : undefined} className={`min-h-0 shrink-0 ${id ? 'hidden md:flex' : 'flex'} ${desktop ? '' : 'w-full md:w-[300px] lg:w-[320px]'}`}>
          <ConversationList filters={filters} onFilters={setFilters} activeId={id} className="flex w-full min-w-0" />
        </div>
      )}
      {desktop && layout.listShown ? (
        <ResizeHandle
          key="list-handle"
          label="Cambiar el ancho de la lista de conversaciones"
          value={layout.list}
          min={LIST_RANGE.min}
          max={layout.listMax}
          grows={1}
          onPreview={(px) => preview('--il-list', px)}
          onCommit={(px) => update({ listWidth: px })}
          onCollapse={() => update({ listOpen: false })}
          onReset={() => update({}, ['listWidth'])}
        />
      ) : null}
      {id ? (
        <Thread key={id} id={id} meId={meId} layout={threadLayout} />
      ) : (
        <section aria-label="Conversación" className="hidden min-w-0 flex-1 place-content-center gap-1 bg-bg p-8 text-center md:grid">
          <b className="text-[15px]">Elige una conversación</b>
          <span className="text-[13px] text-muted">Aquí verás los mensajes y podrás responder.</span>
        </section>
      )}
      {desktop && id && layout.contactShown ? (
        <ResizeHandle
          key="contact-handle"
          label="Cambiar el ancho de los datos del contacto"
          value={layout.contact}
          min={CONTACT_RANGE.min}
          max={layout.contactMax}
          grows={-1}
          onPreview={(px) => preview('--il-contact', px)}
          onCommit={(px) => update({ contactWidth: px })}
          onCollapse={() => update({ contactOpen: false })}
          onReset={() => update({}, ['contactWidth'])}
        />
      ) : null}
      {desktop && id && layout.contactShown ? (
        <div key="contact" style={{ width: 'var(--il-contact)' }} className="flex min-h-0 shrink-0">
          <ContactPanel id={id} onClose={() => update({ contactOpen: false })} />
        </div>
      ) : null}
      {drawerOpen && id ? (
        <Drawer label="Datos del contacto" onClose={() => setDrawerFor(null)}>
          <ContactPanel id={id} onClose={() => setDrawerFor(null)} />
        </Drawer>
      ) : null}
    </div>
  );
}
