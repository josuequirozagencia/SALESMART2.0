import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companyTime, howLabel, stepLabel, type Assignment } from '../src/features/inbox/AssignmentSection';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const NOW = new Date().toISOString();
const ANA = { id: 'u1', name: 'Alicia Torres' };
const LUIS = { id: 'u2', name: 'Luis Navas' };
const conv = {
  id: 'c1', status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: LUIS, participants: [], my_access: 'supervisor',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' }, channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW }, window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null,
} as unknown as Conversation;

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  owner: LUIS, assigned_at: '2026-11-27T15:05:00.000Z', how: 'transferred', how_by: ANA, queue: { id: 'q1', name: 'Ventas' }, history_scope: 'all', time_zone: 'America/Guayaquil',
  shared: [{ user: { id: 'u3', name: 'eva@a.test' }, permission: 'view', added_by: ANA, added_at: '2026-11-27T16:00:00.000Z' }],
  history: [
    { at: '2026-11-27T15:05:00.000Z', kind: 'transferred', from: ANA, to: LUIS, by: ANA },
    { at: '2026-11-27T14:00:00.000Z', kind: 'taken', from: null, to: ANA, by: ANA },
  ],
  ...over,
});

function server(value: Assignment | 'error') {
  const handlers: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /conversations': () => ({ body: { items: [conv], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/assignment': () => (value === 'error' ? err(500, 'INTERNAL_ERROR', 'Error interno') : { body: value }),
  };
  mockApi(handlers);
}
/** El panel del contacto: a este ancho de pruebas nace plegado y se abre desde la cabecera. */
async function openBlock() {
  renderApp('/inbox/c1');
  const find = () => screen.queryByRole('complementary', { name: 'Datos del contacto' });
  await screen.findByRole('heading', { name: 'Ana Torres' });
  if (!find()) await userEvent.click(screen.getByRole('button', { name: /datos del contacto/i }));
  return within(await screen.findByRole('region', { name: 'Asignación' }));
}

describe('Bloque «Asignación» (V24)', () => {
  it('muestra asesor, cómo, departamento, con quién está compartida (sin correos) y el historial en orden', async () => {
    server(assignment());
    const b = await openBlock();
    expect(await b.findByText('Asignada manualmente por Alicia Torres')).toBeInTheDocument();
    expect(b.getByText('Ventas')).toBeInTheDocument();
    expect(b.getByText(/desde el 27\/11\/2026/)).toBeInTheDocument();
    expect(b.getByText(/Solo ver y notas/)).toBeInTheDocument();
    expect(b.queryByText(/eva@a\.test/)).toBeNull();
    const items = within(b.getByRole('list', { name: 'Historial de asignación' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('De Alicia Torres a Luis Navas · Alicia Torres'), expect.stringContaining('Alicia Torres la tomó')]);
  });

  it('sin dueño ni compartidos lo dice; más de 10 pasos se ven con «Ver todo»', async () => {
    const history = Array.from({ length: 12 }, (_x, i) => ({ at: new Date(Date.UTC(2026, 10, 27, 12, i)).toISOString(), kind: 'distribution' as const, from: null, to: LUIS, by: null }));
    server(assignment({ owner: null, assigned_at: null, how: null, how_by: null, queue: null, shared: [], history }));
    const b = await openBlock();
    expect(await b.findByText('Sin asignar')).toBeInTheDocument();
    expect(b.getByText('No está compartida')).toBeInTheDocument();
    expect(b.getByText('Sin departamento')).toBeInTheDocument();
    const list = b.getByRole('list', { name: 'Historial de asignación' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await userEvent.click(b.getByRole('button', { name: 'Ver todo (12)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
  });

  it('un fallo se muestra con «Reintentar»', async () => {
    server('error');
    const b = await openBlock();
    await waitFor(() => expect(b.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument());
  });

  it('textos y hora de la empresa', () => {
    expect(howLabel('distribution', null)).toBe('Reparto automático');
    expect(howLabel('taken', ANA)).toBe('Tomada por Alicia Torres');
    expect(stepLabel({ at: NOW, kind: 'reassigned', from: ANA, to: LUIS, by: null })).toBe('De Alicia Torres a Luis Navas · por falta de respuesta');
    expect(companyTime('2026-11-27T03:30:00.000Z', 'America/Guayaquil')).toContain('26/11/2026');
    expect(companyTime('2026-11-27T03:30:00.000Z', 'Zona/Inexistente')).toContain('/11/2026');
  });
});
