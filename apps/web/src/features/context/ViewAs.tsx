import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { friendlyError } from '../../lib/errors';
import { ROLE_LABEL } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Me } from '../../lib/types';
import { Button } from '../../ui/controls';

/**
 * «Ver como» (M10.5, ADR-56 B4): mirar la aplicación como la vería otro ROL, para comprobar menús, pantallas y botones antes de invitar a alguien. Solo REDUCE lo que la persona ya
 * puede y es de SOLO LECTURA: el servidor aplica todo (permisos y 403 `VIEW_AS_READ_ONLY` en cada petición); esta pantalla solo ofrece el selector y la barra con la salida.
 */

/** Barra permanente mientras se mira como otro rol: no se puede ocultar y siempre trae la salida. En pantallas angostas la etiqueta también está en la barra superior del menú. */
export function ViewAsBar({ me }: { me: Me }) {
  const { viewAs } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!me.viewing_as) return null;
  async function back() {
    setError(undefined);
    setBusy(true);
    try {
      await viewAs(null);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos volver a tu vista. Inténtalo de nuevo.'));
      setBusy(false);
    }
  }
  return (
    <div role="region" aria-label="Viendo como otro rol" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warn bg-warn-soft px-5 py-2.5 text-[13px] text-warn lg:sticky lg:top-0 lg:z-[45]">
      <p className="min-w-0 font-semibold">
        Viendo como <b>{ROLE_LABEL[me.viewing_as] ?? me.viewing_as}</b> · Solo lectura
        <span className="hidden font-normal sm:inline"> · Así lo vería esa persona; no puedes hacer cambios desde aquí.</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {error ? <span role="alert" className="text-crit">{error}</span> : null}
        <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" loading={busy} onClick={() => void back()}>Volver a mi vista</Button>
      </div>
    </div>
  );
}

/**
 * «Ver como» (M10.5): un solo icono (ojo) que despliega las vistas disponibles. Aparece solo si el servidor ofrece alguna vista (no hay selector para un Asesor ni en la plataforma) y
 * se oculta mientras se está mirando como otro rol (ahí manda la barra permanente).
 */
export function ViewAsMenu({ me }: { me: Me }) {
  const { viewAs } = useSession();
  const [error, setError] = useState<string>();
  if (me.view_as_options.length === 0 || me.viewing_as) return null;
  const items = me.view_as_options.map((r) => ({
    label: `Ver como ${ROLE_LABEL[r] ?? r}`,
    onSelect: () => {
      setError(undefined);
      viewAs(r).catch((e: unknown) => setError(friendlyError(e, 'No pudimos cambiar de vista.')));
    },
  }));
  return (
    <div className="relative">
      <Menu label="Ver como" items={items} buttonClass="relative grid size-11 place-items-center rounded-full text-muted transition-colors hover:bg-surface2 hover:text-fg md:size-10">
        <Icon name="eye" size={20} />
      </Menu>
      {error ? <p role="alert" className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[12px] font-semibold text-crit">{error}</p> : null}
    </div>
  );
}
