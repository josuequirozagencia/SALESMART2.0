import { BRANDS, useBrand } from '../../ui/brand';
import { ThemeSwitch } from '../../ui/ThemeSwitch';
import { SettingsNav } from '../app/SettingsNav';

/** Configuración › Apariencia: el color de la marca (índigo, verde o rojo) y el modo claro/oscuro. Es una preferencia de este navegador (no cambia lo que ven los demás). */
export function AppearancePage() {
  const [brand, setBrand] = useBrand();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <section aria-label="Color de la marca" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-bold">Color de la marca</h2>
          <p className="text-[12.5px] text-muted">Cambia el acento, los botones y el menú. Se recuerda en este navegador.</p>
        </div>
        <div role="radiogroup" aria-label="Color de la marca" className="flex flex-wrap gap-3">
          {BRANDS.map((b) => (
            <button key={b.id} type="button" role="radio" aria-checked={brand === b.id} onClick={() => setBrand(b.id)} className={`flex min-h-12 items-center gap-3 rounded-xl border px-4 text-[13px] font-semibold ${brand === b.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg hover:bg-surface2'}`}>
              <span aria-hidden="true" className="size-5 rounded-full" style={{ background: b.swatch }} />
              {b.label}
              {brand === b.id ? <span className="sr-only"> (elegido)</span> : null}
            </button>
          ))}
        </div>
      </section>
      <section aria-label="Modo" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-bold">Modo</h2>
        <div className="max-w-xs"><ThemeSwitch /></div>
      </section>
    </div>
  );
}
