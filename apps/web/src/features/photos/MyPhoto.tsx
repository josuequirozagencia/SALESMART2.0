import { useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { useSession } from '../../lib/session';
import { Avatar } from '../../ui/Avatar';
import { Alert, Button } from '../../ui/controls';
import { useMyPhoto } from './usePhotos';

const MAX_PHOTO = 2 * 1024 * 1024;

/** Mi foto de perfil en esta empresa: la ven las demás personas del equipo junto a mis mensajes. JPEG, PNG o WebP de hasta 2 MB. */
export function MyPhoto() {
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
