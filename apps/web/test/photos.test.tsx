import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation, ConversationList, InboxOptions } from '../src/lib/types';
import { Avatar } from '../src/ui/Avatar';
import { authed, ME_ADVISOR, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const conv = (): Conversation => ({
  id: 'c1', status: 'working', unread_count: 0, last_message_at: ago(5 * MIN), last_inbound_at: ago(60 * MIN), assigned_at: ago(120 * MIN), closed_at: null, created_at: ago(180 * MIN),
  contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: { id: 'q1', name: 'Ventas', color: '#7c5cfa' },
  channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }, tags: [], last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: ago(5 * MIN) },
  window: { open: true, expires_at: new Date(Date.now() + 23 * 60 * MIN).toISOString() }, can: { reply: true, note: true, accept: false, take: false, close: true, transfer: true, share: true }, sla: null,
});
const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: 'm', direction: 'in', sender_type: 'contact', author: null, kind: 'text', text: 'x', media: null, extra: null, reaction: null, status: 'received', error: null, sent_at: ago(10 * MIN), delivered_at: null, read_at: null, is_note: false, template: null, attachment: null, ...over });
const OPTIONS: InboxOptions = { queues: [], channels: [{ id: 'ch1', name: 'Barbería WhatsApp', state: 'active' }], owners: [], tags: [] };
const PHOTO = 'https://fake-storage.test/org/o1/contacts/k1/a.jpg?expires=1';
const LUIS = 'https://fake-storage.test/org/o1/members/u2/b.png?expires=1';

describe('Avatar', () => {
  it('con foto la muestra pequeña, diferida y sin texto alternativo; sin foto, las siglas', () => {
    const { container, rerender } = render(<Avatar name="Ana Torres" src={PHOTO} size={40} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', PHOTO);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '40');
    rerender(<Avatar name="Ana Torres" src={null} size={40} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('AT');
  });

  it('si la imagen falla al cargar vuelve a las siglas (sin imagen rota); una foto nueva se vuelve a intentar', async () => {
    const { container, rerender } = render(<Avatar name="Ana Torres" src={PHOTO} />);
    container.querySelector('img')!.dispatchEvent(new Event('error'));
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('AT');
    });
    rerender(<Avatar name="Ana Torres" src={LUIS} />);
    expect(container.querySelector('img')).toHaveAttribute('src', LUIS);
  });
});

