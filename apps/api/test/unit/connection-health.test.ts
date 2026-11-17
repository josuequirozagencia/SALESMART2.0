import { describe, expect, it } from 'vitest';
import { alertReasons, describeError, judge, type HealthFacts } from '../../src/modules/connection-health';

const ok: HealthFacts = { lagCount: 10, lagMedianS: 1.2, overdueEvents: 0, failedEvents: 0, sessionState: 'open', silentBusinessHours: 0.5 };

describe('salud de una conexión (v19 B1)', () => {
  it('sana: retraso de segundos, sin avisos atrasados ni fallidos y sesión abierta', () => {
    expect(judge(ok)).toEqual({ level: 'ok', reasons: [] });
    expect(alertReasons(ok)).toEqual([]);
  });

  it('el retraso mediano manda: más de 1 min es «atención»; más de 5 min es «crítico»; con menos de 3 mensajes no se opina', () => {
    expect(judge({ ...ok, lagMedianS: 61 })).toEqual({ level: 'warn', reasons: ['lag'] });
    expect(judge({ ...ok, lagMedianS: 60 })).toEqual({ level: 'ok', reasons: [] });
    expect(judge({ ...ok, lagMedianS: 301 })).toEqual({ level: 'crit', reasons: ['lag'] });
    expect(judge({ ...ok, lagCount: 2, lagMedianS: 99_999 })).toEqual({ level: 'ok', reasons: [] }); // muy poca muestra: ruido
    expect(judge({ ...ok, lagCount: 0, lagMedianS: null })).toEqual({ level: 'ok', reasons: [] });
  });

  it('avisos fallidos y sesión caída son críticos; avisos atrasados y silencio en horario laboral, atención; se acumulan las razones', () => {
    expect(judge({ ...ok, failedEvents: 1 })).toEqual({ level: 'crit', reasons: ['failed'] });
    expect(judge({ ...ok, sessionState: 'closed' })).toEqual({ level: 'crit', reasons: ['session_down'] });
    expect(judge({ ...ok, sessionState: 'logged_out' }).reasons).toEqual(['session_down']);
    expect(judge({ ...ok, overdueEvents: 3 })).toEqual({ level: 'warn', reasons: ['backlog'] });
    expect(judge({ ...ok, silentBusinessHours: 6 })).toEqual({ level: 'warn', reasons: ['silent'] });
    expect(judge({ ...ok, silentBusinessHours: 5.9 }).level).toBe('ok');
    expect(judge({ ...ok, lagMedianS: 400, failedEvents: 2, overdueEvents: 1 })).toEqual({ level: 'crit', reasons: ['failed', 'lag', 'backlog'] });
  });

  it('el silencio solo cuenta con la sesión abierta (una conectando o sin vincular no «calla»)', () => {
    for (const sessionState of ['created', 'connecting', null] as const) expect(judge({ ...ok, sessionState, silentBusinessHours: 20 }).reasons).toEqual([]);
  });

  it('avisa al administrador solo de lo grave: fallidos, retraso crítico, tarea atrasada y silencio prolongado (la atención por retraso leve no)', () => {
    expect(alertReasons({ ...ok, lagMedianS: 120 })).toEqual([]);
    expect(alertReasons({ ...ok, lagMedianS: 600 })).toEqual(['lag']);
    expect(alertReasons({ ...ok, failedEvents: 1, overdueEvents: 2, silentBusinessHours: 7 })).toEqual(['failed', 'backlog', 'silent']);
    expect(alertReasons({ ...ok, sessionState: 'closed' })).toEqual([]); // la sesión caída ya se ve y se avisa en Conexiones
  });

  it('explica el error de un aviso fallido sin mostrar nada del cliente', () => {
    expect(describeError(null)).toMatch(/sin detalle/);
    expect(describeError('Error:23505')).toMatch(/base de datos rechazó/);
    expect(describeError('Error:40P01')).toMatch(/ocupada/);
    expect(describeError('Error:08006')).toMatch(/Se cortó la conexión/);
    expect(describeError('TypeError')).toMatch(/formato/);
    expect(describeError('Raro:XX')).toContain('Raro:XX');
  });
});
