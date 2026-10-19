/**
 * Motor de reparto de una cola (M5.3, ADR-07). Funciones PURAS: sin base de datos ni reloj. La cola le pasa a quién puede tocarle (con su peso y su carga) y el
 * estado que dejó el último reparto; devuelve a quién le toca y el estado nuevo. El servicio guarda ese estado bajo candado, así que dos repartos a la vez no
 * parten del mismo.
 *
 * Modos:
 *  - `equal`: rotación. Cada asesor recibe `batch` conversaciones seguidas y pasa al siguiente.
 *  - `weighted`: rotación PONDERADA «suave» (la de nginx): quien pesa más recibe más, repartido a lo largo del ciclo y no todo de golpe. También con `batch`.
 *  - `load`: quien tenga menos conversaciones abiertas (empate: el que sigue en la rotación). No usa `batch`.
 * `dailyCap` (0 = sin tope) excluye a quien ya recibió ese número hoy. Si nadie puede recibir, devuelve `null` (la conversación queda «sin asignar»).
 */

export type DistMode = 'equal' | 'weighted' | 'load';
export const DIST_MODES: readonly DistMode[] = ['equal', 'weighted', 'load'];

export interface Candidate {
  readonly userId: string;
  readonly weight: number;
  /** Conversaciones que recibió HOY de esta cola. */
  readonly todayCount: number;
  /** Conversaciones abiertas que atiende ahora (solo importa en `load`). */
  readonly openCount: number;
}

export interface DistRules {
  readonly mode: DistMode;
  readonly batch: number;
  readonly dailyCap: number;
}

export interface DistState {
  /** A quién se le asignó la última vez. */
  readonly last: string | null;
  /** Cuántas seguidas lleva `last` en su turno. */
  readonly streak: number;
  /** Créditos del ponderado suave, por asesor. */
  readonly current: Readonly<Record<string, number>>;
}

export const EMPTY_STATE: DistState = { last: null, streak: 0, current: {} };

export interface Pick {
  readonly userId: string | null;
  readonly state: DistState;
}

/** Lee el estado guardado tolerando cualquier forma (un valor dañado o de una versión anterior equivale a empezar de cero). */
export function parseState(raw: unknown): DistState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STATE;
  const r = raw as Record<string, unknown>;
  const last = typeof r['last'] === 'string' ? r['last'] : null;
  const streak = typeof r['streak'] === 'number' && Number.isInteger(r['streak']) && r['streak'] >= 0 ? r['streak'] : 0;
  const current: Record<string, number> = {};
  if (typeof r['current'] === 'object' && r['current'] !== null && !Array.isArray(r['current'])) {
    for (const [k, v] of Object.entries(r['current'])) if (typeof v === 'number' && Number.isFinite(v)) current[k] = v;
  }
  return { last, streak, current };
}

/**
 * A quién le toca ahora. `candidates` va en ORDEN ESTABLE (el de la rotación): el mismo orden en cada llamada, o el reparto se desordena.
 */
export function pickNext(candidates: readonly Candidate[], rules: DistRules, state: DistState): Pick {
  const eligible = candidates.filter((c) => rules.dailyCap === 0 || c.todayCount < rules.dailyCap);
  if (eligible.length === 0) return { userId: null, state };

  if (rules.mode === 'load') {
    // El de menor carga; entre iguales, el siguiente en la rotación después del último
    const min = Math.min(...eligible.map((c) => c.openCount));
    const tied = eligible.filter((c) => c.openCount === min);
    const chosen = nextAfter(candidates, tied, state.last);
    return { userId: chosen.userId, state: { last: chosen.userId, streak: 1, current: {} } };
  }

  // Dentro de su turno (todavía no recibió `batch` seguidas y puede seguir recibiendo)
  const lastCandidate = state.last === null ? undefined : eligible.find((c) => c.userId === state.last);
  if (lastCandidate && state.streak < rules.batch) {
    return { userId: lastCandidate.userId, state: { ...state, streak: state.streak + 1 } };
  }

  if (rules.mode === 'equal') {
    const chosen = nextAfter(candidates, eligible, state.last);
    return { userId: chosen.userId, state: { last: chosen.userId, streak: 1, current: {} } };
  }

  // weighted: ponderado suave. Solo cuentan los que hoy pueden recibir; los demás pierden sus créditos
  const current: Record<string, number> = {};
  let total = 0;
  for (const c of eligible) {
    current[c.userId] = (state.current[c.userId] ?? 0) + c.weight;
    total += c.weight;
  }
  let best = eligible[0]!;
  for (const c of eligible) if (current[c.userId]! > current[best.userId]!) best = c; // empate: el primero en el orden
  current[best.userId] = current[best.userId]! - total;
  return { userId: best.userId, state: { last: best.userId, streak: 1, current } };
}

/** El primero de `pool` que sigue, en el orden de `order` y dando la vuelta, después de `after` (o el primero si no hay o no está). */
function nextAfter(order: readonly Candidate[], pool: readonly Candidate[], after: string | null): Candidate {
  const inPool = new Set(pool.map((c) => c.userId));
  const start = after === null ? -1 : order.findIndex((c) => c.userId === after);
  for (let i = 1; i <= order.length; i++) {
    const c = order[(start + i + order.length) % order.length]!;
    if (inPool.has(c.userId)) return c;
  }
  return pool[0]!;
}

export interface Simulation {
  readonly sequence: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Simula `count` repartos seguidos con las reglas dadas, sin tocar nada. Cada asignación suma a la carga y al contador del día del elegido, como pasaría de
 * verdad (así `load` y el tope diario se notan en la simulación). Parte del estado dado (por omisión, de cero).
 */
export function simulate(candidates: readonly Candidate[], rules: DistRules, count: number, from: DistState = EMPTY_STATE): Simulation {
  const live = candidates.map((c) => ({ ...c }));
  const counts: Record<string, number> = {};
  for (const c of candidates) counts[c.userId] = 0;
  const sequence: string[] = [];
  let state = from;
  for (let i = 0; i < count; i++) {
    const p = pickNext(live, rules, state);
    if (p.userId === null) break; // nadie puede recibir más (tope diario)
    sequence.push(p.userId);
    counts[p.userId] = (counts[p.userId] ?? 0) + 1;
    const me = live.find((c) => c.userId === p.userId)!;
    me.todayCount += 1;
    me.openCount += 1;
    state = p.state;
  }
  return { sequence, counts };
}
