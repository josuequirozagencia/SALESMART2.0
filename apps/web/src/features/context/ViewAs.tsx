import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { ROLE_LABEL } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Me, ViewAsRole } from '../../lib/types';
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

/** El selector del menú lateral: aparece solo si el servidor ofrece alguna vista (no hay selector para un Asesor ni en la plataforma). */
export function ViewAsMenu({ me }: { me: Me }) {
  const { viewAs } = useSession();
  const [busy, setBusy] = useState<ViewAsRole | null>(null);
  const [error, setError] = useState<string>();
  if (me.view_as_options.length === 0 || me.viewing_as) return null;
  async function pick(role: ViewAsRole) {
    setError(undefined);
    setBusy(role);
    try {
      await viewAs(role);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos cambiar de vista.'));
      setBusy(null);
    }
  }
  return (
    <section aria-label="Ver como" className="mx-3 mb-2 rounded-xl bg-white/8 px-3 py-2">
      <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-white/50">Ver como</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {me.view_as_options.map((r) => (
          <button
            key={r}
            type="button"
            aria-label={`Ver como ${ROLE_LABEL[r] ?? r}`}
            title={`Mira la aplicación como un ${ROLE_LABEL[r] ?? r} (solo lectura)`}
            disabled={busy !== null}
            onClick={() => void pick(r)}
            className="min-h-9 rounded-lg border border-white/20 px-2.5 py-1 text-[12px] font-semibold text-white/85 hover:bg-white/10 disabled:opacity-60"
          >
            {ROLE_LABEL[r] ?? r}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="mt-1.5 text-[12px] text-white">{error}</p> : null}
    </section>
  );
}
