import { useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ContextBanner } from '../context/ContextBanner';
import { ViewAsBar } from '../context/ViewAs';
import { useInboxRealtime } from '../inbox/useInboxRealtime';
import { useMyPhoto } from '../photos/usePhotos';
import { useInboxUnread } from '../inbox/useInbox';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { TrialBanner } from '../trial/TrialBanner';
import type { Me, Trial } from '../../lib/types';
import { useBreakpoint } from '../../ui/breakpoints';
import { BottomNav } from '../../ui/BottomNav';
import { SidebarShell } from '../../ui/SidebarShell';
import { useKeyboardOpen } from '../../ui/useKeyboardOpen';
import { AppNavContext } from './AppNav';
import { UtilityBar } from './UtilityBar';
import { buildNavGroups, isChatPath, isInboxMain } from './navGroups';

/**
 * Marco de una empresa cliente (la propia o una que una agencia / el Súper Admin visita): banner de contexto, MENÚ LATERAL plegable (tablet y escritorio) o barra inferior + página `/menu`
 * (móvil, ADR-60), estado de la prueba y la sección elegida. Las secciones nuevas de cada hito se añaden en `navGroups.ts`. En móvil, dentro de una conversación a pantalla completa
 * se ocultan los banners y la barra inferior (la conversación necesita todo el alto).
 */
export function AppShell({ me, trial, onLogout, children }: { me: Me; trial: Trial | null; onLogout: () => void; children: ReactNode }) {
  // «Agentes IA» y «Configuración» solo para quien puede administrar los campos (el servidor lo dice; no se replica la matriz de permisos aquí)
  const admin = useCustomFields().data?.access.manage === true;
  // Conexión en vivo del Inbox: una por persona y empresa; al cambiar de empresa (agencia, soporte) se cierra y se abre la de la nueva
  useInboxRealtime(me.user.id, me.organization.id);
  const { pathname } = useLocation();
  // El Inbox necesita más ancho que el resto de las secciones: lista y hilo, uno al lado del otro
  const inInbox = pathname.startsWith('/inbox');
  const unread = useInboxUnread(!inInbox);
  const mobile = useBreakpoint() === 'mobile';
  const keyboard = useKeyboardOpen();
  const chat = mobile && isChatPath(pathname);
  const showBottom = mobile && !chat && !keyboard;
  // El Inbox ocupa toda la altura de la ventana: sin márgenes ni barra de utilidades (esos botones viven en la cabecera de su lista)
  const flush = isInboxMain(pathname);
  const myPhoto = useMyPhoto();
  const groups = useMemo(() => buildNavGroups({ admin, unread }), [admin, unread]);
  const nav = useMemo(() => ({ me, groups, unread, onLogout }), [me, groups, unread, onLogout]);
  return (
    <AppNavContext.Provider value={nav}>
      <SidebarShell
        me={me}
        groups={groups}
        navLabel="Secciones"
        onLogout={onLogout}
        banner={chat ? null : <><ContextBanner me={me} /><ViewAsBar me={me} /></>}
        wide={inInbox}
        mobileNav="bottom"
        reserveBottom={showBottom}
        flush={flush}
        photoUrl={myPhoto.photo}
      >
        {chat || flush ? null : <UtilityBar me={me} />}
        {trial && !chat ? <TrialBanner trial={trial} role={me.role} /> : null}
        <main className={flush ? 'min-h-0 flex-1' : undefined}>{children}</main>
      </SidebarShell>
      {showBottom ? <BottomNav groups={groups} pathname={pathname} unread={unread} /> : null}
    </AppNavContext.Provider>
  );
}
