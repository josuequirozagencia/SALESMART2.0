import { describe, expect, it, vi } from 'vitest';
import { celebrateKey, celebrationPlan, CONFETTI_MAX, CONFETTI_MIN, CONFETTI_MS, makeParticles, runConfetti, stepParticles } from '../src/lib/celebrate';

describe('confeti: generador de partículas', () => {
  it('genera entre 120 y 160 con los colores dados, empezando sobre el área', () => {
    for (const r of [0, 0.5, 0.999]) {
      const ps = makeParticles(800, 600, ['#111', '#222'], () => r);
      expect(ps.length).toBeGreaterThanOrEqual(CONFETTI_MIN);
      expect(ps.length).toBeLessThanOrEqual(CONFETTI_MAX);
      expect(ps.every((p) => ['#111', '#222'].includes(p.color) && p.y <= 0)).toBe(true);
    }
    expect(makeParticles(10, 10, [], () => 0.3)[0]!.color).toMatch(/^#/); // sin colores usa uno por omisión
  });

  it('las partículas que salen del área se descartan', () => {
    const ps = makeParticles(800, 600, ['#111'], () => 0.5);
    let cur = ps;
    for (let i = 0; i < 1000 && cur.length > 0; i++) cur = stepParticles(cur, 600);
    expect(cur).toHaveLength(0);
  });
});

describe('confeti: animación', () => {
  it('dura CONFETTI_MS, se limpia al terminar y se puede cancelar', () => {
    const calls: string[] = [];
    const g = { clearRect: () => calls.push('clear'), save: () => undefined, restore: () => undefined, translate: () => undefined, rotate: () => undefined, fillRect: () => undefined, globalAlpha: 1, fillStyle: '' };
    const canvas = { width: 400, height: 300, getContext: () => g } as unknown as HTMLCanvasElement;
    let t = 0;
    const queue: FrameRequestCallback[] = [];
    const stop = runConfetti(canvas, { colors: ['#111'], now: () => t, raf: (cb) => { queue.push(cb); return queue.length; }, cancel: () => undefined, rand: () => 0.4 });
    expect(queue).toHaveLength(1);
    queue.shift()!(0);
    expect(queue).toHaveLength(1); // sigue
    t = CONFETTI_MS + 1;
    queue.shift()!(0);
    expect(queue).toHaveLength(0); // terminó: no pide más cuadros
    expect(calls.at(-1)).toBe('clear'); // y dejó el canvas limpio
    stop(); // cancelar después de terminar no rompe nada

    const cancel = vi.fn();
    const q2: FrameRequestCallback[] = [];
    const stop2 = runConfetti(canvas, { colors: ['#111'], now: () => 0, raf: (cb) => { q2.push(cb); return 7; }, cancel, rand: () => 0.4 });
    stop2();
    expect(cancel).toHaveBeenCalledWith(7);
    q2.shift()!(0); // un cuadro pendiente después de cancelar no dibuja ni pide otro
    expect(q2).toHaveLength(0);
  });

  it('sin contexto 2D no hace nada y no lanza', () => {
    const canvas = { width: 1, height: 1, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => runConfetti(canvas)()).not.toThrow();
  });
});

describe('qué se celebra', () => {
  it('la clave es por persona y empresa; sin preferencia está activada; el sonido necesita también el sonido de Notificaciones; reduce-motion quita el confeti', () => {
    window.localStorage.clear();
    expect(celebrateKey('u1', 'o1')).not.toBe(celebrateKey('u1', 'o2'));
    expect(celebrationPlan('u1', 'o1', false)).toEqual({ sound: true, confetti: true });
    expect(celebrationPlan('u1', 'o1', true)).toEqual({ sound: true, confetti: false });
    window.localStorage.setItem('ss.sound.v1:u1:o1', 'off');
    expect(celebrationPlan('u1', 'o1', false)).toEqual({ sound: false, confetti: true });
    window.localStorage.setItem(celebrateKey('u1', 'o1'), 'off');
    expect(celebrationPlan('u1', 'o1', false)).toEqual({ sound: false, confetti: false });
    window.localStorage.clear();
  });
});
