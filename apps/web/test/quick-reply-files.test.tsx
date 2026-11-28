import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, QuickReplyAsset, ResolvedQuickReply } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const NOW = new Date().toISOString();
const conv = (kind?: string): Conversation =>
  ({
    id: 'c1', status: 'working', unread_count: 0, last_message_at: NOW, last_inbound_at: NOW, assigned_at: NOW, closed_at: null, created_at: NOW,
    contact: { id: 'k1', name: 'Ana Torres', phone: '+593984217730' }, owner: { id: 'u2', name: 'Luis Navas' }, participants: [], my_access: 'owner', queue: null,
    channel: { id: 'ch1', name: 'Barbería WhatsApp', state: 'active', ...(kind ? { kind } : {}) }, tags: [], last_message: { direction: 'in', kind: 'text', preview: 'Hola', status: 'received', at: NOW },
    window: { open: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, can: { reply: true, note: true, accept: false, take: false, close: true, transfer: false, share: false }, sla: null,
  }) as unknown as Conversation;

const file = (id: string, kind: string, name: string | null = null): QuickReplyAsset => ({ id, kind, size_bytes: 245_000, name, usable_by_advisors: true, problem: null });
const QR = (over: Partial<ResolvedQuickReply> = {}): ResolvedQuickReply => ({ id: 'r1', shortcut: 'precios', body: 'Hola {{primer_nombre}}', text: 'Hola Ana', missing: [], shared: true, mine: false, can_edit: false, variables: ['primer_nombre'], updated_at: NOW, assets: [file('a1', 'image'), file('a2', 'document')], ...over });

function server(o: { kind?: string; reply?: ResolvedQuickReply; failOnce?: boolean } = {}) {
  let failed = false;
  const c = conv(o.kind);
  const handlers: Record<string, Handler> = {
    ...authed(ME_ADVISOR),
    'GET /conversations': () => ({ body: { items: [c], next_cursor: null, counts: { working: 1, pending: 0, closed: 0, unread: 0 } } }),
    'GET /conversations/options': () => ({ body: { queues: [], channels: [], owners: [], tags: [] } }),
    'GET /conversations/c1': () => ({ body: c }),
    'GET /conversations/c1/messages': () => ({ body: { items: [], next_cursor: null } }),
    'GET /conversations/c1/scheduled': () => ({ body: { items: [] } }),
    'GET /conversations/c1/quick-replies': () => ({ body: { items: [o.reply ?? QR()] } }),
    'POST /conversations/c1/messages': () => ({ status: 201, body: {} }),
    'POST /conversations/c1/quick-replies/r1/send': () => {
      if (o.failOnce && !failed) {
        failed = true;
        return { status: 409, body: { error: { code: 'QUICK_REPLY_ASSET_UNAVAILABLE', message: 'Un archivo (documento, 239 KB) ya no está disponible: quítalo y envía de nuevo', request_id: 'r', details: [{ path: 'asset_ids', code: 'unavailable', message: 'a2' }] } } };
      }
      return { status: 201, body: { messages: [] } };
    },
  };
  return mockApi(handlers);
}
const box = () => screen.findByRole('textbox', { name: 'Mensaje' });
const pick = async () => {
  await userEvent.type(await box(), '/pre');
  await userEvent.click(await screen.findByRole('option', { name: /precios/ }));
};
const send = () => userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

describe('Respuestas rápidas con archivos en el redactor (V25)', () => {
  it('al elegirla entra el texto y aparecen los archivos sin nombre; se quita uno y se envía todo junto con su llave', async () => {
    const api = server();
    renderApp('/inbox/c1');
    await userEvent.type(await box(), '/pre');
    expect(within(await screen.findByRole('option', { name: /precios/ })).getByText(/2 archivos/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /precios/ }));
    expect(await box()).toHaveValue('Hola Ana');
    const chips = within(screen.getByRole('list', { name: 'Archivos que se enviarán' }));
    expect(chips.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(chips.getByRole('button', { name: /Archivo adjunto: documento, .*Quitar/ }));
    await send();
    await waitFor(() => expect(api.count('POST /conversations/c1/quick-replies/r1/send')).toBe(1));
    const call = api.last('POST /conversations/c1/quick-replies/r1/send')!;
    expect(call.body).toEqual({ text: 'Hola Ana', asset_ids: ['a1'] });
    expect(call.headers['idempotency-key']).toBeTruthy();
    expect(api.count('POST /conversations/c1/messages')).toBe(0);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Archivos que se enviarán' })).toBeNull());
  });

  it('si un archivo ya no está disponible no se pierde nada: se marca, se quita y se envía; sin texto salen solo los archivos', async () => {
    const api = server({ failOnce: true });
    renderApp('/inbox/c1');
    await pick();
    await send();
    expect(await screen.findByText(/ya no está disponible: quítalo/)).toBeInTheDocument();
    expect(await box()).toHaveValue('Hola Ana');
    const chips = within(screen.getByRole('list', { name: 'Archivos que se enviarán' }));
    expect(chips.getByText('No disponible')).toBeInTheDocument();
    await userEvent.click(chips.getByRole('button', { name: /documento.*Quitar/ }));
    await userEvent.clear(await box());
    await send();
    await waitFor(() => expect(api.last('POST /conversations/c1/quick-replies/r1/send')?.body).toEqual({ text: '', asset_ids: ['a1'] }));
  });

  it('quitados todos los archivos, sale como un mensaje de texto de siempre', async () => {
    const api = server({ reply: QR({ assets: [file('a1', 'image')] }) });
    renderApp('/inbox/c1');
    await pick();
    await userEvent.click(screen.getByRole('button', { name: /imagen.*Quitar/ }));
    await send();
    await waitFor(() => expect(api.count('POST /conversations/c1/messages')).toBe(1));
    expect(api.count('POST /conversations/c1/quick-replies/r1/send')).toBe(0);
  });

  it('en GoHighLevel entra solo el texto y se explica', async () => {
    server({ kind: 'ghl' });
    renderApp('/inbox/c1');
    await pick();
    expect(await box()).toHaveValue('Hola Ana');
    expect(screen.getByText('GoHighLevel no admite archivos: solo se enviará el texto.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Archivos que se enviarán' })).toBeNull();
  });
});

