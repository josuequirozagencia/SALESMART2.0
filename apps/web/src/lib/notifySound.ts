import { useCallback, useSyncExternalStore } from 'react';
import { useSession } from './session';

/**
 * Sonido de mensaje nuevo (v6 fase E). Preferencia por persona Y empresa, en este navegador (`ss.sound.v1:<userId>:<orgId>`; sin endpoint), activada por omisión. El tono se genera con Web Audio
 * (sin archivos). Los navegadores no dejan sonar a una página que la persona aún no tocó: el sonido queda disponible tras el primer clic, toque o tecla. Todo acceso al almacenamiento va en try/catch.
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

/** Se llama una vez al iniciar la app: el primer gesto de la persona habilita el audio. */
export function armSoundUnlock(): void {
  if (touched || typeof window === 'undefined') return;
  const unlock = (): void => {
    touched = true;
    for (const e of ['pointerdown', 'keydown', 'touchstart'] as const) window.removeEventListener(e, unlock);
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      void ctx?.resume();
    } catch {
      /* sin audio disponible */
    }
  };
  for (const e of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(e, unlock, { passive: true });
}

/** ¿Ya se puede reproducir? (la persona tocó la página y hay audio). */
export const soundReady = (): boolean => touched && ctx !== null && ctx.state !== 'closed';

/** Toca el tono de mensaje nuevo. Devuelve false si el navegador aún no lo permite. Nunca lanza. */
export function playIncomingSound(): boolean {
  if (!soundReady() || !ctx) return false;
  try {
    void ctx.resume();
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
