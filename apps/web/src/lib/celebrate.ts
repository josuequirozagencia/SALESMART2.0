import { useCallback, useSyncExternalStore } from 'react';
import { soundEnabled } from './notifySound';
import { useSession } from './session';

/**
 * Celebración al registrar una venta (v7 fase D, ADR-65): sonido de «caja registradora» (Web Audio, sin archivos) y confeti en un canvas propio (sin librerías). Solo web: la preferencia
 * «Celebrar las ventas» vive SOLO EN ESTE NAVEGADOR (`ss.celebrate.v1:<userId>:<orgId>`, por persona y empresa), activada por omisión; guardarla en el servidor exigiría un cambio de API.
 * Todo acceso al almacenamiento va en try/catch.
 */
export const celebrateKey = (userId: string, orgId: string): string => `ss.celebrate.v1:${userId}:${orgId}`;

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

/** ¿Está activada la celebración? Sin preferencia guardada, sí. */
export const celebrateEnabled = (userId: string, orgId: string): boolean => readRaw(celebrateKey(userId, orgId)) !== 'off';

export function useCelebratePref(): { enabled: boolean; set: (on: boolean) => void } {
  const { state } = useSession();
  const key = state.status === 'authed' ? celebrateKey(state.me.user.id, state.me.organization.id) : null;
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

/** Qué se celebra: el sonido necesita la celebración Y el sonido de Notificaciones; el confeti, la celebración y que la persona no pida menos movimiento. */
export function celebrationPlan(userId: string, orgId: string, reducedMotion: boolean): { sound: boolean; confetti: boolean } {
  const on = celebrateEnabled(userId, orgId);
  return { sound: on && soundEnabled(userId, orgId), confetti: on && !reducedMotion };
}

export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ sonido

let ctx: AudioContext | null = null;

/** Se llama DENTRO del clic de «Registrar venta»: crea y reanuda el audio con el gesto de la persona (si el navegador lo bloquea, simplemente no sonará). Nunca lanza. */
export function primeCelebrationAudio(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

/** «Caja registradora»: tres toques cortos y una campanilla, ≈ 1,1 s en total y volumen moderado. Devuelve false si no pudo sonar. Nunca lanza. */
export function playCashRegister(): boolean {
  if (!ctx || ctx.state === 'closed') return false;
  try {
    const t = ctx.currentTime + 0.01;
    const tone = (freq: number, at: number, len: number, type: OscillatorType, peak: number): void => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(peak, t + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
      o.connect(g);
      g.connect(ctx!.destination);
      o.start(t + at);
      o.stop(t + at + len + 0.02);
    };
    // «ka-ching»: tres golpes secos y la campanilla (dos parciales)
    tone(1200, 0, 0.07, 'square', 0.07);
    tone(1500, 0.09, 0.07, 'square', 0.07);
    tone(1800, 0.18, 0.07, 'square', 0.07);
    tone(2637, 0.3, 0.8, 'sine', 0.16);
    tone(3951, 0.3, 0.5, 'sine', 0.06);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ confeti

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vr: number;
  color: string;
}

export const CONFETTI_MIN = 120;
export const CONFETTI_MAX = 160;
export const CONFETTI_MS = 2500;

/** Genera las partículas: entre 120 y 160, desde arriba del área, con los colores dados. `rand` se inyecta para poder probarlo. */
export function makeParticles(width: number, height: number, colors: readonly string[], rand: () => number = Math.random): Particle[] {
  const palette = colors.length > 0 ? colors : ['#6a44f2'];
  const n = CONFETTI_MIN + Math.floor(rand() * (CONFETTI_MAX - CONFETTI_MIN + 1));
  return Array.from({ length: n }, () => ({
    x: rand() * width,
    y: -10 - rand() * height * 0.25,
    vx: (rand() - 0.5) * 4,
    vy: 2 + rand() * 4,
    size: 5 + rand() * 6,
    rot: rand() * Math.PI * 2,
    vr: (rand() - 0.5) * 0.3,
    color: palette[Math.floor(rand() * palette.length)]!,
  }));
}

/** Avanza un cuadro: gravedad suave y giro. Devuelve las partículas que siguen dentro del área. */
export function stepParticles(ps: readonly Particle[], height: number): Particle[] {
  return ps
    .map((p) => ({ ...p, x: p.x + p.vx, y: p.y + p.vy, vy: p.vy + 0.06, rot: p.rot + p.vr }))
    .filter((p) => p.y < height + 20);
}

/** Los colores de la marca: los tokens del tema activo (acento, ok, aviso, info y crítico). */
export function themeColors(): string[] {
  if (typeof document === 'undefined') return [];
  const css = getComputedStyle(document.documentElement);
  return ['--accent', '--ok', '--warn', '--info', '--crit'].map((v) => css.getPropertyValue(v).trim()).filter((c) => c !== '');
}

/**
 * Dibuja el confeti en el canvas durante `CONFETTI_MS` y se limpia solo. Devuelve la función que lo cancela (al cambiar de pantalla). Sin contexto 2D (navegadores raros, pruebas) no hace nada.
 * `now` y `raf` se inyectan para las pruebas.
 */
export function runConfetti(
  canvas: HTMLCanvasElement,
  opts: { colors?: readonly string[]; raf?: (cb: FrameRequestCallback) => number; cancel?: (id: number) => void; now?: () => number; rand?: () => number } = {},
): () => void {
  const g = canvas.getContext('2d');
  if (!g) return () => undefined;
  const raf = opts.raf ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelRaf = opts.cancel ?? ((id) => window.cancelAnimationFrame(id));
  const now = opts.now ?? (() => performance.now());
  const w = canvas.width;
  const h = canvas.height;
  let ps = makeParticles(w, h, opts.colors ?? themeColors(), opts.rand);
  const start = now();
  let id = 0;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    cancelRaf(id);
    g.clearRect(0, 0, w, h);
    ps = [];
  };
  const frame = (): void => {
    if (stopped) return;
    if (now() - start >= CONFETTI_MS) return stop();
    g.clearRect(0, 0, w, h);
    // Se desvanece en el último tramo
    g.globalAlpha = Math.max(0, Math.min(1, (CONFETTI_MS - (now() - start)) / 600));
    for (const p of ps) {
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      g.restore();
    }
    ps = stepParticles(ps, h);
    id = raf(frame);
  };
  id = raf(frame);
  return stop;
}
