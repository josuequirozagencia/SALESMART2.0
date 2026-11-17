// v17 · 17.1 — la regla de quién recibe una campaña (ADR-72) es una función PURA: aquí se demuestra sin base de datos. Un contacto `revoked` jamás entra.
import { describe, expect, it } from 'vitest';
import { classify, effectiveDailyCap, estimate, qrChannelCap } from '../../src/modules/campaigns/audience';
import type { AudienceContact } from '../../src/modules/contacts';

const c = (id: string, consent: AudienceContact['consent'], phone: string | null = `+5939880${id.padStart(4, '0')}`): AudienceContact => ({ id, name: `Contacto ${id}`, consent, phone });

describe('classify', () => {
  it('un contacto revocado NUNCA entra: ni incluyendo los sin consentimiento, ni aunque nadie lo desmarque, ni sin teléfono distinto', () => {
    for (const includeUnknownConsent of [false, true]) {
      const r = classify([c('1', 'revoked'), c('2', 'granted')], { excluded: new Set(), includeUnknownConsent });
      expect(r.eligible.map((x) => x.id)).toEqual(['2']);
      expect(r.counts.revoked).toBe(1);
    }
    // aunque además esté desmarcado a mano o sin teléfono, el motivo que se cuenta es el de la baja
    const r = classify([c('1', 'revoked', null)], { excluded: new Set(['1']), includeUnknownConsent: true });
    expect(r.eligible).toEqual([]);
    expect(r.skipped).toEqual([{ id: '1', reason: 'revoked' }]);
  });

  it('sin consentimiento definido: fuera por omisión, dentro solo si el administrador lo declaró; sin teléfono y desmarcados, fuera siempre', () => {
    const all = [c('1', 'granted'), c('2', 'unknown'), c('3', 'granted', null), c('4', 'granted'), c('5', 'unknown')];
    const base = classify(all, { excluded: new Set(['4']), includeUnknownConsent: false });
    expect(base.eligible.map((x) => x.id)).toEqual(['1']);
    expect(base.counts).toEqual({ revoked: 0, excluded: 1, no_phone: 1, no_consent: 2, duplicate: 0 });
    const declared = classify(all, { excluded: new Set(['4']), includeUnknownConsent: true });
    expect(declared.eligible.map((x) => x.id)).toEqual(['1', '2', '5']);
    expect(declared.counts.no_consent).toBe(0);
  });

  it('un mismo teléfono entra una sola vez (el primero de la audiencia); los demás son «duplicado»', () => {
    const r = classify([c('1', 'granted', '+593988000001'), c('2', 'granted', '+593988000001'), c('3', 'granted', '+593988000002')], { excluded: new Set(), includeUnknownConsent: false });
    expect(r.eligible.map((x) => x.id)).toEqual(['1', '3']);
    expect(r.skipped).toEqual([{ id: '2', reason: 'duplicate' }]);
  });

  it('el orden de los motivos es el de la regla y los conteos suman todo lo que no entra', () => {
    const r = classify([c('1', 'revoked'), c('2', 'granted', null), c('3', 'unknown'), c('4', 'granted'), c('5', 'granted')], { excluded: new Set(['4']), includeUnknownConsent: false });
    expect(r.skipped.map((s) => s.reason)).toEqual(['revoked', 'no_phone', 'no_consent', 'excluded']);
    expect(r.eligible.length + r.skipped.length).toBe(5);
  });
});

describe('effectiveDailyCap', () => {
  it('oficial: el mínimo entre la campaña, el asesor y el tope de la empresa (1 000 provisional)', () => {
    expect(effectiveDailyCap({ mode: 'template', campaignCap: 5000, advisorCap: null, qrWarmupLimit: 0 })).toEqual({ cap: 1000, channelCap: 1000 });
    expect(effectiveDailyCap({ mode: 'template', campaignCap: 500, advisorCap: 100, qrWarmupLimit: 0 }).cap).toBe(100);
    expect(effectiveDailyCap({ mode: 'template', campaignCap: 50, advisorCap: 100, qrWarmupLimit: 0 }).cap).toBe(50);
  });

  it('QR: la campaña usa como máximo el 70 % del cupo del calentamiento (el resto queda para las conversaciones) y nunca baja de 1', () => {
    expect(effectiveDailyCap({ mode: 'text', campaignCap: 1000, advisorCap: null, qrWarmupLimit: 250 })).toEqual({ cap: 175, channelCap: 175 });
    expect(effectiveDailyCap({ mode: 'text', campaignCap: 1000, advisorCap: null, qrWarmupLimit: 20 }).channelCap).toBe(14); // chip recién conectado
    expect(effectiveDailyCap({ mode: 'text', campaignCap: 1000, advisorCap: 10, qrWarmupLimit: 250 }).cap).toBe(10);
    expect(effectiveDailyCap({ mode: 'text', campaignCap: 1, advisorCap: null, qrWarmupLimit: 1 }).cap).toBe(1);
  });
});

describe('estimate', () => {
  it('días según el tope diario y minutos del primer día según la pausa; sin destinatarios, nada', () => {
    expect(estimate(0, 100, 60)).toEqual({ days: 0, first_day_minutes: 0 });
    expect(estimate(250, 100, 60)).toEqual({ days: 3, first_day_minutes: 100 });
    expect(estimate(10, 100, 45)).toEqual({ days: 1, first_day_minutes: 8 });
    expect(estimate(1, 100, 5).first_day_minutes).toBe(1);
  });
});

describe('qrChannelCap', () => {
  it('el 70 % del cupo del calentamiento de hoy para las campañas; nunca menos de 1', () => {
    expect([qrChannelCap(20), qrChannelCap(50), qrChannelCap(100), qrChannelCap(250), qrChannelCap(1)]).toEqual([14, 35, 70, 175, 1]);
  });
});
