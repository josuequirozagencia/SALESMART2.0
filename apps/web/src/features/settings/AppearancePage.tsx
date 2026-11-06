import { BRANDS, useBrand } from '../../ui/brand';
import { CHAT_BG_COLORS, CHAT_BG_KINDS, useChatBackground } from '../../ui/chatBackground';
import { ThemeSwitch } from '../../ui/ThemeSwitch';
import { SettingsNav } from '../app/SettingsNav';

const choice = (on: boolean): string => `flex min-h-12 items-center gap-3 rounded-xl border px-4 text-[13px] font-semibold ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg hover:bg-surface2'}`;

/** Una burbuja entrante y una saliente sobre el fondo elegido: lo que se verá en el chat. */
function ChatPreview() {
  const bg = useChatBackground();
  return (
    <div aria-label="Vista previa del chat" role="img" style={bg.style} className={`grid gap-2 rounded-xl border border-line p-4 ${bg.className}`}>
      <span className="max-w-[70%] rounded-lg rounded-tl-sm border border-line bg-[var(--bubble-in)] px-3 py-2 text-[13px] text-fg shadow-sm">Hola, ¿qué servicios ofrecen?</span>
      <span className="ml-auto max-w-[70%] rounded-lg rounded-tr-sm bg-[var(--bubble-out)] px-3 py-2 text-[13px] text-fg shadow-sm">¡Hola! Con gusto te cuento.</span>
    </div>
  );
}

/** Configuración › Apariencia: el tema (índigo, verde, rojo o WhatsApp), el modo claro/oscuro/sistema y el fondo del chat. Son preferencias de este navegador (no cambian lo que ven los demás). */
export function AppearancePage() {
  const [brand, setBrand] = useBrand();
  const bg = useChatBackground();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <section aria-label="Tema" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-bold">Tema</h2>
          <p className="text-[12.5px] text-muted">Cambia el acento, los botones, el menú y las burbujas. Se recuerda en este navegador.</p>
        </div>
        <div role="radiogroup" aria-label="Tema" className="flex flex-wrap gap-3">
          {BRANDS.map((b) => (
            <button key={b.id} type="button" role="radio" aria-checked={brand === b.id} onClick={() => setBrand(b.id)} className={choice(brand === b.id)}>
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
      <section aria-label="Fondo del chat" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-bold">Fondo del chat</h2>
          <p className="text-[12.5px] text-muted">El fondo detrás de las burbujas en el Inbox. Se recuerda en este navegador.</p>
        </div>
        <div role="radiogroup" aria-label="Fondo del chat" className="flex flex-wrap gap-3">
          {CHAT_BG_KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={bg.pref.kind === k.id} title={k.hint} onClick={() => bg.set({ ...bg.pref, kind: k.id })} className={choice(bg.pref.kind === k.id)}>
              {k.label}
              {bg.pref.kind === k.id ? <span className="sr-only"> (elegido)</span> : null}
            </button>
          ))}
        </div>
        {bg.pref.kind === 'color' ? (
          <div role="radiogroup" aria-label="Color del fondo" className="flex flex-wrap gap-3">
            {CHAT_BG_COLORS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={bg.pref.color === c.id} onClick={() => bg.set({ ...bg.pref, color: c.id })} className={choice(bg.pref.color === c.id)}>
                <span aria-hidden="true" className="size-5 rounded-full border border-line" style={{ background: c.hue }} />
                {c.label}
                {bg.pref.color === c.id ? <span className="sr-only"> (elegido)</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <ChatPreview />
      </section>
    </div>
  );
}
