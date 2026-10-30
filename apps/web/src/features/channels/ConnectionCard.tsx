import type { ReactNode } from 'react';
import { Pill, type PillKind } from '../../ui/Pill';

/** Estado de una tarjeta de Conexiones: lo mismo para canales e integraciones. */
export type ConnectionStatus = 'connected' | 'attention' | 'disconnected' | 'soon';

export const CONNECTION_STATUS: Record<ConnectionStatus, { kind: PillKind; label: string }> = {
  connected: { kind: 'ok', label: 'Conectada' },
  attention: { kind: 'crit', label: 'Requiere atención' },
  disconnected: { kind: 'muted', label: 'No conectada' },
  soon: { kind: 'info', label: 'Próximamente' },
};

/**
 * Tarjeta de un canal o una integración (M5.9). Nombre, qué hace, estado y, abajo, sus acciones. Las que aún no existen salen como «Próximamente» sin acciones: se ven para que se
 * sepa qué viene, pero no se pueden conectar.
 */
export function ConnectionCard({ name, description, status, badge, note, children }: { name: string; description: string; status: ConnectionStatus; badge?: string; note?: ReactNode; children?: ReactNode }) {
  const st = CONNECTION_STATUS[status];
  return (
    <li aria-label={name} className={`grid content-start gap-3 rounded-2xl border border-line bg-surface p-4 ${status === 'soon' ? 'opacity-80' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
            {name}
            {badge ? <span className="rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">{badge}</span> : null}
          </span>
          <span className="text-[13px] text-muted">{description}</span>
        </div>
        <Pill kind={st.kind}>{st.label}</Pill>
      </div>
      {note ? <div className="text-[12.5px]">{note}</div> : null}
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </li>
  );
}
