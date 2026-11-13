import { useRef, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { testSound, type SoundTestResult } from '../../lib/notifySound';
import { DEFAULT_BRAND_NAME, useBrand } from '../../lib/platformBrand';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { showTestNotification, type TestNotificationResult } from './testNotification';
import { ICON_ACCEPT, iconProblem, LOGO_ACCEPT, logoProblem, SOUND_ACCEPT, SOUND_ADVISED_SECONDS, soundDuration, soundProblem, useBranding, useClearIcon, useClearLogo, useClearSound, useSetName, useUploadIcon, useUploadLogo, useUploadSound, type BrandingFile, type BrandingView } from './useBranding';

const kb = (bytes: number): number => Math.max(1, Math.round(bytes / 1024));

/** Una pestaña de ejemplo con el icono y el título: así se ve cómo quedará en el navegador. */
function TabPreview({ version, name }: { version: string; name: string }) {
  return (
    <div aria-label="Vista previa de la pestaña del navegador" role="img" className="inline-flex max-w-full items-center gap-2 rounded-t-xl border border-b-0 border-line bg-surface2 px-3 py-2 text-[12.5px]">
      <img src={`/v1/branding/favicon?v=${encodeURIComponent(version)}`} alt="" width={16} height={16} className="size-4 shrink-0" />
      <span className="truncate">Inbox · {name}</span>
    </div>
  );
}

/** «¿Quitar?» con confirmación en la misma línea. */
function RemoveButton({ label, question, busy, onConfirm }: { label: string; question: string; busy: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span role="group" aria-label={`Confirmar: ${label.toLowerCase()}`} className="inline-flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3 py-1.5 text-[12.5px] text-warn">
      {question}
      <Button loading={busy} onClick={() => { onConfirm(); setAsking(false); }}>Sí, quitar</Button>
      <Button onClick={() => setAsking(false)}>No</Button>
    </span>
  );
}

const card = 'grid gap-4 rounded-2xl border border-line bg-surface p-4';

function NameSection({ v }: { v: BrandingView }) {
  const set = useSetName();
  const [name, setName] = useState(v.name ?? '');
  const [short, setShort] = useState(v.short_name ?? '');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setDone(undefined);
    const n = name.trim();
    if (n !== '' && (n.length < 2 || n.length > 40)) return setError('El nombre debe tener de 2 a 40 caracteres.');
    if (/[<>]/.test(n) || /[<>]/.test(short)) return setError('El nombre no puede llevar «<» ni «>».');
    if (n === '' && short.trim() !== '') return setError('Escribe primero el nombre completo: el nombre corto es una versión de ese nombre.');
    if (short.trim().length > 12) return setError('El nombre corto puede tener hasta 12 caracteres.');
    setError(undefined);
    set.mutate({ name: n === '' ? null : n, short_name: short.trim() === '' ? null : short.trim() }, { onSuccess: (r) => { setName(r.name ?? ''); setShort(r.short_name ?? ''); setDone('Nombre guardado.'); }, onError: (e2) => setError(friendlyError(e2, 'No pudimos guardar el nombre.')) });
  };
  const restore = (): void => {
    setDone(undefined);
    set.mutate({ name: null, short_name: null }, { onSuccess: () => { setName(''); setShort(''); setError(undefined); setDone(`Nombre restaurado: «${DEFAULT_BRAND_NAME}».`); }, onError: (e2) => setError(friendlyError(e2, 'No pudimos restaurar el nombre.')) });
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Nombre de la plataforma" className={card}>
      <h3 className="text-[15px] font-bold">Nombre de la plataforma</h3>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Es el texto de la pestaña del navegador («Sección · Nombre») y el nombre de la aplicación instalada. No cambia el nombre de los correos de la plataforma (por ahora siguen igual).</p>
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-[2fr_1fr]">
        <Field label="Nombre" hint={`De 2 a 40 caracteres. Vacío = «${v.default_name}».`}>{(f) => <Input {...f} value={name} maxLength={40} placeholder={v.default_name} onChange={(e) => { setName(e.target.value); setDone(undefined); }} />}</Field>
        <Field label="Nombre corto (opcional)" hint="Hasta 12 caracteres, para el icono instalado.">{(f) => <Input {...f} value={short} maxLength={12} onChange={(e) => { setShort(e.target.value); setDone(undefined); }} />}</Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {done ? <Alert kind="ok">{done}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={set.isPending}>Guardar nombre</Button>
        {v.name !== null ? <Button type="button" onClick={restore}>Restaurar valor por defecto</Button> : null}
      </div>
    </form>
  );
}

function IconSection({ v }: { v: BrandingView }) {
  const upload = useUploadIcon();
  const clear = useClearIcon();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<string>();
  const version = v.icon.version ?? 'default-1';
  const pick = (f: File | undefined): void => {
    if (!f) return;
    setDone(undefined);
    const bad = iconProblem(f);
    if (bad) return setProblem(bad);
    setProblem(undefined);
    upload.mutate(f, {
      onSuccess: (r) => setDone(r.icon.has_badge ? 'Icono actualizado. En otras pestañas del navegador puede tardar unos minutos en verse.' : 'Icono actualizado, pero la imagen no tiene transparencia: no se pudo generar el icono monocromo de las notificaciones de Android (se usa el de por omisión).'),
      onError: (e) => setProblem(friendlyError(e, 'No pudimos subir el icono.')),
    });
  };
  const remove = (): void => {
    setProblem(undefined);
    setDone(undefined);
    clear.mutate(undefined, { onSuccess: () => setDone('Icono quitado: la plataforma vuelve al icono por omisión.'), onError: (e) => setProblem(friendlyError(e, 'No pudimos quitar el icono.')) });
  };
  return (
    <section aria-label="Icono de la aplicación" className={card}>
      <h3 className="text-[15px] font-bold">Icono de la aplicación</h3>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Con una sola imagen se generan el favicon de la pestaña, el icono de instalación y el de las notificaciones.</p>
      <div className="flex flex-wrap items-center gap-5">
        <img src={`/v1/branding/icon-192.png?v=${encodeURIComponent(version)}`} alt="Icono actual" width={72} height={72} className="size-[72px] rounded-xl border border-line bg-surface2 object-contain p-1" />
        <div className="grid gap-1.5">
          <TabPreview version={version} name={v.effective_name} />
          <p className="text-[12.5px] text-muted">
            {v.icon.custom ? <>Imagen propia · {v.icon.px} × {v.icon.px} px{v.icon.updated_at ? ` · subida el ${shortDateTime(v.icon.updated_at)}` : ''}{v.icon.has_badge ? ' · con icono monocromo para Android' : ' · sin icono monocromo (la imagen no tiene transparencia)'}</> : 'Todavía no subes uno: se usa el icono por omisión.'}
          </p>
        </div>
      </div>
      <ul className="grid gap-1 text-[12.5px] text-muted" aria-label="Requisitos del icono">
        <li>PNG cuadrado de al menos 512 × 512 px (hasta 4096 px) y hasta 1 MB. No se aceptan SVG.</li>
        <li>Mejor con fondo transparente: así también se genera el icono monocromo de las notificaciones de Android.</li>
        <li>En iPhone y iPad el icono de las notificaciones es el de la aplicación instalada en la pantalla de inicio: puede requerir reinstalarla para actualizarlo.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept={ICON_ACCEPT} aria-label="Elegir un icono" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button variant="primary" loading={upload.isPending} onClick={() => file.current?.click()}>{v.icon.custom ? 'Cambiar icono' : 'Subir icono'}</Button>
        {v.icon.custom ? <RemoveButton label="Quitar icono" question="¿Quitar el icono y volver al de por omisión?" busy={clear.isPending} onConfirm={remove} /> : null}
      </div>
      {problem ? <Alert>{problem}</Alert> : null}
      {done ? <Alert kind="ok">{done}</Alert> : null}
    </section>
  );
}

function LogoCard({ which, file: current }: { which: 'light' | 'dark'; file: BrandingFile | null }) {
  const upload = useUploadLogo(which);
  const clear = useClearLogo(which);
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<string>();
  const dark = which === 'dark';
  const title = dark ? 'Para fondo oscuro' : 'Para fondo claro';
  const pick = (f: File | undefined): void => {
    if (!f) return;
    setDone(undefined);
    const bad = logoProblem(f);
    if (bad) return setProblem(bad);
    setProblem(undefined);
    upload.mutate(f, { onSuccess: () => setDone('Logo actualizado.'), onError: (e) => setProblem(friendlyError(e, 'No pudimos subir el logo.')) });
  };
  const remove = (): void => {
    setProblem(undefined);
    setDone(undefined);
    clear.mutate(undefined, { onSuccess: () => setDone('Logo quitado.'), onError: (e) => setProblem(friendlyError(e, 'No pudimos quitar el logo.')) });
  };
  return (
    <div role="group" aria-label={`Logo ${title.toLowerCase()}`} className="grid content-start gap-3 rounded-xl border border-line p-3">
      <h4 className="text-[13.5px] font-bold">{title}</h4>
      <div className={`grid min-h-[84px] place-items-center rounded-lg border border-line p-3 ${dark ? 'bg-[#16112e]' : 'bg-white'}`}>
        {current ? <img src={`/v1/branding/logo-${which}?v=${encodeURIComponent(current.version)}`} alt={`Logo ${title.toLowerCase()} actual`} className="max-h-14 w-auto max-w-full object-contain" /> : <span className={`text-[12.5px] ${dark ? 'text-white/70' : 'text-muted'}`}>{dark ? 'Sin logo: se usa el claro (o el de por omisión)' : 'Sin logo: se usa el de por omisión'}</span>}
      </div>
      {current ? <p className="text-[12px] text-muted">{current.content_type === 'image/webp' ? 'WebP' : 'PNG'} · {current.px} px de ancho · {kb(current.bytes)} KB</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={LOGO_ACCEPT} aria-label={`Elegir el logo ${title.toLowerCase()}`} className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}>{current ? 'Cambiar logo' : 'Subir logo'}</Button>
        {current ? <RemoveButton label="Quitar logo" question="¿Quitar este logo?" busy={clear.isPending} onConfirm={remove} /> : null}
      </div>
      {problem ? <Alert>{problem}</Alert> : null}
      {done ? <Alert kind="ok">{done}</Alert> : null}
    </div>
  );
}

function LogoSection({ v }: { v: BrandingView }) {
  return (
    <section aria-label="Logo" className={card}>
      <h3 className="text-[15px] font-bold">Logo</h3>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Se ve en el menú lateral y en las pantallas de acceso, que tienen fondo oscuro. Sube la versión para fondo oscuro; si solo subes la clara, se usa en los dos. PNG o WebP de hasta 1 MB y 1024 px de ancho (no se aceptan SVG).</p>
      <div className="grid grid-cols-1 gap-3 min-[720px]:grid-cols-2">
        <LogoCard which="light" file={v.logo_light} />
        <LogoCard which="dark" file={v.logo_dark} />
      </div>
    </section>
  );
}

const SOUND_TEST: Record<Exclude<SoundTestResult, 'ok'>, { kind: 'error'; text: string }> = {
  unsupported: { kind: 'error', text: 'Este navegador no puede reproducir audio de la página.' },
  error: { kind: 'error', text: 'No se pudo reproducir el sonido. Si acabas de subirlo, espera un momento y vuelve a probar; si sigue igual, prueba con otro archivo MP3.' },
};

function SoundSection({ v }: { v: BrandingView }) {
  const upload = useUploadSound();
  const clear = useClearSound();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<string>();
  const [note, setNote] = useState<string>();
  const [testing, setTesting] = useState(false);
  const sound = v.sound;
  const pick = (f: File | undefined): void => {
    if (!f) return;
    setDone(undefined);
    setNote(undefined);
    const bad = soundProblem(f);
    if (bad) return setProblem(bad);
    setProblem(undefined);
    void soundDuration(f).then((secs) => {
      if (secs !== null && secs > SOUND_ADVISED_SECONDS) setNote(`El archivo dura ${secs.toFixed(1)} s. Se subió, pero un sonido de mensaje debería durar de 1 a 3 segundos: uno largo molesta si llegan muchos mensajes.`);
    });
    upload.mutate(f, { onSuccess: () => setDone('Sonido actualizado. Quien ya tenga la aplicación abierta lo oirá al recargar la página.'), onError: (e) => setProblem(friendlyError(e, 'No pudimos subir el sonido.')) });
  };
  const remove = (): void => {
    setProblem(undefined);
    setDone(undefined);
    setNote(undefined);
    clear.mutate(undefined, { onSuccess: () => setDone('Sonido quitado: la aplicación vuelve al tono por omisión.'), onError: (e) => setProblem(friendlyError(e, 'No pudimos quitar el sonido.')) });
  };
  const test = (): void => {
    setTesting(true);
    setProblem(undefined);
    void testSound(sound ? `/v1/branding/sound?v=${encodeURIComponent(sound.version)}` : null).then((r) => {
      setTesting(false);
      if (r !== 'ok') setProblem(SOUND_TEST[r].text);
    });
  };
  return (
    <section aria-label="Sonido de notificación" className={card}>
      <h3 className="text-[15px] font-bold">Sonido de notificación</h3>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Suena cuando llega un mensaje nuevo con la aplicación abierta. No suena por los mensajes propios ni al cargar el historial, y respeta el ajuste de sonido de cada persona (Configuración › Notificaciones).</p>
      <p className="text-[12.5px] text-muted">
        {sound ? <>Sonido propio · {sound.content_type === 'audio/mp4' ? 'M4A' : 'MP3'} · {kb(sound.bytes)} KB</> : 'Sin sonido propio: se usa el tono por omisión de la aplicación.'}
      </p>
      <ul className="grid gap-1 text-[12.5px] text-muted" aria-label="Requisitos del sonido">
        <li>Formato: MP3 (recomendado) o M4A (AAC), a 128 kbps, estéreo o mono.</li>
        <li>Duración: de 1 a 3 segundos.</li>
        <li>Peso: hasta 100 KB recomendado; el máximo aceptado es 200 KB.</li>
      </ul>
      <ul className="grid gap-1 text-[12.5px] text-muted" aria-label="Limitaciones del sonido">
        <li>Con la aplicación cerrada, la notificación del navegador usa el sonido del sistema, no este archivo.</li>
        <li>El navegador no deja sonar a una página hasta que la persona la toca una vez: el primer sonido puede no oírse hasta el primer clic.</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={SOUND_ACCEPT} aria-label="Elegir un sonido" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        <Button variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}>{sound ? 'Cambiar sonido' : 'Subir sonido'}</Button>
        <Button loading={testing} onClick={test}>Probar sonido</Button>
        {sound ? <RemoveButton label="Restaurar sonido por defecto" question="¿Quitar el sonido propio y volver al tono por omisión?" busy={clear.isPending} onConfirm={remove} /> : null}
      </div>
      {problem ? <Alert>{problem}</Alert> : null}
      {note ? <Alert kind="info">{note}</Alert> : null}
      {done ? <Alert kind="ok">{done}</Alert> : null}
    </section>
  );
}

