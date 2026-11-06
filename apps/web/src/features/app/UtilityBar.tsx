import type { Me } from '../../lib/types';
import { ViewAsMenu } from '../context/ViewAs';
import { NotificationsBell } from '../notifications/NotificationsBell';

/**
 * Los atajos de la persona arriba a la derecha del contenido (tablet y escritorio): la campana de avisos y «Ver como», solo como iconos. Antes vivían en la barra lateral y la llenaban;
 * en móvil están en la cabecera del Menú. Sin ninguno de los dos (permisos), la fila no ocupa lugar.
 */
export function UtilityBar({ me }: { me: Me }) {
  return (
    <div className="-mb-1 hidden items-center justify-end gap-1 empty:hidden md:flex">
      <ViewAsMenu me={me} />
      <NotificationsBell me={me} />
    </div>
  );
}
