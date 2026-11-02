import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Onboarding } from '../src/features/onboarding/useOnboarding';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); try { window.localStorage.clear(); } catch { /* sin almacenamiento */ } });

const steps = (done: string[] = []): Onboarding => {
  const all: Onboarding['steps'] = [
    { id: 'channel', label: 'Conecta un canal', hint: 'WhatsApp oficial o por QR.', done: false, to: '/settings/connections' },
    { id: 'advisor', label: 'Invita a un asesor', hint: 'Dale acceso a tu equipo.', done: false, to: '/users' },
    { id: 'department', label: 'Asígnalo a un departamento', hint: 'Así le llegan las conversaciones.', done: false, to: '/departments' },
    { id: 'agent', label: 'Revisa el agente de ejemplo', hint: 'Está apagado.', done: false, to: '/agents' },
    { id: 'form', label: 'Publica o prueba el formulario', hint: 'El de ejemplo está en borrador.', done: false, to: '/forms' },
  ].map((s) => ({ ...s, done: done.includes(s.id) })) as Onboarding['steps'];
  const n = all.filter((s) => s.done).length;
  return { steps: all, done: n, total: 5, complete: n === 5 };
};
const home = (o: Onboarding | 'forbidden', extra: Record<string, Handler> = {}) => {
  const r = mockApi({
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /onboarding': () => (o === 'forbidden' ? err(403, 'FORBIDDEN') : { body: o }),
    'GET /analytics/summary': () => err(403, 'FORBIDDEN'),
    ...extra,
  });
  return r;
};

describe('«Primeros pasos»', () => {
  it('el administrador ve los cinco pasos con su avance; lo hecho sale tachado y sin «Ir», y cada pendiente lleva a su pantalla', async () => {
    home(steps(['advisor']));
    renderApp('/');
    const card = within(await screen.findByRole('region', { name: 'Primeros pasos' }));
    expect(card.getByText('1 de 5 listos', { exact: false })).toBeInTheDocument();
    expect(card.getByRole('progressbar', { name: 'Avance de los primeros pasos' })).toHaveAttribute('aria-valuenow', '1');
    expect(card.getAllByRole('listitem')).toHaveLength(5);
    expect(card.getByText('(hecho)')).toBeInTheDocument();
    expect(card.getAllByText('(pendiente)')).toHaveLength(4);
    const links = card.getAllByRole('link', { name: 'Ir' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/settings/connections', '/departments', '/agents', '/forms']);
  });

  it('se oculta sola cuando todo está hecho', async () => {
    home(steps(['channel', 'advisor', 'department', 'agent', 'form']));
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola,/ });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument());
  });

  it('se puede cerrar y no vuelve a aparecer en este navegador', async () => {
    home(steps());
    renderApp('/');
    await userEvent.click(within(await screen.findByRole('region', { name: 'Primeros pasos' })).getByRole('button', { name: 'Cerrar los primeros pasos' }));
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('ss:onboarding-dismissed:o1')).toBe('1');
  });

  it('ya cerrada, ni siquiera pide los pasos al servidor', async () => {
    window.localStorage.setItem('ss:onboarding-dismissed:o1', '1');
    const api = home(steps());
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola,/ });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    expect(api.count('GET /onboarding')).toBe(0);
  });

  it('un asesor no la ve ni la pide; tampoco quien mira como otro rol', async () => {
    const api = mockApi({ ...authed(ME_ADVISOR), 'GET /custom-fields': () => ({ body: { items: [], access: { manage: false } } }), 'GET /analytics/summary': () => err(403, 'FORBIDDEN'), 'GET /onboarding': () => err(403, 'FORBIDDEN') });
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola,/ });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
    expect(api.count('GET /onboarding')).toBe(0);
  });

  it('si el servidor responde 403 la tarjeta no aparece y no rompe el Inicio', async () => {
    home('forbidden');
    renderApp('/');
    await screen.findByRole('heading', { name: /Hola,/ });
    expect(screen.queryByRole('region', { name: 'Primeros pasos' })).not.toBeInTheDocument();
  });
});

describe('la marca «Ejemplo»', () => {
  const queue = { id: 'q1', name: 'General', color: '#7c5cfa', distribution_on: false, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3, greeting: null, out_of_hours_message: null, auto_close_hours: 0, hours: null, open_now: true, members: [], channels: [], unassigned_count: 0, created_at: '', updated_at: '' };

  it('los datos creados por el sistema se marcan «Ejemplo» en la lista de departamentos y los propios no', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /queues': () => ({ body: { items: [{ ...queue, is_sample: true }, { ...queue, id: 'q2', name: 'Ventas', is_sample: false }], limits: { max_queues: 20 } } }) });
    renderApp('/departments');
    const general = await screen.findByRole('button', { name: 'Configurar General' });
    expect(within(general).getByText('Ejemplo')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Configurar Ventas' })).queryByText('Ejemplo')).not.toBeInTheDocument();
  });
});
