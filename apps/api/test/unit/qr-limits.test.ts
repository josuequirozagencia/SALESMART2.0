// M107 — tope de calentamiento de QR dispensado por declaración del cliente (ADR-54, enmienda «waiver»). Funciones PURAS: sin base de datos.
import { describe, expect, it } from 'vitest';
import { dailyLimit, MIN_GAP_MS, sendGate, WARMUP_WAIVED_DAILY_LIMIT, warmupDay } from '../../src/modules/qr/qr-limits';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-20T12:00:00.000Z');

describe('dailyLimit', () => {
  it('sin waiver sube con los días: 20, 50, 100 y 250', () => {
    expect(dailyLimit(null, NOW)).toBe(20);
    expect(dailyLimit(new Date(NOW.getTime() - 1 * DAY_MS), NOW)).toBe(20);
    expect(dailyLimit(new Date(NOW.getTime() - 2 * DAY_MS), NOW)).toBe(50);
    expect(dailyLimit(new Date(NOW.getTime() - 4 * DAY_MS), NOW)).toBe(100);
    expect(dailyLimit(new Date(NOW.getTime() - 8 * DAY_MS), NOW)).toBe(250);
  });

  it('con waiver: arranca en 200 (más alto que un chip nuevo) y también crece con el tiempo, pero más rápido y hasta un techo más alto', () => {
    expect(dailyLimit(null, NOW, true)).toBe(WARMUP_WAIVED_DAILY_LIMIT); // recién creada, sin firstConnectedAt todavía
    expect(dailyLimit(NOW, NOW, true)).toBe(200);
    expect(dailyLimit(new Date(NOW.getTime() - 6 * DAY_MS), NOW, true)).toBe(200);
    expect(dailyLimit(new Date(NOW.getTime() - 7 * DAY_MS), NOW, true)).toBe(350);
    expect(dailyLimit(new Date(NOW.getTime() - 14 * DAY_MS), NOW, true)).toBe(500);
    expect(dailyLimit(new Date(NOW.getTime() - 21 * DAY_MS), NOW, true)).toBe(800);
    expect(dailyLimit(new Date(NOW.getTime() - 90 * DAY_MS), NOW, true)).toBe(800); // no sigue subiendo más allá del último tramo
  });
});

describe('sendGate', () => {
  it('con waiver, el tope diario sube a 200 pero la pausa mínima de 4s se mantiene igual', () => {
    const base = { firstConnectedAt: null, now: NOW, warmupWaived: true };
    // bajo el tope de 200: puede enviar, salvo que choque con la pausa mínima
    expect(sendGate({ ...base, sentLast24h: 199, lastSentAt: null })).toEqual({ ok: true });
    expect(sendGate({ ...base, sentLast24h: 0, lastSentAt: new Date(NOW.getTime() - 1_000) })).toEqual({
      ok: false,
      reason: 'gap',
      retryAt: new Date(NOW.getTime() - 1_000 + MIN_GAP_MS),
    });
    // al llegar a 200, se frena por el tope diario aunque haya waiver
    const over = sendGate({ ...base, sentLast24h: 200, lastSentAt: null });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe('daily');
  });

  it('sin waiver, el mismo volumen (200) ya estaría sobre el tope normal de un chip recién conectado (20/día)', () => {
    const r = sendGate({ firstConnectedAt: null, now: NOW, sentLast24h: 20, lastSentAt: null, warmupWaived: false });
    expect(r).toEqual({ ok: false, reason: 'daily', retryAt: new Date(NOW.getTime() + 60 * 60_000) });
  });

  it('una respuesta a quien escribió en las últimas 24 h nunca se frena por el tope diario, con o sin waiver', () => {
    for (const warmupWaived of [false, true]) {
      const r = sendGate({ firstConnectedAt: null, now: NOW, sentLast24h: 999, lastSentAt: null, replyInWindow: true, warmupWaived });
      expect(r).toEqual({ ok: true });
    }
  });
});

describe('warmupDay', () => {
  it('el día de calentamiento no cambia por el waiver (solo informativo; el tope real ya no depende de él)', () => {
    const first = new Date(NOW.getTime() - 3 * DAY_MS);
    expect(warmupDay(first, NOW)).toBe(4);
  });
});