const TEST_MESSAGE: Record<TestNotificationResult, { kind: 'ok' | 'error' | 'info'; text: string }> = {
  ok: { kind: 'ok', text: 'Listo: debería aparecer una notificación del sistema con el icono. Si no la ves, revisa que el sistema operativo no tenga las notificaciones silenciadas.' },
  unsupported: { kind: 'error', text: 'Este navegador no permite notificaciones. Prueba con Chrome, Edge o Firefox; en iPhone, instala primero la aplicación en la pantalla de inicio.' },
  denied: { kind: 'error', text: 'El permiso de notificaciones está bloqueado en este navegador. Actívalo desde el candado de la barra de direcciones (Notificaciones › Permitir) y vuelve a probar.' },
  error: { kind: 'error', text: 'No se pudo mostrar la notificación. Recarga la página y vuelve a intentarlo.' },
};

function NotificationSection() {
  const brand = useBrand();
  const [result, setResult] = useState<TestNotificationResult>();
  const [busy, setBusy] = useState(false);
  const run = (): void => {
    setBusy(true);
    void showTestNotification(brand).then((r) => { setResult(r); setBusy(false); });
  };
  const shown = result ? TEST_MESSAGE[result] : undefined;
  return (
    <section aria-label="Notificaciones" className={card}>
      <h3 className="text-[15px] font-bold">Notificaciones</h3>
      <div className="flex flex-wrap items-start gap-3">
        <div role="img" aria-label="Vista previa de una notificación" className="flex w-[min(340px,100%)] items-start gap-3 rounded-2xl border border-line bg-surface2 p-3 shadow-sm">
          <img src={brand.icon192 ?? '/v1/branding/icon-192.png'} alt="" width={40} height={40} className="size-10 rounded-lg object-contain" />
          <div className="min-w-0 text-[12.5px]">
            <b className="block truncate text-[13px]">{brand.name}</b>
            <span className="text-muted">Luis Navas: Hola, ¿tienen disponibilidad para mañana?</span>
          </div>
        </div>
        <Button variant="primary" loading={busy} onClick={run}>Probar notificación en este navegador</Button>
      </div>
      {shown ? <Alert kind={shown.kind}>{shown.text}</Alert> : null}
      <ul className="grid gap-1 text-[12.5px] text-muted" aria-label="Qué tener en cuenta">
        <li>La prueba muestra la notificación en ESTE navegador con el icono vigente; el envío real a las personas se prueba en Configuración › Notificaciones.</li>
        <li>En Android, Windows y macOS el icono sale de «Icono de la aplicación». En iPhone y iPad sale de la aplicación instalada.</li>
      </ul>
    </section>
  );
}

/**
 * Plataforma › Marca (v11 §3, solo Súper Admin): el nombre de la plataforma, el icono de la aplicación (favicon, instalación y notificaciones), los logos y el sonido de mensaje nuevo. Todo es global de la plataforma. Las
 * imágenes las valida el servidor por su contenido real; aquí solo se evita subir lo que ya se sabe que no sirve.
 */
export function BrandingPage() {
  const q = useBranding();
  if (q.isPending) return <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la marca" /></div>;
  if (q.isError) return <Alert>{friendlyError(q.error, 'No pudimos cargar la marca.')}</Alert>;
  const v = q.data;
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-[18px] font-bold">Marca</h2>
        <p className="text-[12.5px] text-muted">Cómo se ve la plataforma para todos: el nombre, el icono y los logos. No depende de cada empresa ni de cada agencia.</p>
      </div>
      <NameSection v={v} />
      <IconSection v={v} />
      <LogoSection v={v} />
      <NotificationSection />
      <SoundSection v={v} />
    </div>
  );
}
