import type { PermissionCatalog, PermissionOverrides, TeamRole } from '../../lib/types';
import { Pill } from '../../ui/Pill';
import { isOn, lockedReason, REACH_LABEL, toggle } from './permissions';

/**
 * Permisos de una persona (M10.4, ADR-56 B3): el punto de partida es la plantilla de su rol y cada interruptor la ajusta. El alcance de cada función se ve siempre («Solo lo suyo» o
 * «Toda la empresa») y lo que el rol no permite aparece bloqueado con el motivo: un asesor jamás ve todo, con cualquier combinación. Es solo la forma de capturarlo: el servidor
 * vuelve a validarlo todo (techo del rol y lo que tiene quien lo concede).
 */
export function PermissionsEditor({ role, catalog, value, onChange, disabled }: { role: TeamRole; catalog: PermissionCatalog; value: PermissionOverrides; onChange: (o: PermissionOverrides) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-3">
      {catalog.groups.map((g) => (
        <fieldset key={g.id} className="grid gap-1 rounded-xl border border-line px-3 py-2">
          <legend className="px-1 text-[12.5px] font-semibold uppercase tracking-wide text-muted">{g.label}</legend>
          <ul className="grid">
            {g.items.map((it) => {
              const on = isOn(role, it, value);
              const lock = lockedReason(role, it, value);
              const changed = value.grant.includes(it.key) || value.deny.includes(it.key);
              const off = disabled || lock !== null;
              return (
                <li key={it.key} className="flex items-start justify-between gap-3 border-b border-line/60 py-2 last:border-b-0">
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                      {it.label}
                      <Pill kind={it.reach === 'all' ? 'warn' : it.reach === 'own' ? 'info' : 'muted'}>{REACH_LABEL[it.reach]}</Pill>
                      {changed ? <Pill kind="accent">Ajustado</Pill> : null}
                    </span>
                    <span className="text-[12.5px] text-muted">{it.hint}</span>
                    {lock && !on ? <span className="text-[12px] text-muted">{lock}</span> : null}
                  </span>
                  <label className="flex shrink-0 items-center gap-2 py-1 text-[13px]">
                    <input type="checkbox" role="switch" aria-label={it.label} checked={on} disabled={off} onChange={(e) => onChange(toggle(role, it, value, e.target.checked))} className="size-5" />
                    <span aria-hidden="true" className="w-6 text-muted">{on ? 'Sí' : 'No'}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}