describe('Inbox con fotos', () => {
  const server = (photos: { contacts: Record<string, string>; users: Record<string, string> }): Record<string, Handler> => ({
    ...authed(ME_ADVISOR),
    'GET /photos': () => ({ body: photos }),
    'GET /conversations': () => ({ body: { items: [conv()], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } satisfies ConversationList }),
    'GET /conversations/options': () => ({ body: OPTIONS }),
    'GET /conversations/c1': () => ({ body: conv() }),
    'GET /conversations/c1/messages': () => ({
      body: {
        items: [
          msg({ id: 'm1', text: 'Hola' }),
          msg({ id: 'm2', text: '¿Hay cita?', sent_at: ago(9 * MIN) }),
          msg({ id: 'm3', direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, text: 'Sí, mañana', status: 'sent', sent_at: ago(8 * MIN) }),
          msg({ id: 'm4', direction: 'out', sender_type: 'human', author: { id: 'u2', name: 'Luis Navas' }, text: 'A las 10', status: 'sent', sent_at: ago(7 * MIN) }),
          msg({ id: 'm5', direction: 'out', sender_type: 'ai', text: 'Te espero', status: 'sent', sent_at: ago(6 * MIN) }),
        ],
        next_cursor: null,
      },
    }),
    'POST /conversations/c1/read': () => ({ body: conv() }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [] } }),
    'GET /contacts/k1': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x', request_id: 'r', details: [] } } }),
  });

  it('la lista y el chat muestran la foto del contacto cuando existe y la del asesor junto a SUS mensajes, una vez por grupo', async () => {
    const api = mockApi(server({ contacts: { k1: PHOTO }, users: { u2: LUIS } }));
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await within(log).findByText('A las 10');
    await waitFor(() => expect(log.querySelectorAll('img').length).toBeGreaterThan(0));
    const imgs = [...log.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    // un avatar del contacto (dos mensajes seguidos) y uno del asesor (dos mensajes seguidos); el agente de IA lleva su insignia, no una foto
    expect(imgs.filter((s) => s === PHOTO)).toHaveLength(1);
    expect(imgs.filter((s) => s === LUIS)).toHaveLength(1);
    expect(within(log).getByText('IA')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Conversaciones' });
    await waitFor(() => expect(list.querySelector(`img[src="${PHOTO}"]`)).not.toBeNull());
    // se pidieron por lote, sin ids repetidos
    const call = api.calls.find((c) => c.path === '/photos' && c.query.get('users') === 'u2');
    expect(call?.query.get('contacts')).toBe('k1');
  });

  it('sin fotos (WhatsApp oficial, GoHighLevel o sin foto) todo sigue con siglas', async () => {
    mockApi(server({ contacts: {}, users: {} }));
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await within(log).findByText('A las 10');
    expect(log.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Conversaciones' }).querySelectorAll('img')).toHaveLength(0);
  });

  it('si la consulta de fotos falla la pantalla funciona igual', async () => {
    mockApi({ ...server({ contacts: {}, users: {} }), 'GET /photos': () => ({ status: 500, body: { error: { code: 'X', message: 'x', request_id: 'r', details: [] } } }) });
    renderApp('/inbox/c1');
    const log = await screen.findByRole('log', { name: 'Mensajes' });
    await within(log).findByText('A las 10');
    expect(log.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('Configuración › Apariencia › Mi foto', () => {
  const file = (name: string, type: string, size = 100): File => new File([new Uint8Array(size)], name, { type });

  it('subir una foto la manda tal cual, se ve en la sección y se puede quitar', async () => {
    let current: string | null = null;
    const api = mockApi({
      ...authed(ME_ADMIN),
      'GET /me/photo': () => ({ body: { photo_url: current } }),
      'PUT /me/photo': () => ((current = LUIS), { body: { photo_url: current } }),
      'DELETE /me/photo': () => ((current = null), { body: { photo_url: null } }),
    });
    renderApp('/settings/appearance');
    const section = await screen.findByRole('region', { name: 'Mi foto' });
    expect(await within(section).findByRole('button', { name: 'Subir foto' })).toBeInTheDocument();
    await userEvent.upload(within(section).getByLabelText('Elegir una foto'), file('yo.png', 'image/png', 321));
    await waitFor(() => expect(section.querySelector(`img[src="${LUIS}"]`)).not.toBeNull());
    expect(api.last('PUT /me/photo')?.body).toEqual({ raw_bytes: 321 });
    await userEvent.click(within(section).getByRole('button', { name: 'Quitar foto' }));
    await waitFor(() => expect(section.querySelector('img')).toBeNull());
    expect(within(section).getByRole('button', { name: 'Subir foto' })).toBeInTheDocument();
  });

  it('no sube un archivo que no es JPEG, PNG o WebP ni uno de más de 2 MB (lo dice sin llamar al servidor)', async () => {
    const api = mockApi({ ...authed(ME_ADMIN), 'GET /me/photo': () => ({ body: { photo_url: null } }) });
    renderApp('/settings/appearance');
    const section = await screen.findByRole('region', { name: 'Mi foto' });
    const input = within(section).getByLabelText('Elegir una foto');
    await userEvent.upload(input, file('a.gif', 'image/gif'), { applyAccept: false });
    expect(await within(section).findByText('La foto debe ser una imagen JPEG, PNG o WebP.')).toBeInTheDocument();
    await userEvent.upload(input, file('grande.png', 'image/png', 2 * 1024 * 1024 + 1));
    expect(await within(section).findByText('La foto pesa demasiado: el máximo es 2 MB.')).toBeInTheDocument();
    expect(api.count('PUT /me/photo')).toBe(0);
  });

  it('la barra lateral usa la foto de la persona en lugar de las siglas', async () => {
    mockApi({ ...authed(ME_ADMIN), 'GET /me/photo': () => ({ body: { photo_url: LUIS } }) });
    renderApp('/settings/appearance');
    await waitFor(() => expect(document.querySelector(`aside img[src="${LUIS}"]`)).not.toBeNull());
  });
});
