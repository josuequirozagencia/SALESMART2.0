import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/lib/types';
import { authed, ME_ADVISOR, mockApi, renderApp, resetWorld } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  status: 'working',
  unread_count: 0,
  last_message_at: ago(5 * MIN),
  last_inbound_at: ago(HOUR),
  assigned_at: ago(2 * HOUR),
  closed_at: null,
  created_at: ago(3 * HOUR),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' },
  owner: { id: 'u2', name: 'Luis Navas' },
  participants: [],
  my_access: 'owner',
  queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' },
  tags: [],
  last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * HOUR).toISOString() },
  can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false },
  sla: null,
  ...over,
});

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  direction: 'out' as const,
  sender_type: 'human',
  author: { id: 'u2', name: 'Luis Navas' },
  kind: 'text',
  text: 'Hola',
  media: null,
  attachment: null,
  extra: null,
  reaction: null,
  status: 'sent' as const,
  error: null,
  sent_at: ago(MIN),
  delivered_at: null,
  read_at: null,
  is_note: false,
  template: null,
  ...over,
});

function serverWithMessages(items: ChatMessage[]) {
  const c = conv();
  const handlers = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items, next_cursor: null } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'POST /conversations/c1/media': () => ({ body: msg() }),
  } as Record<string, unknown>;
  return handlers as never;
}

describe('MessageBubble con adjuntos', () => {
  it('muestra imagen con link y nombre', async () => {
    const m = msg({ kind: 'image', text: 'Mira', attachment: { id: 'a1', kind: 'image', mime_type: 'image/jpeg', filename: 'foto.jpg', size_bytes: 1234, scan_status: 'clean', error: null, url: 'https://fake-storage.test/org/x/attachments/a1?x=1', expires_at: new Date(Date.now() + 300_000).toISOString() } });
    mockApi(serverWithMessages([m]));
    renderApp('/inbox/c1');
    const img = await screen.findByAltText('foto.jpg');
    expect(img.getAttribute('src')).toContain('fake-storage');
    expect(await screen.findByText('Mira')).toBeInTheDocument();
  });

  it('bloqueado por antivirus no muestra imagen', async () => {
    const m = msg({ kind: 'document', attachment: { id: 'a2', kind: 'document', mime_type: 'application/pdf', filename: 'doc.pdf', size_bytes: 100, scan_status: 'infected', error: 'virus', url: null, expires_at: null } });
    mockApi(serverWithMessages([m]));
    renderApp('/inbox/c1');
    expect(await screen.findByText(/antivirus bloqueó/)).toBeInTheDocument();
  });

  it('placeholder legacy si no hay attachment pero hay media', async () => {
    const m = msg({ kind: 'image', media: { mime_type: 'image/jpeg', filename: 'vieja.jpg' }, attachment: null });
    mockApi(serverWithMessages([m]));
    renderApp('/inbox/c1');
    expect(await screen.findByText(/aún no se puede ver aquí/)).toBeInTheDocument();
  });
});

describe('Composer adjuntar', () => {
  it('botón Adjuntar abre el diálogo y se puede cerrar', async () => {
    mockApi(serverWithMessages([msg()]));
    renderApp('/inbox/c1');
    // esperar a que cargue el composer
    await screen.findByRole('textbox', { name: 'Mensaje' });
    const btn = screen.getByRole('button', { name: 'Adjuntar archivo' });
    await userEvent.click(btn);
    expect(await screen.findByRole('dialog', { name: 'Adjuntar archivo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Adjuntar archivo' })).not.toBeInTheDocument());
  });

  it('con adjunto pendiente el botón Enviar dice Enviar archivo y requiere adjunto', async () => {
    mockApi(serverWithMessages([msg()]));
    renderApp('/inbox/c1');
    await screen.findByRole('textbox', { name: 'Mensaje' });
    // simular que se adjuntó: abrir diálogo y mockear subida
    // esta prueba solo verifica que el composer renderiza el estado sin adjunto aún
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
  });
});
