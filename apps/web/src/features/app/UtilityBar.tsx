import type { Me } from '../../lib/types';
import { ViewAsMenu } from '../context/ViewAs';
import { ThemeToggle } from '../../ui/ThemeToggle';
import { NotificationsBell } from '../notifications/NotificationsBell';

/**
 * Los atajos de la persona arriba a la derecha del contenido (tablet y escritorio): «Ver como», el modo claro/oscuro y la campana de avisos, solo como iconos. Antes vivían en la barra lateral y la llenaban;
 * en móvil están en la cabecera del Menú. Sin «Ver como» ni avisos (permisos), quedan solo el modo y la campana.
 */
export function UtilityBar({ me }: { me: Me }) {
  return (
    <div className="-mb-1 hidden items-center justify-end gap-1 md:flex">
      <ViewAsMenu me={me} />
      <ThemeToggle />
      <NotificationsBell me={me} />
    </div>
  );
}
