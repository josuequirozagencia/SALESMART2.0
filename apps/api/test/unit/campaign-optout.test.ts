import { describe, expect, it } from 'vitest';
import { isOptOutText, normalizeOptOut } from '../../src/modules/campaigns/campaign-optout';

describe('la baja por palabra clave de las campañas (17.5)', () => {
  it('normaliza: minúsculas, sin acentos ni signos, espacios colapsados', () => {
    expect(normalizeOptOut('  ¡NO   MÁS!  ')).toBe('no mas');
    expect(normalizeOptOut('Baja.')).toBe('baja');
  });

  it('reconoce la frase entera, con o sin mayúsculas, acentos y signos', () => {
    for (const t of ['BAJA', 'baja', 'Stop', 'STOP!!', 'no más', 'No mas.', '¡No más mensajes!', 'dar de baja', 'Darme de baja', 'Unsubscribe', 'no quiero más mensajes', 'No me escriban más']) {
      expect(isOptOutText(t), t).toBe(true);
    }
  });

  it('una frase PARECIDA no es una baja: solo vale el mensaje entero', () => {
    for (const t of ['quiero dar de baja mi plan', 'cancelar', 'cancelar mi cita', 'stop me', 'no más de 2 personas', 'gracias', 'ok', 'no', 'alto', '', '   ', 'baja el precio']) {
      expect(isOptOutText(t), t).toBe(false);
    }
  });

  it('sin texto, o con un texto larguísimo, no es una baja', () => {
    expect(isOptOutText(null)).toBe(false);
    expect(isOptOutText(undefined)).toBe(false);
    expect(isOptOutText('baja '.repeat(50))).toBe(false);
  });
});
