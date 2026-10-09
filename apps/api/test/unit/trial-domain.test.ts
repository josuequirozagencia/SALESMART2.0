import { describe, expect, it } from 'vitest';
import { canRequestExtension, extendedEnd, isTrialExpired } from '../../src/modules/organizations/trial.domain';

const D = 86_400_000;
const t0 = new Date('2026-10-09T12:00:00Z');

describe('reglas de la prueba (ADR-23)', () => {
  it('vencida por la hora aunque el job no la haya marcado; vigente justo antes del fin; vencida en el instante exacto', () => {
    expect(isTrialExpired({ status: 'active', endsAt: new Date(t0.getTime() - 1) }, t0)).toBe(true);
    expect(isTrialExpired({ status: 'active', endsAt: new Date(t0.getTime()) }, t0)).toBe(true); // ends_at es exclusivo
    expect(isTrialExpired({ status: 'active', endsAt: new Date(t0.getTime() + 1) }, t0)).toBe(false);
  });

  it('el estado materializado por el job también cuenta como vencida', () => {
    expect(isTrialExpired({ status: 'expired', endsAt: new Date(t0.getTime() + 5 * D) }, t0)).toBe(true);
  });

  it('extensión aprobada ANTES de vencer: suma al fin vigente', () => {
    const end = new Date(t0.getTime() + 2 * D);
    expect(extendedEnd(end, t0, 3).getTime()).toBe(end.getTime() + 3 * D);
  });

  it('extensión aprobada DESPUÉS de vencer: cuenta desde la aprobación', () => {
    const end = new Date(t0.getTime() - 5 * D);
    expect(extendedEnd(end, t0, 3).getTime()).toBe(t0.getTime() + 3 * D);
  });

  it('aprobada justo en el fin: cuenta desde ese instante', () => {
    expect(extendedEnd(t0, t0, 3).getTime()).toBe(t0.getTime() + 3 * D);
  });

  it('solo se puede pedir la extensión una vez (none)', () => {
    expect(canRequestExtension('none')).toBe(true);
    for (const s of ['pending', 'approved', 'denied'] as const) expect(canRequestExtension(s)).toBe(false);
  });
});
