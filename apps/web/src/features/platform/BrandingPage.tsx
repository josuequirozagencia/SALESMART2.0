import { useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { Alert, Button, Spinner } from '../../ui/controls';
import { FAVICON_ACCEPT, faviconProblem, refreshTabIcon, useBranding, useClearFavicon, useUploadFavicon } from './useBranding';

const src = (version: string | null): string => `/v1/branding/favicon?v=${encodeURIComponent(version ?? 'default')}`;

/** Una pestaña de ejemplo con el icono: así se ve cómo quedará en el navegador. */
function TabPreview({ version }: { version: string | null }) {
  return (
    <div aria-label="Vista previa de la pestaña del navegador" role="img" className="inline-flex max-w-full items-center gap-2 rounded-t-xl border border-b-0 border-line bg-surface2 px-3 py-2 text-[12.5px]">
      <img src={src(version)} alt="" width={16} height={16} className="size-4 shrink-0" />
      <span className="truncate">Sales Smart 2.0</span>
    </div>
  );
}

/**
 * Plataforma › Marca (v11 S3, solo Súper Admin): el favicon de la aplicación. Se sube una imagen PNG, ICO o WebP cuadrada de 32 a 512 px y hasta 256 KB (SVG no: puede llevar scripts); el servidor
 * valida el contenido real del archivo. Sin favicon subido se usa el icono por omisión. El navegador guarda el icono unos minutos: en otras pestañas puede tardar en cambiar.
 */
export function BrandingPage() {
  const q = useBranding();
  const upload = useUploadFavicon();
  const clear = useClearFavicon();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<string>();
  const [confirming, setConfirming] = useState(false);

  const pick = (f: File | undefined): void => {
    if (!f) return;
    setDone(undefined);
    const bad = faviconProblem(f);
    if (bad) return setProblem(bad);
    setProblem(undefined);
    upload.mutate(f, {
      onSuccess: (v) => { refreshTabIcon(v.version); setDone('Favicon actualizado. En otras pestañas del navegador puede tardar unos minutos en verse.'); },
      onError: (e) => setProblem(friendlyError(e, 'No pudimos subir el favicon.')),
    });
  };
  const remove = (): void => {
    setProblem(undefined);
    setDone(undefined);
    clear.mutate(undefined, {
      onSuccess: (v) => { setConfirming(false); refreshTabIcon(v.version); setDone('Favicon quitado: la plataforma vuelve al icono por omisión.'); },
      onError: (e) => { setConfirming(false); setProblem(friendlyError(e, 'No pudimos quitar el favicon.')); },
    });
  };

  if (q.isPending) return <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la marca" /></div>;
  if (q.isError) return <Alert>{friendlyError(q.error, 'No pudimos cargar la marca.')}</Alert>;
  const v = q.data;
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-[18px] font-bold">Marca</h2>
        <p className="text-[12.5px] text-muted">El icono que aparece en la pestaña del navegador de toda la plataforma.</p>
      </div>
      <section aria-label="Favicon" className="grid gap-4 rounded-2xl border border-line bg-surface p-4">
        <h3 className="text-[15px] font-bold">Favicon</h3>
        <div className="flex flex-wrap items-center gap-5">
          <img src={src(v.version)} alt="Favicon actual" width={64} height={64} className="size-16 rounded-xl border border-line bg-surface2 object-contain p-1" />
          <div className="grid gap-1.5">
            <TabPreview version={v.version} />
            <p className="text-[12.5px] text-muted">
              {v.has_favicon ? <>Imagen propia · {v.px} × {v.px} px · {Math.max(1, Math.round((v.bytes ?? 0) / 1024))} KB{v.updated_at ? ` · subida el ${shortDateTime(v.updated_at)}` : ''}</> : 'Todavía no subes uno: se usa el icono por omisión.'}
            </p>
          </div>
        </div>

        <ul className="grid gap-1 text-[12.5px] text-muted" aria-label="Requisitos del archivo">
          <li>Formato PNG, ICO o WebP (no se aceptan SVG).</li>
          <li>Cuadrado, de 32 a 512 px de lado (recomendado: 64 o 128 px).</li>
          <li>Hasta 256 KB.</li>
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <input ref={file} type="file" accept={FAVICON_ACCEPT} aria-label="Elegir un favicon" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          <Button variant="primary" loading={upload.isPending} onClick={() => file.current?.click()}>{v.has_favicon ? 'Cambiar favicon' : 'Subir favicon'}</Button>
          {v.has_favicon && !confirming ? <Button onClick={() => setConfirming(true)}>Quitar favicon</Button> : null}
          {confirming ? (
            <span role="group" aria-label="Confirmar quitar el favicon" className="inline-flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3 py-1.5 text-[12.5px] text-warn">
              ¿Quitar el favicon y volver al icono por omisión?
              <Button loading={clear.isPending} onClick={remove}>Sí, quitar</Button>
              <Button onClick={() => setConfirming(false)}>No</Button>
            </span>
          ) : null}
        </div>
        {problem ? <Alert>{problem}</Alert> : null}
        {done ? <Alert kind="ok">{done}</Alert> : null}
      </section>
    </div>
  );
}
