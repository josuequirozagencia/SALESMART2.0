import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const conv = (canDelete: boolean): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(HOUR), assigned_at: ago(2 * HOUR), closed_at: null, created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false, delete: canDelete }, sla: null,
});
const msg: ChatMessage = { id: 'm1', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'Hola', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null };

function server(canDelete: boolean, deletes: string[]) {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /conversations': () => ({ body: { items: [conv(canDelete)], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv(canDelete) }),
    'GET /conversations/c1/messages': () => ({ body: { items: [msg], next_cursor: null } }),
    'GET /conversations/c1/ai': () => ({ body: { agent: null, state: 'idle', reason: null, can_control: false } }),
    'DELETE /conversations/c1': () => { deletes.push('c1'); return { body: { id: 'c1', deleted: true } }; },
  };
  return routes;
}

describe('Inbox · eliminar conversación (ADR-63)', () => {
  it('con permiso: «Más › Eliminar conversación» pide confirmación (que dice que los mensajes se conservan) y, al confirmar, la elimina y vuelve a la lista', async () => {
    const deletes: string[] = [];
    mockApi(server(true, deletes));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Eliminar conversación' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar la conversación' });
    expect(dialog).toHaveTextContent('Los mensajes se conservan');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(deletes).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Más acciones' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Eliminar conversación' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, eliminar' }));
    await waitFor(() => expect(deletes).toEqual(['c1']));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Eliminar la conversación' })).not.toBeInTheDocument());
  });

  it('sin permiso no aparece la opción', async () => {
    mockApi(server(false, []));
    renderApp('/inbox/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Más acciones' }));
    expect(screen.queryByRole('menuitem', { name: 'Eliminar conversación' })).not.toBeInTheDocument();
  });
});
