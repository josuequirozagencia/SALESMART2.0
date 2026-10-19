import { describe, expect, it } from 'vitest';
import { abilities, windowOf, WINDOW_MS, type InboxScope } from '../../src/modules/inbox/inbox.access';
import { previewOf } from '../../src/modules/inbox/inbox.views';
import { backoffMs, SEND_LEASE_MS, SEND_MAX_ATTEMPTS } from '../../src/modules/inbox/outbound-dispatcher.service';

describe('espera entre reintentos de envío', () => {
  it('crece al doble desde 15 s y se detiene en 10 minutos', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n) / 1000)).toEqual([15, 30, 60, 120, 240, 480, 600, 600]);
    expect(backoffMs(0)).toBe(15_000); // un número raro no da una espera negativa ni cero
  });

  it('la reserva de un envío en curso dura más que lo que se espera al proveedor (10 s) y los intentos suman minutos, no horas', () => {
    expect(SEND_LEASE_MS).toBeGreaterThan(10_000 * 2);
    expect(SEND_MAX_ATTEMPTS).toBe(5);
    const total = Array.from({ length: SEND_MAX_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1)).reduce((a, b) => a + b, 0);
    expect(total).toBe(225_000);
  });
});

describe('vista previa de un mensaje', () => {
  it('una línea: junta los espacios y saltos, recorta a 140 y, sin texto, nombra el tipo de contenido', () => {
    expect(previewOf('text', '  Hola,\n\n  ¿tienen   cita?  ')).toBe('Hola, ¿tienen cita?');
    const long = previewOf('text', 'a'.repeat(500));
    expect(long).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
    expect(previewOf('image', null)).toBe('Imagen');
    expect(previewOf('audio', '')).toBe('Audio');
    expect(previewOf('location', '   ')).toBe('Ubicación');
    expect(previewOf('unsupported', null)).toBe('Mensaje no compatible');
    expect(previewOf('algo-nuevo', null)).toBe('Mensaje');
  });
});

describe('ventana de 24 h', () => {
  const now = new Date('2025-10-10T12:00:00Z');
  it('abierta hasta cumplir las 24 h del último mensaje del cliente; cerrada después o sin mensajes del cliente', () => {
    expect(windowOf(new Date(now.getTime() - WINDOW_MS + 1), now).open).toBe(true);
    expect(windowOf(new Date(now.getTime() - WINDOW_MS), now).open).toBe(false); // justo a las 24 h ya no
    expect(windowOf(null, now)).toEqual({ open: false, expires_at: null });
    expect(windowOf(new Date('2025-10-10T11:00:00Z'), now).expires_at).toBe('2025-10-11T11:00:00.000Z');
  });
});

describe('qué puede hacer cada persona con una conversación', () => {
  const me = 'u-1';
  const advisor: InboxScope = { userId: me, viewAll: false, canReply: true };
  const admin: InboxScope = { userId: 'u-2', viewAll: true, canReply: true };
  const reader: InboxScope = { userId: 'u-3', viewAll: true, canReply: false };

  it('el dueño responde y acepta lo pendiente; nadie más responde', () => {
    expect(abilities(advisor, { status: 'pending', ownerId: me }, 'active')).toEqual({ reply: true, note: true, accept: true, take: false, close: true });
    expect(abilities(advisor, { status: 'working', ownerId: me }, 'active')).toEqual({ reply: true, note: true, accept: false, take: false, close: true });
    expect(abilities(advisor, { status: 'waiting', ownerId: me }, 'active').reply).toBe(true);
    expect(abilities(admin, { status: 'working', ownerId: me }, 'active')).toEqual({ reply: false, note: true, accept: false, take: false, close: true });
  });

  it('lo sin asignar solo lo toma quien ve todo; lo finalizado no admite nada salvo notas', () => {
    expect(abilities(admin, { status: 'unassigned', ownerId: null }, 'active')).toEqual({ reply: false, note: true, accept: false, take: true, close: true });
    expect(abilities(advisor, { status: 'unassigned', ownerId: null }, 'active').take).toBe(false);
    expect(abilities(advisor, { status: 'closed', ownerId: me }, 'active')).toEqual({ reply: false, note: true, accept: false, take: false, close: false });
  });

  it('con la conexión desactivada o desconectada no se responde; sin permiso de responder, nada de lo que escribe', () => {
    expect(abilities(advisor, { status: 'working', ownerId: me }, 'disabled').reply).toBe(false);
    expect(abilities(advisor, { status: 'working', ownerId: me }, 'removed').reply).toBe(false);
    expect(abilities(reader, { status: 'unassigned', ownerId: null }, 'active')).toEqual({ reply: false, note: false, accept: false, take: false, close: false });
  });
});
