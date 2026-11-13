import { useCallback, useSyncExternalStore } from 'react';
import { getBrand, subscribeBrand } from './platformBrand';
import { useSession } from './session';

/**
 * Sonido de mensaje nuevo (v6 fase E). Preferencia por persona Y empresa, en este navegador (`ss.sound.v1:<userId>:<orgId>`; sin endpoint), activada por omisión. El tono se genera con Web Audio
 * (sin archivos) o, si el Súper Admin subió uno en Plataforma › Marca, ese sonido (se descarga una vez, se decodifica con Web Audio y se reproduce por el mismo contexto: no depende de las peticiones parciales que Safari exige a los elementos de audio). Los navegadores no dejan sonar a una página que la persona aún no tocó: el sonido queda disponible tras el primer clic, toque o tecla. Todo acceso al almacenamiento va en try/catch.
 */
export const soundKey = (userId: string, orgId: string): string => `ss.sound.v1:${userId}:${orgId}`;

const mem = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
};

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? mem.get(key) ?? null;
  } catch {
    return mem.get(key) ?? null;
  }
}

/** ¿Está activado el sonido? Sin preferencia guardada, sí. */
export const soundEnabled = (userId: string, orgId: string): boolean => readRaw(soundKey(userId, orgId)) !== 'off';

export function useSoundPref(): { enabled: boolean; set: (on: boolean) => void } {
  const { state } = useSession();
  const key = state.status === 'authed' ? soundKey(state.me.user.id, state.me.organization.id) : null;
  const raw = useSyncExternalStore(subscribe, () => (key === null ? null : readRaw(key)), () => null);
  const set = useCallback(
    (on: boolean): void => {
      if (key === null) return;
      const v = on ? 'on' : 'off';
      mem.set(key, v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* sin almacenamiento: vale mientras la página siga abierta */
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return { enabled: raw !== 'off', set };
}

let ctx: AudioContext | null = null;
let touched = false;

// ---- el sonido propio de la marca (opcional)
let customUrl: string | null = null; // la dirección de la que sale `customBuffer`
let customBuffer: AudioBuffer | null = null;
let loading: string | null = null;
let watching = false;

async function fetchBuffer(url: string): Promise<AudioBuffer | null> {
  if (!ctx) return null;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null; // sin red, archivo dañado o formato no soportado: se queda el tono
  }
}

/** Deja listo el sonido propio de la marca (si hay uno y ya hay audio disponible); si ya no hay, vuelve al tono. Nunca lanza. */
export function prepareCustomSound(): void {
  const url = getBrand().sound;
  if (url === null) {
    customUrl = null;
    customBuffer = null;
    return;
  }
  if (url === customUrl || url === loading || !ctx) return;
  customBuffer = null;
  customUrl = null;
  loading = url;
  void fetchBuffer(url).then((buf) => {
    if (loading === url) loading = null;
    if (buf && getBrand().sound === url) {
      customBuffer = buf;
      customUrl = url;
    }
  });
}

/** Se llama una vez al iniciar la app: el primer gesto de la persona habilita el audio. */
export function armSoundUnlock(): void {
  if (typeof window === 'undefined') return;
  if (!watching) {
    watching = true;
    subscribeBrand(prepareCustomSound); // el Súper Admin cambió o quitó el sonido
  }
  if (touched) return;
  const unlock = (): void => {
    touched = true;
    for (const e of ['pointerdown', 'keydown', 'touchstart'] as const) window.removeEventListener(e, unlock);
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      void ctx?.resume();
      prepareCustomSound();
    } catch {
      /* sin audio disponible */
    }
  };
  for (const e of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(e, unlock, { passive: true });
}

/** ¿Ya se puede reproducir? (la persona tocó la página y hay audio). */
export const soundReady = (): boolean => touched && ctx !== null && ctx.state !== 'closed';

/** Toca el sonido propio cargado. */
function playBuffer(c: AudioContext, buf: AudioBuffer): void {
  const src = c.createBufferSource();
  const gain = c.createGain();
  gain.gain.value = 0.9;
  src.buffer = buf;
  src.connect(gain);
  gain.connect(c.destination);
  src.start();
}

/** Toca el tono de mensaje nuevo (el sonido propio de la marca, si lo hay y ya cargó; si no, el tono generado). Devuelve false si el navegador aún no lo permite. Nunca lanza. */
export function playIncomingSound(): boolean {
  if (!soundReady() || !ctx) return false;
  try {
    void ctx.resume();
    prepareCustomSound();
    if (customBuffer && customUrl === getBrand().sound) {
      playBuffer(ctx, customBuffer);
      return true;
    }
    return playTone(ctx);
  } catch {
    return false;
  }
}

/** El tono generado por omisión. */
function playTone(ctx: AudioContext): boolean {
  try {
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    for (const [freq, at] of [[880, 0], [1175, 0.13]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(gain);
      o.start(t + at);
      o.stop(t + at + 0.2);
    }
    return true;
  } catch {
    return false;
  }
}

export type SoundTestResult = 'ok' | 'unsupported' | 'error';

/**
 * «Probar» de Plataforma › Marca: toca el sonido pedido (la dirección del archivo propio) o, sin dirección, el tono por omisión. Se llama desde un clic: ahí se crea y se reanuda el contexto de audio,
 * así que suena aunque la persona no haya tocado antes otra cosa. No depende de la preferencia de silencio (es una prueba explícita).
 */
export async function testSound(url: string | null): Promise<SoundTestResult> {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return 'unsupported';
      ctx = new AC();
    }
    touched = true;
    await ctx.resume();
    if (url === null) return playTone(ctx) ? 'ok' : 'error';
    const buf = url === customUrl && customBuffer ? customBuffer : await fetchBuffer(url);
    if (!buf) return 'error';
    playBuffer(ctx, buf);
    return 'ok';
  } catch {
    return 'error';
  }
}
