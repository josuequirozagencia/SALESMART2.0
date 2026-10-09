import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, type ScheduledJob } from '../../src/jobs';
import type { AppConfig } from '../../src/config';
import type { AppLogger } from '../../src/logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cfg = (enabled: boolean) => ({ jobs: { enabled, trialExpiryIntervalMs: 20 } }) as unknown as AppConfig;
const logs: Array<{ level: string; obj: unknown }> = [];
const log = { info: (obj: unknown) => logs.push({ level: 'info', obj }), error: (obj: unknown) => logs.push({ level: 'error', obj }) } as unknown as AppLogger;

let runner: JobRunner | undefined;
afterEach(async () => { await runner?.onApplicationShutdown(); runner = undefined; logs.length = 0; });

function job(run: () => Promise<number>, intervalMs = 20): ScheduledJob & { calls: number } {
  const j = { name: 'j', intervalMs, calls: 0, run: async () => { j.calls++; return run(); } };
  return j;
}

describe('JobRunner', () => {
  it('apagado (JOBS_ENABLED=false): no programa nada, pero runOnce sigue funcionando', async () => {
    const j = job(() => Promise.resolve(1));
    runner = new JobRunner([j], cfg(false), log);
    runner.onApplicationBootstrap();
    await sleep(80);
    expect(j.calls).toBe(0);
    expect(await runner.runOnce('j')).toBe(1);
    expect(j.calls).toBe(1);
  });

  it('encendido: corre al arrancar y luego periódicamente', async () => {
    const j = job(() => Promise.resolve(0));
    runner = new JobRunner([j], cfg(true), log);
    runner.onApplicationBootstrap();
    await sleep(150);
    expect(j.calls).toBeGreaterThanOrEqual(3);
  });

  it('nunca solapa la misma tarea aunque tarde más que el intervalo', async () => {
    let active = 0;
    let maxActive = 0;
    const j = job(async () => { active++; maxActive = Math.max(maxActive, active); await sleep(70); active--; return 0; });
    runner = new JobRunner([j], cfg(true), log);
    runner.onApplicationBootstrap();
    await sleep(250);
    expect(maxActive).toBe(1);
    expect(j.calls).toBeGreaterThanOrEqual(2);
  });

  it('un fallo se registra y la tarea se reintenta; el proceso no se cae', async () => {
    let n = 0;
    const j = job(() => (++n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(2)));
    runner = new JobRunner([j], cfg(true), log);
    runner.onApplicationBootstrap();
    await sleep(150);
    expect(j.calls).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
    expect(logs.some((l) => l.level === 'info')).toBe(true);
  });

  it('runOnce con una ejecución en curso espera a esa y no lanza otra; tarea desconocida se rechaza', async () => {
    const j = job(async () => { await sleep(60); return 5; }, 10_000);
    runner = new JobRunner([j], cfg(false), log);
    const [a, b] = await Promise.all([runner.runOnce('j'), runner.runOnce('j')]);
    expect([a, b]).toEqual([5, 5]);
    expect(j.calls).toBe(1);
    await expect(runner.runOnce('nope')).rejects.toThrow(/desconocida/);
  });

  it('al cerrar espera a la ejecución en curso y deja de programar', async () => {
    let finished = false;
    const j = job(async () => { await sleep(80); finished = true; return 0; });
    runner = new JobRunner([j], cfg(true), log);
    runner.onApplicationBootstrap();
    await sleep(30);
    await runner.onApplicationShutdown();
    expect(finished).toBe(true);
    const calls = j.calls;
    await sleep(100);
    expect(j.calls).toBe(calls);
  });
});
