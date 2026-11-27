import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';

const BARS = 36;
const RATES = [1, 1.5, 2] as const;

/** Un número estable (0…1) por barra a partir del identificador del audio: así la onda de un mismo audio no cambia entre pantallas. */
function waveform(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < BARS; i += 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) + i;
    const v = ((h >>> 0) % 1000) / 1000;
    const envelope = 0.45 + 0.55 * Math.sin((Math.PI * (i + 1)) / (BARS + 1)); // más alto al centro, como una nota de voz
    out.push(Math.max(0.16, Math.min(1, 0.25 + v * 0.75 * envelope)));
  }
  return out;
}

export const clock = (s: number): string => {
  const t = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * La dirección del archivo que el reproductor usa. El servidor firma una dirección NUEVA cada vez que se pide el hilo (cada pocos segundos), y si el `src` cambia a media reproducción el navegador
 * recarga el audio y se corta. Se conserva la primera dirección de ese archivo y solo se cambia si falla (por ejemplo, porque venció).
 */
export function useStableUrl(id: string, url: string): [string, () => boolean] {
  const [held, setHeld] = useState({ id, url });
  let cur = held;
  if (held.id !== id) {
    cur = { id, url };
    setHeld(cur); // otro archivo: toma su propia dirección
  }
  const refresh = (): boolean => {
    if (cur.url === url) return false;
    setHeld({ id, url });
    return true;
  };
  return [cur.url, refresh];
}

/**
 * Reproductor de audio de la bandeja (como el de WhatsApp): botón de reproducir/pausar, onda con el avance, los segundos corriendo (o la duración cuando está quieto) y la velocidad (1×, 1,5×, 2×).
 * La onda es decorativa (se deriva del identificador): no es el audio real.
 */
export function AudioPlayer({ id, url, filename }: { id: string; url: string; filename?: string | null }) {
  const [src, refreshSrc] = useStableUrl(id, url);
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [failed, setFailed] = useState(false);
  const bars = useMemo(() => waveform(id), [id]);

  // Algunos audios (WhatsApp en OGG, grabaciones del navegador en WebM) no traen la duración: se fuerza al final una vez para que el navegador la calcule y se vuelve al principio.
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const fix = (): void => {
      if (a.duration === Infinity || Number.isNaN(a.duration)) {
        const back = (): void => {
          a.removeEventListener('timeupdate', back);
          a.currentTime = 0;
          setDuration(Number.isFinite(a.duration) ? a.duration : 0);
        };
        a.addEventListener('timeupdate', back);
        a.currentTime = 1e7;
      } else setDuration(a.duration);
    };
    a.addEventListener('loadedmetadata', fix);
    return () => a.removeEventListener('loadedmetadata', fix);
  }, [src]);

  const toggle = (): void => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setFailed(true));
    else a.pause();
  };
  const seek = (pct: number): void => {
    const a = ref.current;
    if (!a || !(duration > 0)) return;
    a.currentTime = Math.max(0, Math.min(duration, pct * duration));
    setTime(a.currentTime);
  };
  const cycle = (): void => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
    setRate(next);
    if (ref.current) ref.current.playbackRate = next;
  };
  const pct = duration > 0 ? Math.min(1, time / duration) : 0;
  const shown = playing || time > 0 ? time : duration;

  if (failed) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span>No se pudo reproducir este audio aquí.</span>
        <a href={src} download={filename ?? 'audio'} className="font-semibold underline">Descargar</a>
      </span>
    );
  }
  return (
    <div className="flex w-[min(260px,100%)] items-center gap-2" role="group" aria-label="Audio">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0); if (ref.current) ref.current.currentTime = 0; }}
        onTimeUpdate={(e) => { const t = e.currentTarget.currentTime; if (t < 1e6) setTime(t); }}
        onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setDuration(d); }}
        onError={() => { if (!refreshSrc()) setFailed(true); }}
      />
      {playing || time > 0 ? <button type="button" onClick={cycle} aria-label={`Velocidad ${rate} veces`} className="grid h-8 min-w-[44px] place-items-center rounded-full bg-black/20 px-2 text-[12px] font-bold">{rate === 1 ? '1×' : `${String(rate).replace('.', ',')}×`}</button> : null}
      <button type="button" onClick={toggle} aria-label={playing ? 'Pausar el audio' : 'Reproducir el audio'} className="grid size-11 shrink-0 place-items-center rounded-full">
        <Icon name={playing ? 'pause' : 'play'} size={22} />
      </button>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Posición del audio"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(duration))}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} de ${clock(duration)}`}
          className="relative flex h-8 cursor-pointer items-center gap-[2px] touch-none"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); seek(pct + 5 / Math.max(duration, 1)); }
            if (e.key === 'ArrowLeft') { e.preventDefault(); seek(pct - 5 / Math.max(duration, 1)); }
          }}
        >
          {bars.map((h, i) => <span key={i} aria-hidden="true" className={`w-[3px] shrink-0 rounded-full bg-current ${i / BARS < pct ? 'opacity-100' : 'opacity-35'}`} style={{ height: `${Math.round(h * 100)}%` }} />)}
          <span aria-hidden="true" className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" style={{ left: `${pct * 100}%` }} />
        </div>
        <span className="text-[12px] tabular-nums opacity-80">{clock(shown)}</span>
      </div>
    </div>
  );
}