describe('Configuración › Respuestas rápidas con archivos (V25)', () => {
  const asset = { id: 'a9', folder_id: null, name: 'catalogo.pdf', description: null, kind: 'document', mime_type: 'application/pdf', size_bytes: 1000, usable_by_advisors: false, usable_by_ai: false, scan_status: 'clean', state: 'ready', created_at: NOW };
  const admin = (attach: boolean) => mockApi({
    ...authed(ME_ADMIN),
    'GET /quick-replies': () => ({ body: { items: [QR({ can_edit: true })], access: { share: true, attach }, built_in_variables: [] } }),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /library': () => ({ body: { folders: [], items: [asset], next_cursor: null, usage: null, access: { manage: true }, storage_available: true } }),
    'POST /quick-replies': () => err(409, 'QUICK_REPLY_ASSET_NOT_SHARED', 'El archivo «catalogo.pdf» no está disponible para asesores. Márcalo como disponible para asesores en la Biblioteca'),
  });

  it('se eligen de la biblioteca, se avisa si no es para asesores y el rechazo del servidor se muestra; la tabla cuenta los archivos', async () => {
    const api = admin(true);
    renderApp('/settings/quick-replies');
    expect(await screen.findByText(/📎 2 archivos/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nueva respuesta' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva respuesta rápida' }));
    await userEvent.type(d.getByRole('textbox', { name: /Atajo/ }), 'cat');
    await userEvent.type(d.getByRole('textbox', { name: /Mensaje/ }), 'Mira');
    await userEvent.click(d.getByRole('checkbox', { name: /Compartir con toda la empresa/ }));
    await userEvent.click(d.getByRole('button', { name: 'Elegir de la biblioteca' }));
    const picker = within(await screen.findByRole('dialog', { name: 'Elegir un archivo para la respuesta' }));
    await userEvent.click(await picker.findByRole('button', { name: 'Elegir catalogo.pdf' }));
    await userEvent.click(picker.getByRole('button', { name: 'Usar este archivo' }));
    expect(d.getByText(/márcalo como disponible para asesores/i)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Crear respuesta' }));
    expect(await d.findByText(/no está disponible para asesores\. Márcalo/)).toBeInTheDocument();
    expect(api.last('POST /quick-replies')?.body).toEqual({ shortcut: 'cat', body: 'Mira', shared: true, asset_ids: ['a9'] });
  });

  it('sin permiso de biblioteca la sección de archivos no aparece', async () => {
    admin(false);
    renderApp('/settings/quick-replies');
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva respuesta' }));
    expect(screen.queryByRole('region', { name: /Archivos \(hasta 3\)/ })).toBeNull();
  });
});
