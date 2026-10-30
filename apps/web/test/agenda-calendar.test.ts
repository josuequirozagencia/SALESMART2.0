import { describe, expect, it } from 'vitest';
import { mondayOf, monthStart, periodLabel, shiftMonth, visibleDays } from '../src/features/appointments/AgendaCalendar';

describe('calendario de la agenda · fechas', () => {
  it('el lunes de la semana y el primer día del mes', () => {
    expect(mondayOf('2026-10-28')).toBe('2026-10-26'); // miércoles
    expect(mondayOf('2026-10-26')).toBe('2026-10-26'); // lunes
    expect(mondayOf('2026-11-01')).toBe('2026-10-26'); // domingo: pertenece a la semana que empezó el lunes anterior
    expect(monthStart('2026-10-28')).toBe('2026-10-01');
  });

  it('cambiar de mes cruza los años en ambos sentidos', () => {
    expect(shiftMonth('2026-10-28', 1)).toBe('2026-11-01');
    expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-01');
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-01');
    expect(shiftMonth('2026-03-31', -13)).toBe('2025-02-01');
    expect(shiftMonth('2026-10-28', 0)).toBe('2026-10-01');
  });

  it('el mes se pinta con seis semanas completas desde un lunes; la semana, con siete días', () => {
    const month = visibleDays('month', '2026-10-28');
    expect(month).toHaveLength(42);
    expect(month[0]).toBe('2026-09-28'); // el 1 de octubre fue jueves
    expect(month.at(-1)).toBe('2026-11-08');
    expect(month).toContain('2026-10-01');
    expect(month).toContain('2026-10-31');
    const week = visibleDays('week', '2026-10-28');
    expect(week).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  });

  it('el título del periodo está en español', () => {
    expect(periodLabel('month', '2026-10-28')).toBe('octubre de 2026');
    expect(periodLabel('week', '2026-10-28')).toContain('lunes, 26 de octubre');
    expect(periodLabel('week', '2026-10-28')).toContain('domingo, 1 de noviembre');
  });
});
