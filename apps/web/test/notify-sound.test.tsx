import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList } from '../src/lib/types';
import { sockets, lastSocket } from './fake-socket';
import { authed, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

const play = vi.hoisted(() => vi.fn(() => true));
const push = vi.hoisted(() => ({ support: 'ok' as 'ok' | 'unsupported' | 'insecure', sub: null as { endpoint: string } | null, enable: vi.fn(), disable: vi.fn(), showText: vi.fn() }));
vi.mock('../src/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/push')>()),
  pushSupport: () => push.support,
  notificationPermission: () => 'default' as NotificationPermission,
  currentSubscription: () => Promise.resolve(push.sub),
  enablePush: push.enable,
  disablePush: push.disable,
  updateShowText: push.showText,
}));
vi.mock('../src/lib/notifySound', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/notifySound')>()), playIncomingSound: play }));

beforeEach(() => {
  push.support = 'ok';
  push.sub = null;
  push.enable.mockReset();
  push.disable.mockReset();
  push.showText.mockReset();
  vi.unstubAllGlobals();
  resetWorld();
  sockets.length = 0;
  play.mockClear();
});

const NOW = new Date().toISOString();
let last: Conversation['last_message'] = { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW };
const conv = (): Conversation =>
  ({
    id: 'c1', status: 'working', unread_count: 1, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
    channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [], last_message: last,
    window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null,
  }) as Conversation;

function server(): Record<string, Handler> {
  return {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 1 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({ body: { items: [] as ChatMessage[], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
  };
}

const body = { organization_id: 'o1', request_id: 'r', at: NOW, data: { conversation_id: 'c1', message_id: 'm9' } };
const live = async () => {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  lastSocket().fire('connect');
};

describe('Sonido de mensaje nuevo', () => {
  it('suena una vez por mensaje entrante cuando la persona está en otra pantalla', async () => {
    last = { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW };
    mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    await live();
    lastSocket().fire('message.created', body);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    lastSocket().fire('message.created', body); // el mismo mensaje otra vez: no repite
    await new Promise((r) => setTimeout(r, 400));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('no suena por lo propio (último mensaje saliente o nota interna), ni por una actualización', async () => {
    last = { direction: 'out', kind: 'text', preview: 'Listo', status: 'sent', at: NOW };
    mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    await live();
    lastSocket().fire('message.created', body);
    lastSocket().fire('message.updated', body);
    await new Promise((r) => setTimeout(r, 500));
    expect(play).not.toHaveBeenCalled();
  });

  it('no suena si ya tiene esa conversación abierta y a la vista', async () => {
    last = { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW };
    mockApi(server());
    renderApp('/inbox/c1');
    await screen.findByText('Ana Torres');
    await live();
    lastSocket().fire('message.created', body);
    await new Promise((r) => setTimeout(r, 500));
    expect(play).not.toHaveBeenCalled();
  });

  it('no suena si la persona lo desactivó en Configuración › Notificaciones', async () => {
    last = { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW };
    window.localStorage.setItem('ss.sound.v1:u2:o1', 'off');
    mockApi(server());
    renderApp('/inbox');
    await screen.findByText('Ana Torres');
    await live();
    lastSocket().fire('message.created', body);
    await new Promise((r) => setTimeout(r, 500));
    expect(play).not.toHaveBeenCalled();
  });
});

describe('Configuración › Notificaciones', () => {
  const cfg = (enabled: boolean) => ({ ...server(), 'GET /push/config': () => ({ body: { enabled, public_key: enabled ? 'A'.repeat(87) : null } }) });

  it('el sonido viene activado, se desactiva y se recuerda por persona y empresa', async () => {
    mockApi(cfg(false));
    renderApp('/settings/notifications');
    const sw = await screen.findByRole('switch', { name: 'Sonido de mensaje nuevo' });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    expect(sw).not.toBeChecked();
    expect(window.localStorage.getItem('ss.sound.v1:u2:o1')).toBe('off');
  });

  it('si el servidor no tiene push, lo dice y no ofrece activarlo', async () => {
    mockApi(cfg(false));
    renderApp('/settings/notifications');
    expect(await screen.findByText(/no están activadas en este servidor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activar notificaciones' })).toBeNull();
  });

  it('un navegador sin push explica por qué (y qué hacer en iPhone)', async () => {
    push.support = 'unsupported';
    mockApi(cfg(true));
    renderApp('/settings/notifications');
    expect(await screen.findByText(/no admite notificaciones push/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activar notificaciones' })).toBeNull();
  });

  it('activar pide el permiso solo al pulsar: llama a enablePush con la clave del servidor y muestra «Activadas»', async () => {
    push.enable.mockImplementation(() => {
      push.sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x' };
      return Promise.resolve({ subscribed: true, show_text: false });
    });
    mockApi({ ...cfg(true), 'POST /push/status': () => ({ body: push.sub ? { subscribed: true, show_text: false } : { subscribed: false, show_text: false } }) });
    renderApp('/settings/notifications');
    const btn = await screen.findByRole('button', { name: 'Activar notificaciones' });
    expect(push.enable).not.toHaveBeenCalled(); // nada se pide al entrar
    await userEvent.click(btn);
    expect(push.enable).toHaveBeenCalledWith('A'.repeat(87), false);
    expect(await screen.findByText('Activadas en este navegador.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Mostrar el texto del mensaje/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole('switch', { name: /Mostrar el texto del mensaje/ }));
    expect(push.showText).toHaveBeenCalledWith(true);
    push.disable.mockImplementation(() => {
      push.sub = null;
      return Promise.resolve();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar en este navegador' }));
    expect(push.disable).toHaveBeenCalled();
    expect(await screen.findByText('Desactivadas en este navegador.')).toBeInTheDocument();
  });

  it('«Enviar notificación de prueba» llama al servidor y explica el resultado (enviada, navegador dado de baja, rechazada)', async () => {
    push.sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x' };
    let result = { sent: 1, gone: 0, failed: 0 };
    let calls = 0;
    mockApi({ ...cfg(true), 'POST /push/status': () => ({ body: { subscribed: true, show_text: false } }), 'POST /push/test': () => { calls += 1; return { body: result }; } });
    renderApp('/settings/notifications');
    const btn = await screen.findByRole('button', { name: 'Enviar notificación de prueba' });
    expect(calls).toBe(0); // nada se manda al entrar
    await userEvent.click(btn);
    expect(await screen.findByText(/Enviada\. Debería aparecer como notificación del sistema/)).toBeInTheDocument();
    result = { sent: 0, gone: 1, failed: 0 };
    await userEvent.click(screen.getByRole('button', { name: 'Enviar notificación de prueba' }));
    expect(await screen.findByText(/ya no estaba suscrito/)).toBeInTheDocument();
    result = { sent: 0, gone: 0, failed: 1 };
    await userEvent.click(screen.getByRole('button', { name: 'Enviar notificación de prueba' }));
    expect(await screen.findByText(/no aceptó el aviso/)).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it('sin suscripción en este navegador no se ofrece la prueba', async () => {
    mockApi({ ...cfg(true), 'POST /push/status': () => ({ body: { subscribed: false, show_text: false } }) });
    renderApp('/settings/notifications');
    await screen.findByRole('button', { name: 'Activar notificaciones' });
    expect(screen.queryByRole('button', { name: 'Enviar notificación de prueba' })).toBeNull();
  });

  it('si el navegador niega el permiso, el mensaje de error se muestra', async () => {
    push.enable.mockRejectedValue(new Error('El navegador bloqueó las notificaciones. Actívalas desde el candado de la barra de direcciones.'));
    mockApi({ ...cfg(true), 'POST /push/status': () => ({ body: { subscribed: false, show_text: false } }) });
    renderApp('/settings/notifications');
    await userEvent.click(await screen.findByRole('button', { name: 'Activar notificaciones' }));
    expect(await screen.findByText(/bloqueó las notificaciones/)).toBeInTheDocument();
  });
});
