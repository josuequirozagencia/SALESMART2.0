import { useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { Avatar } from '../../ui/Avatar';
import { BRANDS, useBrand } from '../../ui/brand';
import { CHAT_BG_COLORS, CHAT_BG_GALLERY, CHAT_BG_KINDS, MAX_CHAT_IMAGE_CHARS, chatBgPaint, useChatBackground } from '../../ui/chatBackground';
import { fileToChatBackground } from '../../ui/chatBackgroundImage';
import { Alert, Button } from '../../ui/controls';
import { ThemeSwitch } from '../../ui/ThemeSwitch';
import { useTextSize } from '../../ui/textSize';
import { useMyPhoto } from '../photos/usePhotos';
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

/** «Mi imagen»: se elige un archivo, se reduce en el navegador y se guarda solo aquí (por persona y empresa). */
function CustomImage() {
  const bg = useChatBackground();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setError(undefined);
    setBusy(true);
    try {
      const data = await fileToChatBackground(f);
      if (data.length > MAX_CHAT_IMAGE_CHARS) throw new Error('La imagen sigue siendo muy pesada: prueba con una más pequeña.');
      bg.set({ ...bg.pref, kind: 'image', image: data });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos usar esa imagen.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Elegir una imagen de fondo" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button loading={busy} onClick={() => file.current?.click()}>{bg.pref.image ? 'Cambiar imagen' : 'Subir una imagen'}</Button>
        {bg.pref.image ? <Button onClick={() => bg.set({ kind: 'default', color: bg.pref.color })}>Quitar imagen</Button> : null}
        <span className="text-[12px] text-muted">JPEG, PNG o WebP. Se reduce y se guarda solo en este navegador; no se sube a ningún servidor.</span>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

const MAX_PHOTO = 2 * 1024 * 1024;

/** Mi foto de perfil en esta empresa: la ven las demás personas del equipo junto a mis mensajes. JPEG, PNG o WebP de hasta 2 MB. */
function MyPhoto() {
  const { state } = useSession();
  const me = state.status === 'authed' ? state.me : null;
  const { photo, upload, remove } = useMyPhoto();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const pick = (f: File | undefined): void => {
    if (!f) return;
    setError(undefined);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) return setError('La foto debe ser una imagen JPEG, PNG o WebP.');
    if (f.size > MAX_PHOTO) return setError('La foto pesa demasiado: el máximo es 2 MB.');
    upload.mutate(f, { onError: (e) => setError(friendlyError(e, 'No pudimos subir la foto.')) });
  };
  return (
    <section aria-label="Mi foto" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <h2 className="text-[15px] font-bold">Mi foto</h2>
        <p className="text-[12.5px] text-muted">Se muestra junto a tus mensajes en el Inbox. Solo en esta empresa.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={me?.user.full_name ?? me?.user.email ?? '?'} src={photo} size={72} tone="accent" />
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Elegir una foto" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button loading={upload.isPending} onClick={() => file.current?.click()}>{photo ? 'Cambiar foto' : 'Subir foto'}</Button>
        {photo ? <Button loading={remove.isPending} onClick={() => remove.mutate(undefined, { onError: (e) => setError(friendlyError(e, 'No pudimos quitar la foto.')) })}>Quitar foto</Button> : null}
        <span className="text-[12px] text-muted">JPEG, PNG o WebP, hasta 2 MB</span>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}

/** Configuración › Apariencia: el tema (índigo, verde, rojo o WhatsApp), el modo claro/oscuro/sistema y el fondo del chat. Son preferencias de este navegador (no cambian lo que ven los demás). */
export function AppearancePage() {
  const [brand, setBrand] = useBrand();
  const [textSize, setTextSize] = useTextSize();
  const bg = useChatBackground();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <MyPhoto />
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
      <section aria-label="Tamaño del texto" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-bold">Tamaño del texto</h2>
          <p className="text-[12.5px] text-muted">Solo en pantallas grandes (escritorio). «Compacto» muestra más información; «Cómodo» usa letra un poco más grande. En el celular no cambia.</p>
        </div>
        <div role="radiogroup" aria-label="Tamaño del texto" className="grid gap-2 sm:grid-cols-2">
          {([['compact', 'Compacto'], ['comfortable', 'Cómodo']] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={textSize === id} onClick={() => setTextSize(id)} className={choice(textSize === id)}>{label}</button>
          ))}
        </div>
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
        {bg.pref.kind === 'gallery' ? (
          <div role="radiogroup" aria-label="Fondo de la galería" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {CHAT_BG_GALLERY.map((g) => {
              const paint = chatBgPaint({ kind: 'gallery', color: bg.pref.color, gallery: g.id });
              const on = (bg.pref.gallery ?? 'lines') === g.id;
              return (
                <button key={g.id} type="button" role="radio" aria-checked={on} onClick={() => bg.set({ ...bg.pref, gallery: g.id })} className={`grid min-h-20 items-end overflow-hidden rounded-xl border p-0 text-left text-[12.5px] font-semibold ${on ? 'border-accent ring-2 ring-accent' : 'border-line'}`}>
                  <span aria-hidden="true" style={paint.style} className={`block h-14 w-full ${paint.className}`} />
                  <span className="px-3 py-1.5">{g.label}{on ? <span className="sr-only"> (elegido)</span> : null}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {bg.pref.kind === 'image' ? <CustomImage /> : null}
        <ChatPreview />
      </section>
    </div>
  );
}
